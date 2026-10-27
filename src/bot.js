import {CUSTOMER_COMMANDS,OWNER_COMMANDS,CUSTOMER_COMMANDS_EN,OWNER_COMMANDS_EN} from './commands.js';
import {userLanguage,choice} from './i18n.js';
import {button,keyboard,backRow,adminIds,isAdmin,positiveInt,short,formatStars,formatIQD,moneyMethods,orderNames} from './common.js';
import {telegram,sendText,sendOrEditText,answerCallback,queueNotification,flushOutbox} from './telegram.js';
import {ensureUser,userProfileChanged,getUser,setSession,getSession,clearSession,getProduct,audit} from './database.js';
import * as ui from './ui.js';
import {referralPage,referralHistory,referralAdminCallback,referralAdminText} from './referral-rewards.js';
import {handleAdminCallback,handleAdminText} from './admin-controls.js';
import {getSetting,storeAcceptsOrders,maintenanceActive} from './settings.js';
import {USD_PRESETS,formatQuote,usdRate,isTopupEnabled,receiverFor,quoteMinor,quoteFromUSD,parseCustomMinor,topupStatusMessage,baghdadDate} from './wallet.js';
import {amountInIQD,topupDecisionText,guardUser} from './moderation.js';
import {submitSupport,handleSupportCallback,handleSupportReply,handleCustomerSupportCallback} from './support.js';
import {handleUserCallback,handleUserText} from './admin-users.js';
import {beginPurchase,commitPurchase,showReceipt,purchaseList} from './wallet-purchase.js';
import {readPurchaseViewIds,cleanupPurchaseViews,trackPurchaseView} from './purchase-views.js';
import {boldEntities} from './v25-format.js';
import {paymentMethod,paymentName} from './payment-methods.js';
import {paymentQuote,transferSummary} from './payment-quote.js';
import {trackTopupView,cleanTopupViews} from './topup-cleanup.js';
import {isTrc20Method,newTrc20Intent,findTrc20Intent,cancelTrc20Intent,trc20TxidIsValid,verifyTrc20Payment,creditVerifiedTrc20,formatUsdtMicro,notifyTrc20Alert} from './trc20-payments.js';
import {gateState,showGate,handleChannelAdmin,handleChannelAdminText} from './required-channels.js';
import {maintenanceStatus,maintenanceActionId,maintenanceCommandId,sendMaintenanceNotice,maintenanceAdminCallback,maintenanceAdminText} from './maintenance.js';

