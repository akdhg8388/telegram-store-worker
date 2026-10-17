import {button,keyboard,backRow,adminIds,isAdmin,positiveInt,short,formatStars,formatIQD,moneyMethods,orderNames} from './common.js';
import {telegram,sendText,sendOrEditText,answerCallback,queueNotification,flushOutbox} from './telegram.js';
import {ensureUser,getUser,setSession,getSession,clearSession,getProduct,audit} from './database.js';
import * as ui from './ui.js';
import {handleAdminCallback,handleAdminText} from './admin-controls.js';
import {getSetting,storeAcceptsOrders} from './settings.js';
import {USD_PRESETS,formatQuote,usdRate,isTopupEnabled,receiverFor,quoteMinor,quoteFromUSD,parseCustomMinor,topupStatusMessage,baghdadDate} from './wallet.js';

async function notifyAdmins(db,env,text,photoFileId=null,markup=null) {
  for(const admin of adminIds(env)) {
    if(photoFileId) await queueNotification(db,'sendPhoto',{chat_id:admin,photo:photoFileId,caption:short(text,950),...(markup?{reply_markup:markup}:{})});
    else await queueNotification(db,'sendMessage',{chat_id:admin,text:short(text,3900),...(markup?{reply_markup:markup}:{})});
  }
}
async function notifyUser(db,uid,text,markup=null) {
  await queueNotification(db,'sendMessage',{chat_id:uid,text:short(text,3900),...(markup?{reply_markup:markup}:{})});
}
async function writeTopup(db,env,ctx,uid,session,sourceMessageId=null){
  if(!await isTopupEnabled(db,env))return sendText(env,uid,'⛔ تم إيقاف استقبال طلبات الشحن مؤقتاً.');
  const p=session.payload;
  if(!['zain_balance','superqi','binance'].includes(p.method) || !p.amountIqd || !p.currency || !p.requestedMinor || !/^[0-9a-f-]{36}$/i.test(p.nonce||'') ||
     (!p.reference && !p.proofFileId))return sendText(env,uid,'⚠️ الطلب غير مكتمل؛ أعد إنشاء طلب الشحن.');
  if(!await receiverFor(db,env,p.method))return sendText(env,uid,'⛔ أوقفت الإدارة وسيلة الشحن هذه. اختر وسيلة أخرى.');
  const source=Number.isSafeInteger(sourceMessageId)&&sourceMessageId>0?sourceMessageId:null;
  let result;
  try {
    result=await db.prepare(`INSERT INTO topup_requests
      (user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,requested_currency,requested_amount_minor,quoted_rate_iqd,source_message_id,submission_key)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM topup_requests WHERE user_tg_id=? AND status='pending') < 3`)
      .bind(uid,p.method,p.amountIqd,p.reference||null,p.proofFileId||null,p.proofUniqueId||null,p.currency,p.requestedMinor,p.rate,source,p.nonce,uid).run();
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
  const text=`🔔 طلب شحن محفظة جديد #${id}\n\n👤 الاسم: ${short(u?.first_name,100)}\n🔗 المعرف: ${u?.username?'@'+u.username:'غير متوفر'}\n🆔 Telegram ID: ${uid}\n💸 الوسيلة: ${moneyMethods[p.method]}\n💰 المطلوب: ${formatQuote(p)}\n🔢 رقم الحوالة: ${short(p.reference||'غير مرفق',180)}\n📷 الإثبات: ${p.proofFileId?'صورة مرفقة':'رقم تحويل فقط'}\n🗓️ وقت الطلب: ${baghdadDate(record.created_at)}\n\n⚠️ تحقق من وصول الحوالة فعلياً قبل الموافقة.`;
  await notifyAdmins(db,env,text,p.proofFileId||null,keyboard([button('✅ قبول الشحن',`topup_approve:${id}`,'success'),button('❌ رفض',`topup_reject:${id}`,'danger')]));
  ctx.waitUntil(flushOutbox(db,env));
  return sendText(env,uid,`🟡 تم إرسال طلب الشحن #${id} للمراجعة.\n\n💰 ${formatQuote(p)}\n💸 ${moneyMethods[p.method]}\n🗓️ ${baghdadDate(record.created_at)}\n\nتابع حالته من «طلباتي».`,keyboard([button('📦 طلباتي','orders','primary')],backRow()));
}
async function handleTextState(db,env,ctx,uid,message,session) {
  if(session.action.startsWith('topup_') && !await isTopupEnabled(db,env)){
    await clearSession(db,uid);
    return sendText(env,uid,'⛔ تم إيقاف استقبال طلبات الشحن من الإدارة.');
  }
  const t=String(message.text??'').trim();
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
  if(session.action==='topup_evidence'||session.action==='topup_confirm'){
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
    if(t.length<2 || t.length>1600) return sendText(env,uid,'أدخل رسالة بين حرفين و1600 حرف.');
    const u=await getUser(db,uid);
    await notifyAdmins(db,env,`🎧 رسالة دعم جديدة\nمن: ${short(u?.first_name,100)} (${uid})\n${u?.username?'@'+u.username:''}\n\n${t}\n\nللرد: /reply ${uid} نص الرد`);
    await clearSession(db,uid);
    ctx.waitUntil(flushOutbox(db,env));
    return sendText(env,uid,'✅ تم إرسال رسالتك للدعم، سنرد عليك هنا.',keyboard(backRow()));
  }
  if(session.action==='admin_product' && isAdmin(env,uid)) {
    const bits=t.split('|').map(s=>s.trim());
    if(bits.length!==6) return sendText(env,uid,'الصيغة: اسم المنتج | رقم القسم | السعر بالنجوم | المدة بالأشهر أو - | المخزون أو - | الوصف');
    const [title,cat,stars,duration,stock,description]=bits;
    const category=positiveInt(cat),price=positiveInt(stars);
    const months=duration==='-'?null:positiveInt(duration), quantity=stock==='-'?null:Number(stock);
    if(!title || title.length>150 || !category || !price || price>10000000 || (duration!=='-'&&!months) || (stock!=='-'&&(!Number.isSafeInteger(quantity)||quantity<0)) || description.length>1800) return sendText(env,uid,'بيانات غير صالحة. تحقق من السعر والمدة والمخزون وطول الاسم والوصف.');
    const catrow=await db.prepare('SELECT id FROM categories WHERE id=? AND active=1').bind(category).first();
    if(!catrow)return sendText(env,uid,'رقم القسم غير موجود. افتح الأقسام لمعرفة أرقامها.');
    const r=await db.prepare(`INSERT INTO products(category_id,title,price_stars,duration_months,stock,description) VALUES (?,?,?,?,?,?)`).bind(category,title,price,months,quantity,description).run();
    await audit(db,uid,'create','product',r.meta.last_row_id);
    await clearSession(db,uid);
    return sendText(env,uid,`✅ تمت إضافة المنتج #${r.meta.last_row_id}: ${title}`,keyboard([button('🛍️ عرض المنتج',`product:${r.meta.last_row_id}`)],backRow()));
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
  await ensureUser(db,message.from);
  if(!isAdmin(env,uid)){
    const user=await getUser(db,uid);
    if(user?.is_blocked)return sendText(env,uid,'⛔ تم إيقاف استخدام هذا الحساب. للمراجعة تواصل مع الدعم.');
  }
  const text=String(message.text??'').trim();
  if(text.startsWith('/start')){
    await clearSession(db,uid);
    const ref=text.match(/^\/start(?:@\w+)?\s+ref_(\d+)$/)?.[1];
    if(ref && ref!==String(uid)) {
      await db.prepare('INSERT OR IGNORE INTO referrals(user_tg_id,referrer_tg_id) SELECT ?,tg_id FROM users WHERE tg_id=?').bind(uid,ref).run();
    }
    return ui.home(db,env,uid);
  }
  if(text==='/cancel'){await clearSession(db,uid);return ui.home(db,env,uid)}
  if(text==='/admin')return adminMenu(db,env,uid);
  if(text==='/orders')return ui.orders(db,env,uid);
  if(text==='/wallet')return ui.wallet(db,env,uid);
  if(text==='/topup')return await isTopupEnabled(db,env)?ui.topupPresets(db,env,uid):ui.wallet(db,env,uid);
  if(text==='/currency')return ui.currencyMenu(db,env,uid);
  if(text==='/support'){
    await setSession(db,uid,'support');
    const instructions=await getSetting(db,'support_instructions','');
    return sendText(env,uid,`🎧 اكتب رسالتك الآن. للإلغاء استخدم /cancel.${instructions?'\n\n'+short(instructions,1000):''}`);
  }
  if(text==='/paysupport')return sendText(env,uid,'💳 للمساعدة بشأن مدفوعات Telegram Stars أرسل /support واكتب رقم الطلب ومشكلتك.');
  if(text==='/terms')return sendText(env,uid,await getSetting(db,'terms_text','📜 شروط مبدئية: لا يتم التسليم إلا بعد الدفع وموافقة المدير. تختلف الشروط حسب المنتج. للدعم: /support. حدّث الشروط قبل التشغيل العام.'));
  if(text==='/privacy')return sendText(env,uid,await getSetting(db,'privacy_text','🔐 سيتم تحديث سياسة الخصوصية قبل استقبال العملاء.'));
  if(text==='/id')return sendText(env,uid,`🆔 معرف حسابك الرقمي في تيليجرام هو: ${uid}`);
  if(text.startsWith('/reply ') && isAdmin(env,uid)){
    const match=text.match(/^\/reply\s+(\d+)\s+([\s\S]+)$/);
    if(!match)return sendText(env,uid,'صيغة الرد: /reply TELEGRAM_ID نص الرد');
    await notifyUser(db,match[1],`🎧 رد الدعم:\n\n${short(match[2],3200)}`);
    ctx.waitUntil(flushOutbox(db,env));
    return sendText(env,uid,'✅ تم وضع الرد في طابور الإرسال.');
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
    if(session.action.startsWith('owner_') && await handleAdminText(db,env,uid,session,message))return;
    if(message.photo?.length && (session.action==='topup_evidence'||session.action==='topup_confirm')) {
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
  return sendOrEditText(env,uid,`🛡️ لوحة تحكم المدير — خاصة بك

💳 طلبات الشحن المعلقة: ${topups?.n||0}
🛍️ طلبات الشراء المعلقة: ${orders?.n||0}

🔒 الصلاحية محصورة في Telegram ID المحدد في Cloudflare.`,keyboard(
    [button('🛍️ طلبات الشراء','admin_orders','primary'),button('💳 طلبات الشحن','admin_topups','success')],
    [button('📦 بانتظار التسليم','admin_delivery')],
    [button('📦 المنتجات والأسعار','admin_products:0'),button('📂 الأقسام','admin_manage_categories')],
    [button('➕ إضافة منتج','admin_addproduct'),button('➕ إضافة قسم','admin_addcategory')],
    [button('⚙️ الإعدادات والتعليمات','admin_settings:0','primary')],
    [button('📊 الإحصائيات','admin_stats'),button('🔎 البحث عن عميل','admin_find_user')],
    [button('📖 دليل الإدارة','admin_help')],backRow()),messageId);
}
async function adminList(db,env,uid,type){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ صلاحيات غير كافية.');
  if(type==='topups'){
    const rows=(await db.prepare("SELECT t.*,u.first_name,u.username FROM topup_requests t JOIN users u ON u.tg_id=t.user_tg_id WHERE t.status='pending' ORDER BY t.id LIMIT 10").all()).results??[];
    if(!rows.length)return sendText(env,uid,'✅ لا توجد طلبات شحن معلقة.',keyboard([button('🛡️ الإدارة','admin')],backRow()));
    for(const r of rows){
      await sendText(env,uid,`💳 طلب شحن #${r.id}\n👤 ${short(r.first_name,80)} (${r.user_tg_id})\n@${r.username||'بدون_معرف'}\n💰 ${formatIQD(r.amount_iqd)}\nالوسيلة: ${moneyMethods[r.method]}\n🗓️ وقت الطلب: ${baghdadDate(r.created_at)}\nرقم التحويل: ${short(r.transfer_reference||'غير متوفر',120)}\n⚠️ تحقّق من وصول التحويل بنفسك قبل الموافقة.`,keyboard(
        [button('✅ قبول',`topup_approve:${r.id}`,'success'),button('❌ رفض',`topup_reject:${r.id}`,'danger')],
        r.proof_file_id?[button('📷 عرض الإثبات',`topup_photo:${r.id}`)]:[]));
    }
    return;
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
async function approveTopup(db,env,uid,id,approve){
  if(!isAdmin(env,uid))return;
  if(!Number.isSafeInteger(id)||id<=0)return sendText(env,uid,'رقم طلب غير صحيح.');
  const newStatus=approve?'approved':'rejected';
  const operations=[db.prepare("UPDATE topup_requests SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(newStatus,uid,id)];
  if(approve)operations.push(db.prepare(`INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
    SELECT user_tg_id,amount_iqd,'topup','topup:' || id,'Admin-verified manual topup'
    FROM topup_requests WHERE id=? AND status='approved'`)
    .bind(id));
  const res=await db.batch(operations);
  if(!res[0].meta?.changes)return sendText(env,uid,'⚠️ الطلب غير موجود أو عولج سابقاً. لم يتغير أي رصيد.');
  await audit(db,uid,approve?'approve':'reject','topup',id);
  const row=await db.prepare('SELECT * FROM topup_requests WHERE id=?').bind(id).first();
  const user=await getUser(db,row.user_tg_id);
  const msg=approve
    ? `✅ تم شحن محفظتك بنجاح\n\n🧾 رقم الطلب: #${id}\n💰 المبلغ المضاف: ${formatQuote({currency:row.requested_currency,requestedMinor:row.requested_amount_minor,amountIqd:row.amount_iqd})}\n💳 الرصيد الحالي: ${formatIQD(user.wallet_balance_iqd)}\n💸 الوسيلة: ${moneyMethods[row.method]}\n🟢 الحالة: ناجحة\n🗓️ التاريخ والوقت: ${baghdadDate(row.decided_at)}\n\nشكراً لثقتك بمتجر My Store.`
    : `❌ تم رفض طلب شحن المحفظة #${id}.\n\n💰 المبلغ: ${formatIQD(row.amount_iqd)}\n🗓️ التاريخ: ${baghdadDate(row.decided_at)}\nلم يُضف أي مبلغ إلى الرصيد. للتفاصيل راسل /support.`;
  await notifyUser(db,row.user_tg_id,msg,keyboard([button('📦 طلباتي','orders','primary'),button('💳 المحفظة','wallet','success')]));
  return sendText(env,uid,`✅ ${approve?'قُبل':'رُفض'} طلب الشحن #${id}، وجرى تسجيل القرار وإشعار العميل.`);
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
  // Answer the callback in parallel with database work for a responsive interface.
  ctx.waitUntil(answerCallback(env,q.id).catch(e=>console.error('callback acknowledgement',String(e))));
  await ensureUser(db,q.from);
  if(!isAdmin(env,uid)){
    const user=await getUser(db,uid);
    if(user?.is_blocked)return;
  }
  const data=String(q.data||'');
  if(await handleAdminCallback(db,env,uid,data,q.message?.message_id))return;
  if(data==='home'){await clearSession(db,uid);return ui.home(db,env,uid,q.message?.message_id)}
  if(data==='categories')return ui.categories(db,env,uid,q.message?.message_id);
  if(data==='featured')return ui.products(db,env,uid,0,null,null,true,q.message?.message_id);
  if(data==='profile')return ui.profile(db,env,uid,q.message?.message_id);
  if(data==='wallet')return ui.wallet(db,env,uid,q.message?.message_id);
  if(data==='transactions')return ui.transactions(db,env,uid,q.message?.message_id);
  if(data==='orders')return ui.orders(db,env,uid,q.message?.message_id);
  if(data==='favorites')return ui.favorites(db,env,uid,q.message?.message_id);
  if(data==='products:0' || /^products:\d+$/.test(data))return ui.products(db,env,uid,Math.min(100,Number(data.split(':')[1])),null,null,false,q.message?.message_id);
  if(data==='search'){await setSession(db,uid,'search');return sendText(env,uid,'🔎 أدخل اسم المنتج الذي تبحث عنه. للإلغاء /cancel.');}
  if(data==='support'){
    await setSession(db,uid,'support');
    const instructions=await getSetting(db,'support_instructions','');
    return sendText(env,uid,`🎧 أرسل رسالتك الآن. للإلغاء /cancel.${instructions?'\n\n'+short(instructions,1000):''}`);
  }
  if(data==='news'){
    const url=await getSetting(db,'news_url',env.NEWS_URL||'');
    return url.startsWith('https://')?sendText(env,uid,`📢 قناة الأخبار: ${url}`,keyboard(backRow())):sendText(env,uid,'لم يضف المدير قناة أخبار بعد.',keyboard(backRow()));
  }
  if(data==='language')return sendText(env,uid,'🌐 اللغة الحالية: العربية\n\nسيتم دعم لغات إضافية بترجمة كاملة في تحديث لاحق.',keyboard([button('🇮🇶 العربية','language_ar')],backRow()));
  if(data==='language_ar')return sendText(env,uid,'✅ اللغة العربية مفعّلة.',keyboard(backRow()));
  if(data==='referrals'){
    const count=await db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first();
    const link=env.BOT_USERNAME?`https://t.me/${env.BOT_USERNAME.replace('@','')}?start=ref_${uid}`:'سيظهر الرابط عند ضبط BOT_USERNAME';
    return sendText(env,uid,`👥 برنامج الإحالات\n\nعدد الأصدقاء المدعوين: ${count?.n||0}\nرابطك: ${link}\n\nمكافآت الإحالة غير مفعّلة حالياً؛ لا توجد أرباح تلقائية من عمليات الشراء.`,keyboard(backRow()));
  }
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
    if(!await storeAcceptsOrders(db))return sendText(env,uid,'⏸️ المتجر لا يستقبل طلبات جديدة حالياً.');
    const id=positiveInt(data.split(':')[1]),p=id?await getProduct(db,id):null;
    if(!p || p.stock===0)return sendText(env,uid,'هذا المنتج غير متوفر حالياً.');
    const instr=await getSetting(db,'purchase_instructions','');
    return sendText(env,uid,`🛒 تأكيد الطلب

${short(p.title,100)}
المدة: ${p.duration_months||'حسب الخدمة'} شهر
الكمية: 1
السعر: ${formatStars(p.price_stars)}

سيُراجع المدير طلبك قبل السماح بالدفع والتسليم.${instr?'\n\n'+short(instr,1000):''}`,keyboard([button('✅ إرسال طلب للمدير',`confirm_buy:${p.id}`,'success')],[button('↩️ عودة للمنتج',`product:${p.id}`)]));
  }
  if(data.startsWith('confirm_buy:')){
    if(!await storeAcceptsOrders(db))return sendText(env,uid,'⏸️ تم إيقاف الطلبات الجديدة مؤقتاً.');
    const id=positiveInt(data.split(':')[1]),p=id?await getProduct(db,id):null;
    if(!p || p.stock===0)return sendText(env,uid,'هذا المنتج لم يعد متاحاً.');
    // A new callback_query.id is produced for every tap. Deduplicate by the
    // confirmation message itself as well so rapid double taps do not buy twice.
    const confirmationMessageId=Number.isSafeInteger(q.message?.message_id) ? q.message.message_id : null;
    const res=await db.prepare(`INSERT OR IGNORE INTO orders
      (user_tg_id,product_id,quantity,unit_price_stars,total_stars,source_callback_id,source_message_id)
      VALUES (?,?,?,?,?,?,?)`).bind(uid,p.id,1,p.price_stars,p.price_stars,q.id,confirmationMessageId).run();
    const previous=confirmationMessageId!==null
      ? await db.prepare('SELECT id FROM orders WHERE user_tg_id=? AND source_message_id=?').bind(uid,confirmationMessageId).first()
      : await db.prepare('SELECT id FROM orders WHERE source_callback_id=?').bind(q.id).first();
    const oid=res.meta?.changes ? res.meta.last_row_id : previous?.id;
    if(!res.meta?.changes) return sendText(env,uid,`تم تسجيل هذا الطلب مسبقاً برقم #${oid}.`);
    await notifyAdmins(db,env,`🛍️ طلب شراء جديد #${oid}
👤 العميل: ${uid}
🛍️ المنتج: ${short(p.title,160)}
💰 السعر: ${formatStars(p.price_stars)}
📦 الكمية: 1
⏳ ينتظر موافقة المدير.`,null,keyboard([button('✅ قبول',`order_approve:${oid}`,'success'),button('❌ رفض',`order_reject:${oid}`,'danger')]));
    ctx.waitUntil(flushOutbox(db,env));
    return sendText(env,uid,`✅ تم إنشاء طلبك #${oid}.\n\nبانتظار موافقة المدير. لن يُطلب منك الدفع قبل الموافقة.`,keyboard([button('📦 طلباتي','orders')],backRow()));
  }
  if(data.startsWith('pay:'))return invoice(db,env,uid,Number(data.split(':')[1]));
  if(data==='currency')return ui.currencyMenu(db,env,uid,q.message?.message_id);
  if(data.startsWith('currency_set:')){
    const currency=data.split(':')[1];
    if(!['IQD','USD'].includes(currency))return;
    await clearSession(db,uid);
    await db.prepare('UPDATE users SET currency_preference=?,updated_at=CURRENT_TIMESTAMP WHERE tg_id=?').bind(currency,uid).run();
    return ui.currencyMenu(db,env,uid,q.message?.message_id);
  }
  if(data==='topup'){
    if(!await isTopupEnabled(db,env))return sendText(env,uid,'⏳ طلبات شحن المحفظة لم تُفعّل بعد. يمكنك التواصل مع الدعم.',keyboard([button('💳 المحفظة','wallet','primary')],backRow()));
    return ui.topupPresets(db,env,uid,q.message?.message_id);
  }
  if(data.startsWith('topup_status:')){
    const id=positiveInt(data.split(':')[1]);
    if(!id)return;
    return ui.topupStatusView(db,env,uid,id,q.message?.message_id);
  }
  if(data==='topup_cancel'){
    await clearSession(db,uid);
    return ui.wallet(db,env,uid,q.message?.message_id);
  }
  if(/^(?:topup_preset:|topup_custom$|topup_method:|topup_submit:)/.test(data) && !await isTopupEnabled(db,env))
    return sendText(env,uid,'⛔ أوقفت الإدارة استقبال طلبات الشحن حالياً.');
  if(data.startsWith('topup_preset:')){
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
    const w=await ui.walletSummary(db,uid);
    await setSession(db,uid,'topup_custom',{currency:w.currency});
    return sendText(env,uid,`✏️ أدخل المبلغ المخصص بعملة ${w.currency}\n\n${w.currency==='USD'?'مثال: 25.50':'مثال: 25000'}\nللإلغاء: /cancel`);
  }
  if(data.startsWith('topup_method:')){
    const [,method,quoteKey]=data.split(':');
    const session=await getSession(db,uid);
    if(!session || session.action!=='topup_choose_method' || session.payload.quoteKey!==quoteKey)return sendText(env,uid,'انتهت هذه الخطوة. افتح شحن المحفظة وحدد المبلغ أولاً.');
    if(!['zain_balance','superqi','binance'].includes(method))return;
    if(!await receiverFor(db,env,method))return sendText(env,uid,'هذه الوسيلة غير مهيأة لدى الإدارة بعد.');
    const payload={...session.payload,method,reference:null,proofFileId:null,proofUniqueId:null};
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
  if(data==='admin_topups')return adminList(db,env,uid,'topups');
  if(data==='admin_orders')return adminList(db,env,uid,'orders');
  if(data==='admin_delivery')return adminList(db,env,uid,'delivery');
  if(data==='admin_categories'){
    if(!isAdmin(env,uid))return;
    const cats=(await db.prepare('SELECT * FROM categories ORDER BY id').all()).results??[];
    return sendText(env,uid,'📋 الأقسام:\n\n'+cats.map(c=>`#${c.id} ${c.emoji} ${c.title}`).join('\n'),keyboard([button('🛡️ الإدارة','admin')]));
  }
  if(data==='admin_addproduct'){
    if(!isAdmin(env,uid))return;
    await setSession(db,uid,'admin_product');
    return sendText(env,uid,'➕ لإضافة منتج، أرسل سطراً بالشكل:\n\nاسم المنتج | رقم القسم | السعر بالنجوم | المدة بالأشهر أو - | المخزون أو - | الوصف\n\nيمكن معرفة أرقام الأقسام من لوحة المدير. مثال:\nخدمة تجريبية | 1 | 20 | 1 | 5 | وصف الخدمة\n\nللإلغاء /cancel.');
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
  if(data.startsWith('topup_approve:')||data.startsWith('topup_reject:'))return approveTopup(db,env,uid,Number(data.split(':')[1]),data.startsWith('topup_approve:'));
  if(data.startsWith('order_approve:')||data.startsWith('order_reject:'))return decideOrder(db,env,uid,Number(data.split(':')[1]),data.startsWith('order_approve:'));
  if(data.startsWith('order_deliver:'))return deliverOrder(db,env,uid,Number(data.split(':')[1]));
  if(data.startsWith('order_refund:'))return refundOrder(db,env,uid,Number(data.split(':')[1]));
  return sendText(env,uid,'هذا الزر غير مدعوم أو انتهت صلاحيته. افتح القائمة مجدداً.',keyboard(backRow()));
}
async function handlePreCheckout(db,env,q){
  const id=Number(String(q.invoice_payload??'').match(/^order:(\d+)$/)?.[1]);
  const order=id?await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first():null;
  const valid=order && order.user_tg_id===q.from.id && order.status==='awaiting_payment' && q.currency==='XTR' && q.total_amount===order.total_stars;
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
  if(update.update_id!==undefined){
    const done=await db.prepare('SELECT 1 AS yes FROM processed_updates WHERE update_id=?').bind(update.update_id).first();
    if(done)return;
  }
  if(update.pre_checkout_query) await handlePreCheckout(db,env,update.pre_checkout_query);
  else if(update.message?.successful_payment) {
    await ensureUser(db,update.message.from);
    await handlePayment(db,env,ctx,update.message);
  } else if(update.message) await handleMessage(db,env,ctx,update.message);
  else if(update.callback_query)await handleCallback(db,env,ctx,update.callback_query);
  if(update.update_id!==undefined)await db.prepare('INSERT OR IGNORE INTO processed_updates(update_id) VALUES (?)').bind(update.update_id).run();
}