async function notifyAdmins(db,env,text,photoFileId=null,markup=null,metadata={}) {
  for(const admin of adminIds(env)) {
    if(photoFileId) await queueNotification(db,'sendPhoto',{chat_id:admin,photo:photoFileId,caption:short(text,950),...(markup?{reply_markup:markup}:{})},metadata);
    else await queueNotification(db,'sendMessage',{chat_id:admin,text:short(text,3900),...(markup?{reply_markup:markup}:{})},metadata);
  }
}
async function notifyUser(db,uid,text,markup=null,options={}) {
  await queueNotification(db,'sendMessage',{chat_id:uid,text:short(text,3900),...(markup?{reply_markup:markup}:{}),...(options.entities?{entities:options.entities}:{})});
}
// These are presentation-only messages; NEVER touch financial records on deletion.
async function trackTopupAdminMessage(db,adminId,topupId,messageId){
  if(!Number.isSafeInteger(messageId)||messageId<=0)return;
  await db.prepare('INSERT OR IGNORE INTO topup_admin_messages(admin_tg_id,topup_id,message_id) VALUES(?,?,?)')
    .bind(adminId,topupId,messageId).run();
}
async function safelyDeleteTopupMessage(env,chatId,messageId){
  if(!Number.isSafeInteger(messageId)||messageId<=0)return;
  try{await telegram(env,'deleteMessage',{chat_id:chatId,message_id:messageId});}
  catch(error){console.error('Topup chat cleanup skipped',String(error));}
}
async function cleanupSettledTopup(db,env,adminId,topupId,sourceMessageId,noticeMessageId){
  const records=(await db.prepare('SELECT message_id FROM topup_admin_messages WHERE admin_tg_id=? AND topup_id=?').bind(adminId,topupId).all()).results||[];
  const ids=[sourceMessageId,noticeMessageId,...records.map(x=>x.message_id)].filter(x=>Number.isSafeInteger(x)&&x>0);
  await Promise.all([...new Set(ids)].map(async mid=>{
    try{await telegram(env,'deleteMessage',{chat_id:adminId,message_id:mid});}
    catch{
      // Old or undeletable Telegram messages still must not offer usable decisions.
      try{await telegram(env,'editMessageReplyMarkup',{chat_id:adminId,message_id:mid,reply_markup:{inline_keyboard:[]}});}catch{}
    }
  }));
  await db.prepare('DELETE FROM topup_admin_messages WHERE admin_tg_id=? AND topup_id=?').bind(adminId,topupId).run();
}
async function writeTopup(db,env,ctx,uid,session,sourceMessageId=null){
  if(!await isTopupEnabled(db,env))return sendText(env,uid,'⛔ تم إيقاف استقبال طلبات الشحن مؤقتاً.');
  const p=session.payload;
  if(!await paymentMethod(db,env,p.method) || !p.amountIqd || !p.currency || !p.requestedMinor || !/^[0-9a-f-]{36}$/i.test(p.nonce||'') ||
     (!p.reference && !p.proofFileId))return sendText(env,uid,'⚠️ الطلب غير مكتمل؛ أعد إنشاء طلب الشحن.');
  if(!await receiverFor(db,env,p.method))return sendText(env,uid,'⛔ أوقفت الإدارة وسيلة الشحن هذه. اختر وسيلة أخرى.');
  const source=Number.isSafeInteger(sourceMessageId)&&sourceMessageId>0?sourceMessageId:null;
  let result;
  try {
    result=await db.prepare(`INSERT INTO topup_requests
      (user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,requested_currency,requested_amount_minor,quoted_rate_iqd,source_message_id,submission_key,custom_method_key,transfer_currency,transfer_base_minor,transfer_fee_minor,transfer_total_minor)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM topup_requests WHERE user_tg_id=? AND status='pending') < 3`)
      .bind(uid,['zain_balance','superqi','binance','asiacell','zaincash'].includes(p.method)?p.method:'asiacell',p.amountIqd,p.reference||null,p.proofFileId||null,p.proofUniqueId||null,p.currency,p.requestedMinor,p.rate,source,p.nonce,['zain_balance','superqi','binance','asiacell','zaincash'].includes(p.method)?null:p.method,p.transferCurrency||null,p.transferBaseMinor??null,p.transferFeeMinor??null,p.transferTotalMinor??null,uid).run();
  }catch(err){
    if(/UNIQUE|constraint/i.test(String(err))){
      {
        const previous=await db.prepare('SELECT id FROM topup_requests WHERE user_tg_id=? AND (source_message_id=? OR submission_key=?)').bind(uid,source,p.nonce).first();
        if(previous)return sendText(env,uid,`✅ تم تسجيل هذا الطلب سابقاً برقم #${previous.id}.`,keyboard([button('📦 طلباتي','orders','primary')],backRow()));
      }
      return sendText(env,uid,'❌ تم تسجيل رقم التحويل أو صورة الإثبات مسبقاً. لا يمكن استعمال الإثبات مرتين.');
    }
    throw err;
  }
  if(!result.meta?.changes)return sendText(env,uid,'⏳ لديك 3 طلبات شحن معلقة. يرجى انتظار قرار المدير قبل إنشاء طلب جديد.');
  const id=result.meta.last_row_id;
  await clearSession(db,uid);
  const u=await getUser(db,uid);
  const record=await db.prepare('SELECT * FROM topup_requests WHERE id=?').bind(id).first();
  const methodLabel=paymentName(await paymentMethod(db,env,p.method),'ar');
  const text=`🔔 طلب شحن محفظة جديد #${id}\n\n👤 الاسم: ${short(u?.first_name,100)}\n🔗 المعرف: ${u?.username?'@'+u.username:'غير متوفر'}\n🆔 Telegram ID: ${uid}\n💸 الوسيلة: ${methodLabel}\n💰 المطلوب: ${formatQuote(p)}${transferSummary(p)?'\n'+transferSummary(p):''}\n🔢 رقم الحوالة: ${short(p.reference||'غير مرفق',180)}\n📷 الإثبات: ${p.proofFileId?'صورة مرفقة':'رقم تحويل فقط'}\n🗓️ وقت الطلب: ${baghdadDate(record.created_at)}\n\n⚠️ تحقق من وصول الحوالة فعلياً قبل الموافقة.`;
  await notifyAdmins(db,env,text,p.proofFileId||null,keyboard([button('📋 فتح طلب الشحن',`topup_detail:${id}`,'primary')]),{topupRequestId:id});
  ctx.waitUntil(flushOutbox(db,env));
  const confirmation=await sendText(env,uid,`🟡 تم إرسال طلب الشحن #${id} للمراجعة.\n\n💰 ${formatQuote(p)}${transferSummary(p)?'\n'+transferSummary(p):''}\n💸 ${methodLabel}\n🗓️ ${baghdadDate(record.created_at)}\n\nتابع حالته من «طلباتي».`,keyboard([button('📦 طلباتي','orders','primary')],backRow()));
  if(source)ctx.waitUntil(safelyDeleteTopupMessage(env,uid,source));
  return confirmation;
}
async function handleTextState(db,env,ctx,uid,message,session) {
  if(session.action.startsWith('topup_') && !await isTopupEnabled(db,env)){
    await clearSession(db,uid);
    return sendText(env,uid,'⛔ تم إيقاف استقبال طلبات الشحن من الإدارة.');
  }
  const t=String(message.text??'').trim();
  if(session.action==='owner_topup_amount'){
    if(!isAdmin(env,uid)){await clearSession(db,uid);return sendText(env,uid,'⛔ غير مصرح.');}
    const id=Number(session.payload?.id);
    const topup=await db.prepare("SELECT * FROM topup_requests WHERE id=? AND status='pending'").bind(id).first();
    if(!topup){await clearSession(db,uid);return sendText(env,uid,'تمت معالجة الطلب أو لم يعد متاحاً.');}
    const amount=amountInIQD(t,topup.amount_iqd);
    if(!amount)return sendText(env,uid,`أدخل مبلغاً صحيحاً من 1 إلى ${formatIQD(topup.amount_iqd)}، دون فواصل عشرية. يمكن اعتماد مبلغ أقل مما طلبه العميل.`);
    await clearSession(db,uid);
    return showTopupApproval(db,env,uid,id,amount);
  }
  if(session.action==='topup_custom'){
    const current=session.payload.currency||'IQD';
    const rate=await usdRate(db);
    const minor=parseCustomMinor(t,current);
    const quote=quoteMinor(current,minor,rate);
    if(!quote)return sendText(env,uid,current==='USD'?'أدخل مبلغاً صحيحاً بين 1 و1,000 دولار، مثل 25 أو 25.50.':'أدخل مبلغاً صحيحاً بالدينار، بين 1,000 و10,000,000، دون فواصل عشرية.');
    const extended={...quote,quoteKey:crypto.randomUUID()};
    await setSession(db,uid,'topup_choose_method',extended);
    return ui.topupMethods(db,env,uid,extended);
  }
  if(session.action==='topup_trc20_txid'){
    await trackTopupView(db,uid,message.message_id);
    const intent=await findTrc20Intent(db,uid,session.payload?.intentId);
    if(!intent||intent.status!=='waiting'||Number(intent.expires_at)<=Math.floor(Date.now()/1000)){
      await clearSession(db,uid);return sendText(env,uid,'⏰ انتهى طلب التحويل. تواصل مع الدعم إذا حولت فعلاً.');
    }
    if(!trc20TxidIsValid(t))return sendText(env,uid,'❌ أرسل TXID الحقيقي (64 خانة) من سجل السحب في Binance.');
    const txid=t.toLowerCase();
    if(await db.prepare('SELECT id FROM trc20_payment_intents WHERE txid=?').bind(txid).first())
      return sendText(env,uid,'⚠️ هذه الحوالة مستخدمة سابقاً. لا يمكن شحن رصيد مرتين بنفس المعاملة.');
    let result;
    try{result=await verifyTrc20Payment(env,intent,txid)}
    catch(e){console.error('TRC20 verification failed',String(e));return sendText(env,uid,'⏳ تعذر التحقق من الشبكة حالياً. أعد إرسال TXID لاحقاً؛ لم نضف أي رصيد.');}
    if(result.status==='mismatch'||result.status==='late'){
      try{await notifyTrc20Alert(db,env,intent,txid,result.status==='late'?'حوالة متأخرة':'مبلغ تحويل غير مطابق')}
      catch(error){console.error('TRC20 alert failed',String(error))}
      ctx.waitUntil(flushOutbox(db,env));
    }
    if(result.status!=='confirmed')return sendText(env,uid,({
      pending:'🔍 لم نعثر على حوالة مؤكدة تطابق رقم TXID المرسل.\n⚠️ تأكد من صحة الرقم والشبكة TRC20 والمبلغ المطلوب.\n⏳ إذا حوّلت حديثاً، أعد المحاولة بعد دقائق.\n🔒 لم يُضف أي رصيد إلى محفظتك.',
      mismatch:'❌ الحوالة لا تطابق العنوان والمبلغ المطلوب. لن يضاف أي رصيد.',
      expired:'⏰ انتهت صلاحية طلب الدفع. تواصل مع الدعم إذا حولت بالفعل.',
      unconfigured:'⛔ خدمة التحقق غير مهيأة لدى الإدارة. لم يتم شحن الرصيد.',
      invalid:'❌ TXID غير صالح.'
    })[result.status]||'⚠️ لم نجد حوالة مؤكدة مطابقة لهذه العملية. تأكد من الشبكة ورقم المعاملة.');
    let settled;
    try{settled=await creditVerifiedTrc20(db,uid,intent.id,txid,env,result.blockTimestamp)}
    catch(e){console.error('TRC20 settlement rejected',String(e));return sendText(env,uid,'⚠️ لم نتمكن من تسوية الحوالة بأمان. لا تعاود التحويل؛ تواصل مع الدعم ومعك TXID.');}
    await clearSession(db,uid);
    ctx.waitUntil(flushOutbox(db,env));
    const account=await getUser(db,uid);
    return sendText(env,uid,'✅ تم التحقق من حوالتك وشحن محفظتك تلقائياً!\n💰 المضاف: '+formatIQD(settled.amount_iqd)+
      '\n💳 رصيدك: '+formatIQD(account.wallet_balance_iqd)+'\n🧾 رقم الطلب: #'+settled.id,
      keyboard([button('💳 محفظتي','wallet','success')],[button('📦 طلباتي','orders','primary')]));
  }
  if(session.action==='topup_evidence'||session.action==='topup_confirm'){
    await trackTopupView(db,uid,message.message_id);
    if(!t || t.length>180 || t==='/skip')return sendText(env,uid,'أرسل رقم حوالة صحيحاً لا يتجاوز 180 حرفاً، أو أرفق صورة إيصال.');
    if(t==='-')return sendText(env,uid,'إذا لم يكن لديك رقم حوالة، أرسل صورة إثبات التحويل بدلاً منه.');
    const payload={...session.payload,reference:t,nonce:session.payload.nonce||crypto.randomUUID()};
    await setSession(db,uid,'topup_confirm',payload);
    return ui.topupConfirm(db,env,uid,payload);
  }
  if(session.action==='search'){
    if(!t || t.length>80) return sendText(env,uid,'أدخل كلمة بحث بين 1 و80 حرفاً.');
    await clearSession(db,uid);
    return ui.products(db,env,uid,0,null,t);
  }
  if(session.action==='support') {
    return submitSupport(db,env,ctx,uid,message);
  }
  if(session.action==='admin_product' && isAdmin(env,uid)) {
    const bits=t.split('|').map(s=>s.trim());
    if(bits.length!==6) return sendText(env,uid,'الصيغة: اسم المنتج | رقم القسم | سعر المحفظة بالدينار | المدة بالأشهر أو - | المخزون أو - | الوصف');
    const [title,cat,iqd,duration,stock,description]=bits;
    const category=positiveInt(cat),price=positiveInt(iqd);
    const months=duration==='-'?null:positiveInt(duration), quantity=stock==='-'?null:Number(stock);
    if(!title || title.length>150 || !category || !price || price>100000000 || (duration!=='-'&&!months) || (stock!=='-'&&(!Number.isSafeInteger(quantity)||quantity<0)) || description.length>1800) return sendText(env,uid,'بيانات غير صالحة. تحقق من السعر والمدة والمخزون وطول الاسم والوصف.');
    const catrow=await db.prepare('SELECT id FROM categories WHERE id=? AND active=1').bind(category).first();
    if(!catrow)return sendText(env,uid,'رقم القسم غير موجود. افتح الأقسام لمعرفة أرقامها.');
    const r=await db.prepare('INSERT INTO products(category_id,title,price_stars,price_iqd,duration_months,stock,description) VALUES (?,?,1,?,?,?,?)').bind(category,title,price,months,quantity,description).run();
    await audit(db,uid,'create','product',r.meta.last_row_id);
    await clearSession(db,uid);
    return sendText(env,uid,`✅ تمت إضافة المنتج #${r.meta.last_row_id}: ${title}\n⚙️ افتح إدارته وأضف محتوى التسليم وطريقة الاستخدام حتى يصبح قابلاً للشراء تلقائياً.`,keyboard([button('⚙️ إعداد تسليم المنتج',`admin_product:${r.meta.last_row_id}`,'success')],backRow()));
  }
  if(session.action==='admin_category' && isAdmin(env,uid)){
    const [title,emoji='🛍️']=t.split('|').map(s=>s.trim());
    if(!title || title.length>70) return sendText(env,uid,'أرسل: اسم القسم | رمز تعبيري');
    const slug=`custom-${Date.now().toString(36)}-${uid}`;
    const r=await db.prepare('INSERT INTO categories(slug,title,emoji) VALUES (?,?,?)').bind(slug,title,short(emoji,8)||'🛍️').run();
    await audit(db,uid,'create','category',r.meta.last_row_id);
    await clearSession(db,uid);
    return sendText(env,uid,`✅ أُضيف القسم رقم ${r.meta.last_row_id}: ${title}`,keyboard(backRow()));
  }
  return null;
}
async function handleMessage(db,env,ctx,message){
  const uid=message.from?.id;
  if(!uid || !message.chat || message.chat.type!=='private') return;
  if(userProfileChanged(env.__knownUser,message.from))await ensureUser(db,message.from);
  const cmd=String(message.text||'').trim().split(/\s+/)[0];
  const [denied,maint]=await Promise.all([guardUser(db,env,uid,env.__knownUser),isAdmin(env,uid)?Promise.resolve({global:false,button:false}):maintenanceStatus(db,maintenanceCommandId(cmd))]);
  if(denied)return sendText(env,uid,denied);
  const text=String(message.text??'').trim();
  if(maint.global)return sendMaintenanceNotice(db,env,uid);
  if(maint.button)return sendMaintenanceNotice(db,env,uid,maintenanceCommandId(cmd));
  if(!isAdmin(env,uid)){
    const gate=await gateState(db,env,uid);
    if(!gate.allowed)return showGate(db,env,uid,gate);
  }
  if(text.startsWith('/start')){
    await clearSession(db,uid);
    const ref=text.match(/^\/start(?:@\w+)?\s+ref_(\d+)$/)?.[1];
    if(ref && ref!==String(uid)) {
      await db.prepare('INSERT OR IGNORE INTO referrals(user_tg_id,referrer_tg_id) SELECT ?,tg_id FROM users WHERE tg_id=? AND NOT EXISTS (SELECT 1 FROM wallet_purchases WHERE user_tg_id=?)').bind(uid,ref,uid).run();
    }
    return ui.home(db,env,uid);
  }
  // Telegram's hamburger menu sends slash commands, not ReplyKeyboard text.
  // Clear text-entry sessions before top-level navigation, to avoid stale forms.
  if(text==='/menu'){await clearSession(db,uid);return ui.home(db,env,uid)}
  if(text==='/shop'){await clearSession(db,uid);return ui.categories(db,env,uid)}
  if(text==='/profile'){await clearSession(db,uid);return ui.profile(db,env,uid)}
  if(text==='/history'||text==='/transactions'){await clearSession(db,uid);return ui.transactions(db,env,uid)}
  if(text==='/favorites'){await clearSession(db,uid);return ui.favorites(db,env,uid)}
  if(text==='/cancel'){
    const current=await getSession(db,uid);
    if(current?.payload?.intentId)await cancelTrc20Intent(db,uid,current.payload.intentId);
    await clearSession(db,uid);
    return ui.home(db,env,uid);
  }
  if(text==='/admin')return adminMenu(db,env,uid);
  if(text==='/orders'){await clearSession(db,uid);return ui.orders(db,env,uid)}
  if(text==='/purchases'){await clearSession(db,uid);return purchaseList(db,env,uid)}
  if(text==='/wallet'){await clearSession(db,uid);return ui.wallet(db,env,uid)}
  if(text==='/topup'){await clearSession(db,uid);return await isTopupEnabled(db,env)?ui.topupPresets(db,env,uid):ui.wallet(db,env,uid)}
  if(text==='/currency'){await clearSession(db,uid);return ui.currencyMenu(db,env,uid)}
  if(text==='/support'){await clearSession(db,uid);return ui.supportMenu(db,env,uid);}
  if(text==='/paysupport')return sendText(env,uid,'💳 للمساعدة بشأن شراء المحفظة، افتح /support واكتب رقم عملية الشراء.');
  if(text==='/terms')return sendText(env,uid,await getSetting(db,'terms_text','📜 شروط مبدئية: لا يتم التسليم إلا بعد الدفع وموافقة المدير. تختلف الشروط حسب المنتج. للدعم: /support. حدّث الشروط قبل التشغيل العام.'));
  if(text==='/privacy')return sendText(env,uid,await getSetting(db,'privacy_text','🔐 سيتم تحديث سياسة الخصوصية قبل استقبال العملاء.'));
  if(text==='/id')return sendText(env,uid,`🆔 معرف حسابك الرقمي في تيليجرام هو: ${uid}`);
  if(text.startsWith('/reply ') && isAdmin(env,uid)){
    const match=text.match(/^\/reply\s+(\d+)\s+([\s\S]+)$/);
    if(!match)return sendText(env,uid,'صيغة الرد: /reply TELEGRAM_ID نص الرد');
    return sendText(env,uid,'💬 للرد مع حفظ المحادثة، افتح قسم «رسائل الدعم الفني» من لوحة المدير ثم اختر المستخدم.');
  }
  if(text.startsWith('/setproduct ') && isAdmin(env,uid)){
    const match=text.match(/^\/setproduct\s+(\d+)\s+(price_stars|stock|featured|active)\s+(\d+)$/);
    if(!match)return sendText(env,uid,'الصيغة: /setproduct ID price_stars|stock|featured|active VALUE');
    const id=Number(match[1]),field=match[2],value=Number(match[3]);
    if(!Number.isSafeInteger(value) || value<0 || (field==='price_stars'&&value<1) || ((field==='featured'||field==='active')&&value>1))return sendText(env,uid,'قيمة غير صالحة.');
    const result=await db.prepare(`UPDATE products SET ${field}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(value,id).run();
    if(!result.meta?.changes)return sendText(env,uid,'هذا المنتج غير موجود.');
    await audit(db,uid,'update','product',id);
    return sendText(env,uid,'✅ تم تعديل المنتج.');
  }
  const session=await getSession(db,uid);
  if(session){
    if(session.action.startsWith('owner_') && await maintenanceAdminText(db,env,uid,session,message))return;
    if(session.action.startsWith('owner_') && await referralAdminText(db,env,uid,session,message))return;
    if(session.action.startsWith('owner_') && await handleChannelAdminText(db,env,uid,session,message))return;
    if(session.action.startsWith('owner_') && await handleUserText(db,env,uid,session,message))return;
    if(session.action.startsWith('owner_') && await handleAdminText(db,env,uid,session,message))return;
    if(session.action==='owner_support_reply' && await handleSupportReply(db,env,uid,session,message))return;
    if(message.photo?.length && (session.action==='topup_evidence'||session.action==='topup_confirm')) {
      await trackTopupView(db,uid,message.message_id);
      const pic=message.photo.at(-1);
      const payload={...session.payload,proofFileId:pic.file_id,proofUniqueId:pic.file_unique_id,nonce:session.payload.nonce||crypto.randomUUID()};
      await setSession(db,uid,'topup_confirm',payload);
      return ui.topupConfirm(db,env,uid,payload);
    }
    const result=await handleTextState(db,env,ctx,uid,message,session);
    if(result!==null)return result;
  }
  if(message.photo?.length)return sendText(env,uid,'للشحن، افتح 💳 محفظتي أولاً.');
  return sendText(env,uid,'اختر أحد الأقسام من القائمة الرئيسية أو اكتب /start.',keyboard([button('🏠 الرئيسية','home')]));
}
async function adminMenu(db,env,uid,messageId=null){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ هذا القسم خاص بمدير المتجر.');
  const [topups,orders]=await Promise.all([
    db.prepare("SELECT count(*) n FROM topup_requests WHERE status='pending'").first(),
    db.prepare("SELECT count(*) n FROM orders WHERE status='awaiting_admin'").first()
  ]);
  const topupsActive=await isTopupEnabled(db,env);
  return sendOrEditText(env,uid,`🛡️ لوحة تحكم المدير — خاصة بك

✅ تم التحقق من حساب المدير. لديك صلاحية إدارة هذا المتجر.

💳 طلبات الشحن المعلقة: ${topups?.n||0}
🛍️ طلبات الشراء المعلقة: ${orders?.n||0}
🔌 طلبات الشحن: ${topupsActive?'🟢 مفعّلة':'🔴 غير مفعّلة — افتح إعداد الشحن لتفعيلها.'}`,keyboard(
    [button('🛍️ طلبات الشراء','admin_orders','primary'),button('💳 طلبات الشحن','admin_topups','success')],
    [button('⚙️ إعداد شحن المحفظة','admin_topup_setup','primary')],
    [button('📨 رسائل الدعم الفني','support_inbox','primary'),button('🚫 إدارة المستخدمين','admin_users','primary')],
    [button('👤 التواصل المباشر مع المسؤول','admin_support_contact','primary')],
    [button('🎨 تخصيص واجهة المتجر','admin_visuals','primary')],
    [button('🛠️ وضع الصيانة','admin_maintenance','danger')],
    [button('📢 الاشتراك الإجباري','required_manage','primary')],
    [button('🎁 مكافآت الإحالات','refadmin','primary')],
    [button('✅ مشتريات المستخدمين الناجحة','admin_wallet_sales','success')],
    [button('📦 بانتظار التسليم','admin_delivery')],
    [button('📦 المنتجات والأسعار','admin_products:0'),button('📂 الأقسام','admin_manage_categories')],
    [button('➕ إضافة منتج','admin_addproduct'),button('➕ إضافة قسم','admin_addcategory')],
    [button('⚙️ الإعدادات والتعليمات','admin_settings:0','primary')],
    [button('📊 الإحصائيات','admin_stats'),button('🔎 البحث عن عميل','admin_find_user')],
    [button('📖 دليل الإدارة','admin_help')],backRow()),messageId);
}
async function adminWalletSales(db,env,uid,page=0,messageId=null){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ غير مصرح.');
  const limit=10;
  const entries=(await db.prepare(`SELECT w.id,w.product_name,w.price_iqd,w.created_at,
        w.user_tg_id,u.first_name,u.username
      FROM wallet_purchases w JOIN users u ON u.tg_id=w.user_tg_id
      ORDER BY w.id DESC LIMIT ? OFFSET ?`).bind(limit+1,Math.max(0,page)*limit).all()).results??[];
  const rows=entries.slice(0,limit).map(x=>[button(`✅ #${x.id} • ${short(x.first_name||x.username||x.user_tg_id,15)} • ${formatIQD(x.price_iqd)}`,`admin_wallet_sale:${x.id}`,'success')]);
  const pagination=[];
  if(page>0)pagination.push(button('⬅️ السابق',`admin_wallet_sales:${page-1}`));
  if(entries.length>limit)pagination.push(button('التالي ➡️',`admin_wallet_sales:${page+1}`));
  if(pagination.length)rows.push(pagination);
  rows.push([button('🔄 تحديث المشتريات','admin_wallet_sales','primary')],[button('🛡️ لوحة المدير','admin','primary')]);
  return sendOrEditText(env,uid,`✅ مشتريات المستخدمين الناجحة

هنا تظهر عمليات المحفظة التي اكتمل خصمها وتسليمها فقط. اختر عملية لعرض الاسم والمعرّف والتاريخ والخدمة والسعر.`,keyboard(...rows),messageId);
}
async function adminWalletSale(db,env,uid,id,messageId=null){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ غير مصرح.');
  if(!Number.isSafeInteger(id)||id<=0)return;
  const sale=await db.prepare(`SELECT w.*,u.first_name,u.username FROM wallet_purchases w
    JOIN users u ON u.tg_id=w.user_tg_id WHERE w.id=?`).bind(id).first();
  if(!sale)return sendOrEditText(env,uid,'هذه العملية غير موجودة.',keyboard([button('↩️ قائمة المشتريات','admin_wallet_sales')]),messageId);
  const name=short(sale.first_name||'بدون اسم',100);
  const username=sale.username?'@'+sale.username:'غير متوفر';
  const text=`✅ عملية شراء مكتملة #${sale.id}

👤 الاسم: ${name}
🔗 اسم المستخدم: ${username}
🆔 Telegram ID: ${sale.user_tg_id}
📦 الخدمة: ${short(sale.product_name,150)}
🛍️ رقم المنتج: #${sale.product_id}
💰 السعر المدفوع: ${formatIQD(sale.price_iqd)}
📅 التاريخ والوقت: ${baghdadDate(sale.created_at)} (بغداد)
📊 الحالة: ✅ مدفوعة ومسلّمة
🔑 نوع التسليم: ${sale.delivery_item_id?'كود فريد (مستخدم)':'محتوى ثابت'}
📝 تفاصيل المنتج: ${short(sale.product_description||'—',500)}
📖 طريقة الاستخدام: ${short(sale.usage_instructions||'—',450)}
📦 بيانات التسليم: ${short(sale.delivery_payload||'—',650)}`;
  return sendOrEditText(env,uid,text,keyboard([button('⬅️ كل المشتريات الناجحة','admin_wallet_sales','primary')],[button('🛡️ لوحة المدير','admin','primary')]),messageId);
}
async function adminList(db,env,uid,type,messageId=null){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ صلاحيات غير كافية.');
  if(type==='topups'){
    const items=(await db.prepare("SELECT t.id,t.user_tg_id,t.amount_iqd,t.created_at,u.first_name,u.username FROM topup_requests t JOIN users u ON u.tg_id=t.user_tg_id WHERE t.status='pending' ORDER BY t.id DESC LIMIT 20").all()).results??[];
    const buttons=items.map(t=>[button(`👤 ${short(t.first_name||t.username||String(t.user_tg_id),22)} • #${t.id} • ${formatIQD(t.amount_iqd)}`,`topup_detail:${t.id}`,'primary')]);
    buttons.push([button('🔄 تحديث الطلبات','admin_topups','primary')],[button('📁 الطلبات المعالجة','admin_topups_done','primary')],[button('🛡️ لوحة المدير','admin','primary')],backRow());
    return sendOrEditText(env,uid,`💳 معالجة طلبات الشحن\n\n${items.length?'اختر اسم العميل أو رقم الطلب لمراجعة التفاصيل وإثبات التحويل.':'✅ لا توجد طلبات شحن معلّقة حالياً.'}`,keyboard(...buttons),messageId);
  }
  const status=type==='delivery'?'paid_pending_delivery':'awaiting_admin';
  const rows=(await db.prepare('SELECT o.*,p.title,u.first_name,u.username FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.tg_id=o.user_tg_id WHERE o.status=? ORDER BY o.id LIMIT 10').bind(status).all()).results??[];
  if(!rows.length)return sendText(env,uid,'✅ لا توجد طلبات في هذا القسم.',keyboard([button('🛡️ الإدارة','admin')],backRow()));
  for(const r of rows){
    await sendText(env,uid,`📦 طلب #${r.id}\n👤 ${short(r.first_name,80)} (${r.user_tg_id})\n🛍️ ${short(r.title,200)}\n📊 الكمية: ${r.quantity}\n💰 ${formatStars(r.total_stars)}\n${orderNames[r.status]}`,keyboard(
      status==='awaiting_admin'?[button('✅ موافقة',`order_approve:${r.id}`,'success'),button('❌ رفض',`order_reject:${r.id}`,'danger')]:[button('📦 تأكيد التسليم',`order_deliver:${r.id}`,'success'),button('↩️ استرداد النجوم',`order_refund:${r.id}`,'danger')]
    ));
  }
}
async function invoice(db,env,uid,orderId){
  const o=await db.prepare('SELECT o.*,p.title,p.description FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.user_tg_id=?').bind(orderId,uid).first();
  if(!o || o.status!=='awaiting_payment')return sendText(env,uid,'هذا الطلب غير قابل للدفع حالياً.');
  return telegram(env,'sendInvoice',{
    chat_id:uid,title:short(o.title,32),description:short(o.description||`طلب شراء #${o.id}`,255),
    payload:`order:${o.id}`,provider_token:'',currency:'XTR',
    prices:[{label:short(o.title,32),amount:o.total_stars}]
  });
}
async function topupDetail(db,env,uid,id,messageId=null){
  if(!isAdmin(env,uid))return;
  const t=await db.prepare('SELECT t.*,u.first_name,u.username FROM topup_requests t JOIN users u ON u.tg_id=t.user_tg_id WHERE t.id=?').bind(id).first();
  if(!t)return sendText(env,uid,'الطلب غير موجود.');
  const detailName=paymentName(await paymentMethod(db,env,t.custom_method_key||t.method),'ar');
  const summary=`📋 طلب شحن #${id}\n\n👤 الاسم: ${short(t.first_name,80)}\n🔗 المعرف: ${t.username?'@'+t.username:'غير متوفر'}\n🆔 Telegram ID: ${t.user_tg_id}\n💰 المبلغ المطلوب: ${formatIQD(t.amount_iqd)}\n💸 الوسيلة: ${detailName}\n🔢 رقم الحوالة: ${short(t.transfer_reference||'غير مرفق',150)}\n📸 الإثبات: ${t.proof_file_id?'صورة مرفقة':'رقم حوالة'}\n🗓️ تاريخ الطلب: ${baghdadDate(t.created_at)}\n📌 الحالة: ${t.status==='pending'?'قيد المراجعة':t.status==='approved'?'✅ مكتمل':'❌ مرفوض'}${t.decided_at?'\n🗓️ تاريخ القرار: '+baghdadDate(t.decided_at):''}${t.credited_amount_iqd!==null?'\n✅ المبلغ المعتمد: '+formatIQD(t.credited_amount_iqd):''}`;
  const rows=[];
  if(t.proof_file_id)rows.push([button('📷 عرض صورة الإثبات',`topup_photo:${id}`,'primary')]);
  if(t.status==='pending')rows.push([button('✅ مراجعة القبول',`topup_approve:${id}`,'success'),button('❌ رفض',`topup_reject:${id}`,'danger')]);
  rows.push([button('↩️ الطلبات المعلّقة','admin_topups','primary')]);
  const sent=await sendOrEditText(env,uid,summary,keyboard(...rows),messageId);
  await trackTopupAdminMessage(db,uid,id,sent?.message_id||messageId);
  return sent;
}
async function showTopupApproval(db,env,uid,id,amount,messageId=null){
  if(!isAdmin(env,uid))return;
  const row=await db.prepare("SELECT * FROM topup_requests WHERE id=? AND status='pending'").bind(id).first();
  if(!row)return sendText(env,uid,'تمت معالجة الطلب مسبقاً.');
  if(!amountInIQD(String(amount),row.amount_iqd))return sendText(env,uid,'المبلغ غير صالح.');
  const sent=await sendOrEditText(env,uid,topupDecisionText(row,amount),keyboard(
    [button('✅ اعتماد الشحن نهائياً',`topup_commit:${id}:${amount}`,'success')],
    [button('✏️ تعديل المبلغ',`topup_amount:${id}`,'primary')],
    [button('↩️ مراجعة الطلب',`topup_detail:${id}`,'danger')]),messageId);
  await trackTopupAdminMessage(db,uid,id,sent?.message_id||messageId);
  return sent;
}
async function settleTopup(db,env,ctx,uid,id,amount=null,messageId=null){
  if(!isAdmin(env,uid))return;
  const row=await db.prepare("SELECT * FROM topup_requests WHERE id=? AND status='pending'").bind(id).first();
  if(!row)return sendText(env,uid,'⚠️ تمت معالجة الطلب سابقاً. لم تتم إضافة أي رصيد جديد.');
  if(amount!==null && !amountInIQD(String(amount),row.amount_iqd))return sendText(env,uid,'مبلغ غير صالح.');
  const approved=amount!==null;
  // D1 batch is atomic. Conditional transition and unique source_key prevent double credit.
  const actions=[db.prepare(`UPDATE topup_requests SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP,credited_amount_iqd=?
    WHERE id=? AND status='pending'`).bind(approved?'approved':'rejected',uid,amount,id)];
  if(approved)actions.push(db.prepare(`INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
    SELECT user_tg_id,credited_amount_iqd,'topup','topup:' || id,'Admin-verified actual receipt'
    FROM topup_requests WHERE id=? AND status='approved' AND credited_amount_iqd>0`).bind(id));
  const results=await db.batch(actions);
  if(!results[0].meta?.changes)return sendText(env,uid,'⚠️ الطلب حُسم بالفعل، لم يتغير الرصيد.');
  await audit(db,uid,approved?'approve':'reject','topup',id);
  const current=await db.prepare('SELECT * FROM topup_requests WHERE id=?').bind(id).first();
  const customer=await getUser(db,current.user_tg_id);
  const settledName=paymentName(await paymentMethod(db,env,current.custom_method_key||current.method),'ar');
  const notice=approved?`✅ تم شحن محفظتك بنجاح!\n\n🧾 رقم الطلب: #${id}\n💰 المبلغ المطلوب: ${formatIQD(current.amount_iqd)}\n✅ المبلغ المضاف فعلياً: ${formatIQD(amount)}\n💳 رصيد المحفظة: ${formatIQD(customer.wallet_balance_iqd)}\n💸 الوسيلة: ${settledName}\n🗓️ وقت الطلب: ${baghdadDate(current.created_at)}\n🕒 وقت الاعتماد: ${baghdadDate(current.decided_at)}\n🟢 الحالة: مكتملة\n\nشكراً لاستخدامك My Store.`
    :`❌ تم رفض طلب شحن المحفظة #${id}.\n\n💰 المبلغ المطلوب: ${formatIQD(current.amount_iqd)}\n🗓️ وقت الطلب: ${baghdadDate(current.created_at)}\n🕒 وقت القرار: ${baghdadDate(current.decided_at)}\nلم تتم إضافة أي مبلغ. للمساعدة افتح قسم الدعم.`;
  await notifyUser(db,current.user_tg_id,notice,keyboard([button('📦 طلباتي','orders','primary'),button('💳 محفظتي','wallet','success')]),approved?{entities:boldEntities(notice)}:{});
  // Financial commit and customer notification are already durable. Cleanup is
  // best-effort and scheduled separately to keep approval latency low.
  ctx.waitUntil(cleanupSettledTopup(db,env,uid,id,messageId,current.admin_notice_message_id)
    .catch(e=>console.error('Topup admin cleanup',String(e))));
  return sendOrEditText(env,uid,`${approved?'✅ اعتُمد شحن':'❌ رُفض'} الطلب #${id}\n💰 المطلوب: ${formatIQD(current.amount_iqd)}${approved?'\n✅ المضاف: '+formatIQD(amount):''}\n🗓️ وقت القرار: ${baghdadDate(current.decided_at)}\nتم حفظ القرار وإشعار العميل.`,keyboard([button('📁 الطلبات المعالجة','admin_topups_done','primary')],[button('↩️ طلبات الشحن','admin_topups','primary')]),null);
}
async function completedTopups(db,env,uid,messageId=null){
  const rows=(await db.prepare("SELECT t.id,t.status,t.amount_iqd,t.credited_amount_iqd,u.first_name FROM topup_requests t JOIN users u ON u.tg_id=t.user_tg_id WHERE t.status!='pending' ORDER BY t.id DESC LIMIT 25").all()).results??[];
  return sendOrEditText(env,uid,`📁 سجل طلبات الشحن المعالجة\n\n${rows.length?'اختر الطلب لمراجعة تفاصيله وتاريخه.':'لا توجد طلبات معالجة.'}`,keyboard(...rows.map(r=>[button(`${r.status==='approved'?'✅':'❌'} #${r.id} ${short(r.first_name,20)} • ${formatIQD(r.credited_amount_iqd??r.amount_iqd)}`,`topup_detail:${r.id}`,'primary')]),[button('↩️ طلبات معلقة','admin_topups','primary')]),messageId);
}
async function decideOrder(db,env,uid,id,approve){
  if(!isAdmin(env,uid))return;
  let res;
  try{res=await db.prepare(`UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_admin'`).bind(approve?'awaiting_payment':'rejected',id).run();}
  catch(e){if(/stock|unavailable/i.test(String(e)))return sendText(env,uid,'❌ تعذر الموافقة: المنتج غير متوفر أو المخزون غير كافٍ.');throw e;}
  if(!res.meta?.changes)return sendText(env,uid,'⚠️ الطلب عولج سابقاً أو لم يعد معلقاً.');
  await audit(db,uid,approve?'approve':'reject','order',id);
  const o=await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  const paymentInfo=approve?await getSetting(db,'payment_instructions',''):'';
  await notifyUser(db,o.user_tg_id,approve?`✅ وافق المدير على طلبك #${id}.
أصبح بإمكانك الدفع باستخدام Telegram Stars من خلال زر «طلباتي».${paymentInfo?'\n\n'+short(paymentInfo,1000):''}`:`❌ رفض المدير طلبك #${id}. لم تُفرض عليك أي رسوم.`);
  return sendText(env,uid,`✅ ${approve?'تم قبول':'تم رفض'} الطلب #${id}.`);
}
async function deliverOrder(db,env,uid,id){
  if(!isAdmin(env,uid))return;
  const res=await db.prepare("UPDATE orders SET status='delivered',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid_pending_delivery'").bind(id).run();
  if(!res.meta?.changes)return sendText(env,uid,'⚠️ الطلب غير موجود أو لم يُدفع أو تم تسليمه بالفعل.');
  await audit(db,uid,'deliver','order',id);
  const o=await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  const product=await db.prepare('SELECT delivery_instructions FROM products WHERE id=?').bind(o.product_id).first();
  const general=await getSetting(db,'delivery_instructions','');
  const details=[general,product?.delivery_instructions].filter(Boolean).map(x=>short(x,1400)).join('\n\n');
  await notifyUser(db,o.user_tg_id,`✅ تم تحديد طلبك #${id} كمكتمل من المدير.${details?'\n\n📦 تعليمات التسليم:\n'+details:''}\n\nإذا لم تستلم الخدمة، راسل /support.`);
  return sendText(env,uid,`✅ تم إتمام الطلب #${id}.`);
}
async function refundOrder(db,env,uid,id){
  if(!isAdmin(env,uid))return;
  const o=await db.prepare("SELECT * FROM orders WHERE id=? AND status='paid_pending_delivery' AND payment_charge_id IS NOT NULL").bind(id).first();
  if(!o)return sendText(env,uid,'⚠️ الاسترداد متاح فقط لطلب مدفوع ولم يُسلّم بعد.');
  // Telegram must confirm a refund before we change the order or release stock.
  await telegram(env,'refundStarPayment',{user_id:o.user_tg_id,telegram_payment_charge_id:o.payment_charge_id});
  const res=await db.batch([
    db.prepare("UPDATE payment_records SET state='refunded' WHERE telegram_payment_charge_id=? AND state='paid'").bind(o.payment_charge_id),
    db.prepare("UPDATE orders SET status='refunded',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid_pending_delivery'").bind(id)
  ]);
  if(res[1].meta?.changes){
    await audit(db,uid,'refund','order',id);
    await notifyUser(db,o.user_tg_id,`↩️ تم استرداد Telegram Stars للطلب #${id}.`);
  }
  return sendText(env,uid,`✅ تمت معالجة استرداد الطلب #${id}.`);
}
async function handleCallback(db,env,ctx,q){
  const uid=q.from?.id;
  if(!uid || (q.message && q.message.chat?.type!=='private'))return;
  if(userProfileChanged(env.__knownUser,q.from))await ensureUser(db,q.from);
  const data=String(q.data||'');
  const [denied,maint]=await Promise.all([guardUser(db,env,uid),isAdmin(env,uid)?Promise.resolve({global:false,button:false}):maintenanceStatus(db,maintenanceActionId(data))]);
  if(denied)return sendText(env,uid,denied);
  // Seven-day-old navigation messages are stale. Open a fresh home rather
  // than executing obsolete buttons; never delete purchases or history.
  const sourceDate=Number(q.message?.date||0);
  if(!isAdmin(env,uid)&&sourceDate>0&&Date.now()/1000-sourceDate>7*86400){
    await clearSession(db,uid);
    return ui.home(db,env,uid);
  }
  if(maint.global)return sendMaintenanceNotice(db,env,uid);
  if(data==='required_verify'){
    const gate=await gateState(db,env,uid);
    if(!gate.allowed)return showGate(db,env,uid,gate,q.message?.message_id);
    await clearSession(db,uid);
    return ui.home(db,env,uid,q.message?.message_id);
  }
  if(!isAdmin(env,uid)){
    const gate=await gateState(db,env,uid);
    if(!gate.allowed)return showGate(db,env,uid,gate,q.message?.message_id);
  }
  if(maint.button)return sendMaintenanceNotice(db,env,uid,maintenanceActionId(data));
  if(await maintenanceAdminCallback(db,env,uid,data,q.message?.message_id))return;
  if(await referralAdminCallback(db,env,uid,data,q.message?.message_id))return;
  if(await handleChannelAdmin(db,env,uid,data,q.message?.message_id))return;
  if(await handleCustomerSupportCallback(db,env,uid,data,q.message?.message_id))return;
  if(await handleSupportCallback(db,env,uid,data,q.message?.message_id))return;
  if(await handleUserCallback(db,env,uid,data,q.message?.message_id))return;
  if(await handleAdminCallback(db,env,uid,data,q.message?.message_id))return;
  if(data==='home'){
    // Home edits the selected message. Only erase tracked transient purchase messages,
    // never general menus, old chat history or saved financial/customer records.
    const stale=readPurchaseViewIds(db,uid).catch(e=>{console.error('Purchase-view lookup failed',String(e));return [];});
    await clearSession(db,uid);
    const homeResult=await ui.home(db,env,uid,q.message?.message_id);
    const editedId=!env.__callback_media && q.message?.message_id ? q.message.message_id : null;
    ctx.waitUntil(stale.then(ids=>cleanupPurchaseViews(db,env,uid,ids,editedId))
      .catch(e=>console.error('Purchase-view cleanup failed',String(e))));
    return homeResult;
  }
  if(data==='categories')return ui.categories(db,env,uid,q.message?.message_id);
  if(data==='featured')return ui.products(db,env,uid,0,null,null,true,q.message?.message_id);
  if(data==='profile')return ui.profile(db,env,uid,q.message?.message_id);
  if(data==='wallet')return ui.wallet(db,env,uid,q.message?.message_id);
  if(data==='transactions')return ui.transactions(db,env,uid,q.message?.message_id);
  if(data==='orders')return ui.orders(db,env,uid,q.message?.message_id);
  if(data==='favorites')return ui.favorites(db,env,uid,q.message?.message_id);
  if(data==='products:0' || /^products:\d+$/.test(data))return ui.products(db,env,uid,Math.min(100,Number(data.split(':')[1])),null,null,false,q.message?.message_id);
  if(data==='search'){await setSession(db,uid,'search');return sendText(env,uid,'🔎 أدخل اسم المنتج الذي تبحث عنه. للإلغاء /cancel.');}
  if(data==='support'){await clearSession(db,uid);return ui.supportMenu(db,env,uid,q.message?.message_id);}
  if(data==='support_compose'){
    await setSession(db,uid,'support');
    const instructions=await getSetting(db,'support_instructions','');
    return sendText(env,uid,`🎧 أرسل رسالتك الآن. للإلغاء /cancel.${instructions?'\n\n'+short(instructions,1000):''}`);
  }
  if(data==='news'){
    const url=await getSetting(db,'news_url',env.NEWS_URL||'');
    return url.startsWith('https://')?sendText(env,uid,`📢 قناة الأخبار: ${url}`,keyboard(backRow())):sendText(env,uid,'لم يضف المدير قناة أخبار بعد.',keyboard(backRow()));
  }
  if(data==='referrals')return referralPage(db,env,uid,q.message?.message_id);
  if(data==='referral_history')return referralHistory(db,env,uid,q.message?.message_id);
  if(data.startsWith('category:')){
    const m=data.match(/^category:(\d+):(\d+)$/);
    if(m)return ui.products(db,env,uid,Math.min(Number(m[2]),100),Number(m[1]),null,false,q.message?.message_id);
  }
  if(data.startsWith('product:'))return ui.productView(db,env,uid,Number(data.split(':')[1]),q.message?.message_id);
  if(data.startsWith('favorite:')){
    const productId=positiveInt(data.split(':')[1]);if(!productId)return;
    const p=await getProduct(db,productId);if(!p)return;
    const existing=await db.prepare('SELECT 1 AS ok FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,productId).first();
    if(existing)await db.prepare('DELETE FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,productId).run();
    else await db.prepare('INSERT OR IGNORE INTO favorites(user_tg_id,product_id) VALUES (?,?)').bind(uid,productId).run();
    return ui.productView(db,env,uid,productId,q.message?.message_id);
  }
  if(data.startsWith('buy:')){
    if(!await storeAcceptsOrders(db))return sendText(env,uid,'⏸️ المتجر لا يستقبل مشتريات جديدة حالياً.');
    const id=positiveInt(data.split(':')[1]);
    const p=id?await getProduct(db,id):null;
    return beginPurchase(db,env,uid,p);
  }
  if(data.startsWith('wallet_confirm:')){
    if(!await storeAcceptsOrders(db))return sendText(env,uid,'⏸️ المتجر أوقف استقبال الشراء مؤقتاً.');
    const nonce=data.slice('wallet_confirm:'.length);
    const result=await commitPurchase(db,env,uid,nonce);
    if(!result)return sendText(env,uid,'انتهت صلاحية هذا التأكيد. افتح المنتج مجدداً.');
    if(result.failed)return sendText(env,uid,'⛔ '+result.failed,keyboard([button('💳 شحن المحفظة','topup','success'),button('🛍️ المتجر','categories')],backRow()));
    return showReceipt(db,env,uid,result.id);
  }
  if(data==='wallet_purchases')return purchaseList(db,env,uid,q.message?.message_id);
  if(data.startsWith('wallet_receipt:')){
    const id=positiveInt(data.split(':')[1]);
    if(id)return showReceipt(db,env,uid,id);
  }
  // Legacy Stars orders remain auditable but no new invoice may be initiated.
  if(data.startsWith('pay:') || data.startsWith('confirm_buy:'))return sendText(env,uid,'هذا الزر يعود لنظام شراء قديم. افتح المتجر لاستخدام نظام المحفظة الجديد.');

  if(data==='currency')return ui.currencyMenu(db,env,uid,q.message?.message_id);
  if(data.startsWith('currency_set:')){
    const currency=data.split(':')[1];
    if(!['IQD','USD'].includes(currency))return;
    await clearSession(db,uid);
    await db.prepare('UPDATE users SET currency_preference=?,updated_at=CURRENT_TIMESTAMP WHERE tg_id=?').bind(currency,uid).run();
    return ui.currencyMenu(db,env,uid,q.message?.message_id);
  }
  if(data==='topup'){
    await trackTopupView(db,uid,q.message?.message_id);
    if(!await isTopupEnabled(db,env))return sendText(env,uid,'⏳ طلبات شحن المحفظة لم تُفعّل بعد. يمكنك التواصل مع الدعم.',keyboard([button('💳 المحفظة','wallet','primary')],backRow()));
    return ui.topupPresets(db,env,uid,q.message?.message_id);
  }
  if(data.startsWith('topup_status:')){
    const id=positiveInt(data.split(':')[1]);
    if(!id)return;
    return ui.topupStatusView(db,env,uid,id,q.message?.message_id);
  }
  if(data.startsWith('topup_amount_info:')){
    const session=await getSession(db,uid);
    const id=data.slice('topup_amount_info:'.length);
    if(session?.action==='topup_trc20_txid'&&session.payload.intentId===id){
      const intent=await findTrc20Intent(db,uid,id);
      return answerCallback(env,q.id,intent?'حوّل المبلغ الدقيق '+formatUsdtMicro(intent.expected_micro):'انتهى الطلب');
    }
    const ok=session?.action==='topup_evidence'&&session.payload?.quoteKey===id;
    return answerCallback(env,q.id,ok?transferSummary(session.payload):'انتهت هذه الخطوة. ابدأ طلباً جديداً.');
  }
  if(data==='topup_cancel'){
    await trackTopupView(db,uid,q.message?.message_id);
    const pending=await getSession(db,uid);
    if(pending?.payload?.intentId)await cancelTrc20Intent(db,uid,pending.payload.intentId);
    await clearSession(db,uid);
    // Send a fresh clean wallet message, then remove only tracked top-up screens.
    const result=await ui.wallet(db,env,uid);
    await cleanTopupViews(db,env,uid);
    return result;
  }
  if(/^(?:topup_preset:|topup_custom$|topup_method:|topup_submit:)/.test(data) && !await isTopupEnabled(db,env))
    return sendText(env,uid,'⛔ أوقفت الإدارة استقبال طلبات الشحن حالياً.');
  if(data.startsWith('topup_preset:')){
    await trackTopupView(db,uid,q.message?.message_id);
    const [,rawUsd,displayedCurrency]=data.split(':');
    const usd=positiveInt(rawUsd);
    if(!USD_PRESETS.includes(usd)||!['IQD','USD'].includes(displayedCurrency))return;
    const w=await ui.walletSummary(db,uid);
    if(w.currency!==displayedCurrency)return sendText(env,uid,'تغيرت العملة منذ عرض هذه الأزرار؛ افتح قائمة الشحن مجدداً.');
    const quote=quoteFromUSD(usd,w.rate,w.currency);
    if(!quote)return sendText(env,uid,'لا يمكن تحديد المبلغ قبل ضبط سعر الصرف.');
    const extended={...quote,quoteKey:crypto.randomUUID()};
    await setSession(db,uid,'topup_choose_method',extended);
    return ui.topupMethods(db,env,uid,extended,q.message?.message_id);
  }
  if(data==='topup_custom'){
    await trackTopupView(db,uid,q.message?.message_id);
    const w=await ui.walletSummary(db,uid);
    await setSession(db,uid,'topup_custom',{currency:w.currency});
    return sendText(env,uid,`✏️ أدخل المبلغ المخصص بعملة ${w.currency}\n\n${w.currency==='USD'?'مثال: 25.50':'مثال: 25000'}\nللإلغاء: /cancel`);
  }
  if(data.startsWith('topup_trc20_paid:')){
    const id=data.slice('topup_trc20_paid:'.length);
    const intent=await findTrc20Intent(db,uid,id);
    if(!intent||intent.status!=='waiting'||intent.expires_at<=Math.floor(Date.now()/1000))
      return sendText(env,uid,'⏰ انتهى طلب الدفع. تواصل مع الدعم إذا حولت فعلاً.');
    await setSession(db,uid,'topup_trc20_txid',{intentId:id});
    return sendText(env,uid,'✅ إذا حولت '+formatUsdtMicro(intent.expected_micro)+
      ' على شبكة TRC20 إلى العنوان المحدد، أرسل الآن رقم المعاملة TXID من سجل السحب في Binance.\n\n🔒 لن يُضاف أي رصيد إلا بعد مطابقة الحوالة المؤكدة.\nللإلغاء /cancel.',
      keyboard([button('❌ إلغاء الطلب','topup_cancel','danger')]));
  }
  if(data.startsWith('topup_method:')){
    await trackTopupView(db,uid,q.message?.message_id);
    const [,method,quoteKey]=data.split(':');
    const session=await getSession(db,uid);
    if(!session || session.action!=='topup_choose_method' || session.payload.quoteKey!==quoteKey)return sendText(env,uid,'انتهت هذه الخطوة. افتح شحن المحفظة وحدد المبلغ أولاً.');
    const selected=await paymentMethod(db,env,method);
    if(!selected?.enabled||!selected.visible)return sendText(env,uid,'هذه الوسيلة غير متاحة حالياً.');
    if(!await receiverFor(db,env,method))return sendText(env,uid,'هذه الوسيلة غير مهيأة لدى الإدارة بعد.');
    if(isTrc20Method(method)){
      if(!env.TRONGRID_API_KEY)return sendText(env,uid,'⛔ التحقق من TRC20 غير متاح حالياً. اختر وسيلة أخرى.');
      let intent;
      try{intent=await newTrc20Intent(db,uid,session.payload,selected,env)}
      catch(e){console.error('TRC20 intent not created',String(e));return sendText(env,uid,'⛔ تعذر تجهيز طلب TRC20. تأكد من العنوان والرسوم، أو استخدم وسيلة أخرى.');}
      await setSession(db,uid,'topup_trc20_txid',{intentId:intent.intentId});
      return ui.topupTrc20(db,env,uid,intent,session.payload,q.message?.message_id);
    }
    const transfer=paymentQuote(selected,session.payload);
    if(selected.quote_enabled!==0&&!transfer)return sendText(env,uid,'⚠️ إعداد احتساب مبلغ التحويل غير صالح؛ تواصل مع الإدارة.');
    const payload={...session.payload,method,reference:null,proofFileId:null,proofUniqueId:null,
       ...(transfer?{transferCurrency:transfer.currency,transferBaseMinor:transfer.baseMinor,transferFeeMinor:transfer.feeMinor,transferTotalMinor:transfer.totalMinor}:{})};
    await setSession(db,uid,'topup_evidence',payload);
    return ui.topupEvidence(db,env,uid,payload,method,q.message?.message_id);
  }
  if(data.startsWith('topup_submit:')){
    const nonce=data.slice('topup_submit:'.length);
    if(!/^[0-9a-f-]{36}$/i.test(nonce))return;
    const session=await getSession(db,uid);
    if(!session || session.action!=='topup_confirm' || session.payload.nonce!==nonce){
      const previous=await db.prepare('SELECT id FROM topup_requests WHERE user_tg_id=? AND submission_key=?').bind(uid,nonce).first();
      return sendText(env,uid,previous?`✅ سُجل طلبك بالفعل برقم #${previous.id}.`:'هذه رسالة تأكيد قديمة. افتح المحفظة وابدأ طلباً جديداً.');
    }
    return writeTopup(db,env,ctx,uid,session,q.message?.message_id);
  }
  if(data==='admin')return adminMenu(db,env,uid,q.message?.message_id);
  if(data==='admin_topups')return adminList(db,env,uid,'topups',q.message?.message_id);
  if(data==='admin_topups_done')return completedTopups(db,env,uid,q.message?.message_id);
  if(data.startsWith('topup_detail:'))return topupDetail(db,env,uid,Number(data.split(':')[1]));
  if(data.startsWith('topup_amount:')){
    if(!isAdmin(env,uid))return;
    const id=Number(data.split(':')[1]);
    const row=await db.prepare("SELECT * FROM topup_requests WHERE id=? AND status='pending'").bind(id).first();
    if(!row)return sendText(env,uid,'الطلب غير متاح.');
    await setSession(db,uid,'owner_topup_amount',{id});
    return sendText(env,uid,`✏️ أدخل المبلغ الذي وصل فعلياً بالدينار العراقي للطلب #${id}.\nالمبلغ المطلوب: ${formatIQD(row.amount_iqd)}\nيمكنك اعتماد مبلغ أقل؛ مثال: 100000\nللإلغاء /cancel.`);
  }
  if(data.startsWith('topup_commit:')){const [,rawId,rawAmt]=data.split(':');return settleTopup(db,env,ctx,uid,Number(rawId),Number(rawAmt),q.message?.message_id)}
  if(data.startsWith('topup_reject:'))return settleTopup(db,env,ctx,uid,Number(data.split(':')[1]),null,q.message?.message_id);
  if(data.startsWith('topup_approve:')){const id=Number(data.split(':')[1]);const row=await db.prepare("SELECT * FROM topup_requests WHERE id=? AND status='pending'").bind(id).first();return row?showTopupApproval(db,env,uid,id,row.amount_iqd):sendText(env,uid,'الطلب تمت معالجته.')} 
  if(data==='admin_wallet_sales' || /^admin_wallet_sales:\d+$/.test(data))
    return adminWalletSales(db,env,uid,Math.min(100,Number(data.split(':')[1]||0)),q.message?.message_id);
  if(/^admin_wallet_sale:\d+$/.test(data))
    return adminWalletSale(db,env,uid,Number(data.split(':')[1]),q.message?.message_id);
  if(data==='admin_orders')return adminList(db,env,uid,'orders',q.message?.message_id);
  if(data==='admin_delivery')return adminList(db,env,uid,'delivery',q.message?.message_id);
  if(data==='admin_categories'){
    if(!isAdmin(env,uid))return;
    const cats=(await db.prepare('SELECT * FROM categories ORDER BY id').all()).results??[];
    return sendText(env,uid,'📋 الأقسام:\n\n'+cats.map(c=>`#${c.id} ${c.emoji} ${c.title}`).join('\n'),keyboard([button('🛡️ الإدارة','admin')]));
  }
  if(data==='admin_addproduct'){
    if(!isAdmin(env,uid))return;
    await setSession(db,uid,'admin_product');
    return sendText(env,uid,'➕ لإضافة منتج، أرسل سطراً بالشكل:\n\nاسم المنتج | رقم القسم | سعر المحفظة بالدينار | المدة بالأشهر أو - | المخزون أو - | الوصف\n\nيمكن معرفة أرقام الأقسام من لوحة المدير. مثال:\nخدمة تجريبية | 1 | 12000 | 1 | 5 | وصف الخدمة\n\nللإلغاء /cancel.');
  }
  if(data==='admin_addcategory'){
    if(!isAdmin(env,uid))return;
    await setSession(db,uid,'admin_category');return sendText(env,uid,'➕ أرسل اسم القسم والرمز التعبيري:\n\nاستضافة السيرفرات | 🌐');
  }
  if(data.startsWith('topup_photo:')){
    if(!isAdmin(env,uid))return;
    const r=await db.prepare('SELECT proof_file_id FROM topup_requests WHERE id=?').bind(Number(data.split(':')[1])).first();
    if(!r?.proof_file_id)return sendText(env,uid,'لا توجد صورة لهذا الطلب.');
    return telegram(env,'sendPhoto',{chat_id:uid,photo:r.proof_file_id});
  }

  if(data.startsWith('order_approve:')||data.startsWith('order_reject:'))return decideOrder(db,env,uid,Number(data.split(':')[1]),data.startsWith('order_approve:'));
  if(data.startsWith('order_deliver:'))return deliverOrder(db,env,uid,Number(data.split(':')[1]));
  if(data.startsWith('order_refund:'))return refundOrder(db,env,uid,Number(data.split(':')[1]));
  return sendText(env,uid,'هذا الزر غير مدعوم أو انتهت صلاحيته. افتح القائمة مجدداً.',keyboard(backRow()));
}
async function handlePreCheckout(db,env,q){
  const id=Number(String(q.invoice_payload??'').match(/^order:(\d+)$/)?.[1]);
  const order=id?await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first():null;
  const denied=await guardUser(db,env,q.from.id);
  const valid=!denied && order && order.user_tg_id===q.from.id && order.status==='awaiting_payment' && q.currency==='XTR' && q.total_amount===order.total_stars;
  await telegram(env,'answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok:Boolean(valid),...(!valid?{error_message:'الطلب غير صالح أو لم يعد متاحاً. تواصل مع الدعم.'}:{})});
}
async function handlePayment(db,env,ctx,message){
  const p=message.successful_payment, uid=message.from?.id;
  const id=Number(String(p.invoice_payload??'').match(/^order:(\d+)$/)?.[1]);
  const o=id?await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first():null;
  if(!o || o.user_tg_id!==uid || p.currency!=='XTR' || p.total_amount!==o.total_stars) {
    await notifyAdmins(db,env,`🚨 دفعة غير متوقعة من المستخدم ${uid}. معرف المعاملة: ${short(p.telegram_payment_charge_id,160)}. تحقق يدوياً من الدفع والاسترداد.`);
    ctx.waitUntil(flushOutbox(db,env));
    return sendText(env,uid,'⚠️ استُلم إشعار دفع غير مطابق. يرجى التواصل مع الدعم للمراجعة.');
  }
  const out=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO payment_records(telegram_payment_charge_id,order_id,user_tg_id,amount_stars)
      VALUES (?,?,?,?)`).bind(p.telegram_payment_charge_id,id,uid,p.total_amount),
    db.prepare(`UPDATE orders SET status='paid_pending_delivery',payment_charge_id=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='awaiting_payment' AND EXISTS (SELECT 1 FROM payment_records WHERE order_id=? AND telegram_payment_charge_id=?)`)
      .bind(p.telegram_payment_charge_id,id,id,p.telegram_payment_charge_id)
  ]);
  if(!out[1].meta?.changes) return sendText(env,uid,'✅ تم تسجيل إشعار الدفع مسبقاً. يمكنك متابعة طلبك من قائمة طلباتي.');
  await notifyAdmins(db,env,`💎 تم دفع الطلب #${id} بنجاح عبر Telegram Stars.\nالعميل: ${uid}\nالمبلغ: ${formatStars(o.total_stars)}\n🛠️ يرجى تجهيز الخدمة ثم تأكيد التسليم من /admin`);
  ctx.waitUntil(flushOutbox(db,env));
  return sendText(env,uid,`✅ تم الدفع بنجاح للطلب #${id}.\n\n${formatStars(o.total_stars)}\nطلبك الآن قيد التجهيز، وسيصلك إشعار عند التسليم.`,keyboard([button('📦 طلباتي','orders')],backRow()));
}
export async function processUpdate(db,env,ctx,update){
  // Acknowledge callbacks immediately, independent of D1 latency.
  if(update.callback_query?.id&&!String(update.callback_query.data||'').startsWith('topup_amount_info:')){
    ctx.waitUntil(answerCallback(env,update.callback_query.id).catch(e=>console.error('callback acknowledgement',String(e))));
  }
  const incomingId=update.callback_query?.from?.id||update.message?.from?.id||update.pre_checkout_query?.from?.id;
  // Two independent read-only lookups in parallel. Preserve idempotency
  // checks before all user-facing business actions.
  const [done,knownUser]=await Promise.all([
    update.update_id===undefined?Promise.resolve(null):db.prepare('SELECT 1 AS yes FROM processed_updates WHERE update_id=?').bind(update.update_id).first(),
    incomingId?getUser(db,incomingId):Promise.resolve(null)
  ]);
  if(done)return;
  const locale='ar';
  // Media-message callbacks cannot be edited using editMessageText. Carry the
  // source type only for this update to avoid a failing Telegram API round trip.
  const source=update.callback_query?.message;
  env={...env,__knownUser:knownUser,__locale:locale,__trackTransient:(id,message)=>ctx.waitUntil(trackPurchaseView(db,id,message)),
    __trackTopup:(id,message)=>trackTopupView(db,id,message),
    __callback_message_id:source?.message_id??null,
    __callback_media:!!(source?.photo?.length||source?.video||source?.animation||source?.document)};
  if(update.pre_checkout_query) await telegram(env,'answerPreCheckoutQuery',{pre_checkout_query_id:update.pre_checkout_query.id,ok:false,error_message:'تم إيقاف نظام النجوم للطلبات الجديدة. تواصل مع الدعم بشأن الطلبات السابقة.'});
  else if(update.message?.successful_payment) {
    await ensureUser(db,update.message.from);
    await handlePayment(db,env,ctx,update.message);
  } else if(update.message) await handleMessage(db,env,ctx,update.message);
  else if(update.callback_query)await handleCallback(db,env,ctx,update.callback_query);
  if(update.update_id!==undefined)await db.prepare('INSERT OR IGNORE INTO processed_updates(update_id) VALUES (?)').bind(update.update_id).run();
}
