import {button,keyboard,backRow,adminIds,isAdmin,positiveInt,short,formatStars,formatIQD,moneyMethods,orderNames} from './common.js';
import {telegram,sendText,answerCallback,queueNotification,flushOutbox} from './telegram.js';
import {ensureUser,getUser,setSession,getSession,clearSession,getProduct,audit} from './database.js';
import * as ui from './ui.js';

async function notifyAdmins(db,env,text,photoFileId=null) {
  for(const admin of adminIds(env)) {
    if(photoFileId) await queueNotification(db,'sendPhoto',{chat_id:admin,photo:photoFileId,caption:short(text,950)});
    else await queueNotification(db,'sendMessage',{chat_id:admin,text:short(text,3900)});
  }
}
async function notifyUser(db,uid,text) {
  await queueNotification(db,'sendMessage',{chat_id:uid,text:short(text,3900)});
}
async function writeTopup(db,env,ctx,uid,session,photoFileId=null,photoUniqueId=null) {
  const {method,amount,reference=null} = session.payload;
  if(!reference && !photoFileId) return sendText(env,uid,'أرسل رقم التحويل أو صورة إثبات الشحن. لا يمكن إرسال طلب فارغ.');
  let result;
  try {
    result=await db.prepare(`INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id)
      VALUES (?,?,?,?,?,?)`).bind(uid,method,amount,reference||null,photoFileId,photoUniqueId).run();
  } catch(err) {
    if(/UNIQUE|constraint/i.test(String(err))) return sendText(env,uid,'❌ هذا الرقم أو الإثبات مستخدم في طلب سابق. تأكد من بياناتك أو تواصل مع الدعم.');
    throw err;
  }
  const id=result.meta?.last_row_id;
  await clearSession(db,uid);
  const u=await getUser(db,uid);
  const text=`🔔 طلب شحن جديد #${id}\n\n👤 ${short(u?.first_name,100)}\n🔗 ${u?.username?'@'+u.username:'بلا معرف'}\n🆔 ${uid}\n💳 ${moneyMethods[method]}\n💰 ${formatIQD(amount)}\n🔢 رقم التحويل: ${short(reference||'غير متوفر',150)}\n📎 إثبات: ${photoFileId?'صورة مرفقة':'رقم تحويل فقط'}\n⏳ الحالة: بانتظار التحقق من التحويل الفعلي.\n\nلإدارة الطلب: /admin`;
  await notifyAdmins(db,env,text,photoFileId);
  ctx.waitUntil(flushOutbox(db,env));
  return sendText(env,uid,`✅ تم تسجيل طلب الشحن رقم #${id}.\n\n${formatIQD(amount)} — ${moneyMethods[method]}\nسيُراجع المدير وصول التحويل ثم يتخذ القرار.`,keyboard(backRow()));
}
async function handleTextState(db,env,ctx,uid,message,session) {
  const t=String(message.text??'').trim();
  if(session.action==='topup_custom'){
    const amount=positiveInt(t.replace(/[\s,]/g,''));
    if(!amount || amount<1000 || amount>10000000) return sendText(env,uid,'أدخل مبلغ شحن صحيحاً بالدينار العراقي بين 1,000 و10,000,000.');
    await setSession(db,uid,'topup_reference',{method:session.payload.method,amount});
    return sendText(env,uid,`💰 المبلغ: ${formatIQD(amount)}\n\nأرسل رقم العملية أو بيانات التحويل. إذا لم يوجد رقم، أرسل الرمز - ثم أرفق صورة الإثبات.`);
  }
  if(session.action==='topup_reference') {
    if(!t || t.length>180) return sendText(env,uid,'أرسل رقم تحويل صالحاً لا يتجاوز 180 حرفاً، أو الرمز - إذا لا يوجد رقم.');
    const reference=t==='-'?null:t;
    await setSession(db,uid,'topup_proof',{...session.payload,reference});
    return sendText(env,uid,reference?'📷 أرسل صورة الإيصال الآن، أو اكتب /skip إذا كان رقم التحويل كافياً.':'📷 أرسل صورة إثبات الشحن، فهي مطلوبة عند عدم توفر رقم تحويل.');
  }
  if(session.action==='topup_proof') {
    if(t==='/skip') return writeTopup(db,env,ctx,uid,session);
    return sendText(env,uid,'أرسل صورة الإثبات، أو استخدم /skip إذا أرسلت رقم التحويل سابقاً.');
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
  if(text==='/support'){await setSession(db,uid,'support');return sendText(env,uid,'🎧 اكتب رسالتك الآن. للإلغاء استخدم /cancel.');}
  if(text==='/paysupport')return sendText(env,uid,'💳 للمساعدة بشأن مدفوعات Telegram Stars أرسل /support واكتب رقم الطلب ومشكلتك.');
  if(text==='/terms')return sendText(env,uid,'📜 شروط مبدئية: لا يتم تسليم المنتج إلا بعد دفعه وموافقة المدير. تختلف شروط المنتجات حسب مزود الخدمة. للاستفسار أو طلب استرداد، استخدم /support. يجب تحديث الشروط وسياسة الخصوصية قبل الإطلاق العام.');
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
    if(message.photo?.length && session.action==='topup_proof') {
      const pic=message.photo.at(-1);
      return writeTopup(db,env,ctx,uid,session,pic.file_id,pic.file_unique_id);
    }
    const result=await handleTextState(db,env,ctx,uid,message,session);
    if(result!==null)return result;
  }
  if(message.photo?.length)return sendText(env,uid,'للشحن، افتح 👛 محفظتي أولاً.');
  return sendText(env,uid,'اختر أحد الأقسام من القائمة الرئيسية أو اكتب /start.',keyboard([button('🏠 الرئيسية','home')]));
}
async function adminMenu(db,env,uid){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ هذا القسم خاص بمدير المتجر.');
  const [topups,orders]=await Promise.all([
    db.prepare("SELECT count(*) n FROM topup_requests WHERE status='pending'").first(),
    db.prepare("SELECT count(*) n FROM orders WHERE status='awaiting_admin'").first()
  ]);
  return sendText(env,uid,`🛡️ لوحة تحكم المدير\n\n💳 طلبات الشحن المعلقة: ${topups?.n||0}\n🛍️ طلبات الشراء المعلقة: ${orders?.n||0}`,keyboard(
    [button('💳 طلبات الشحن','admin_topups')],
    [button('🛍️ طلبات الشراء','admin_orders')],
    [button('📦 بانتظار التسليم','admin_delivery')],
    [button('➕ إضافة منتج','admin_addproduct'),button('➕ إضافة قسم','admin_addcategory')],
    [button('📋 قائمة الأقسام وأرقامها','admin_categories')],backRow()));
}
async function adminList(db,env,uid,type){
  if(!isAdmin(env,uid))return sendText(env,uid,'⛔ صلاحيات غير كافية.');
  if(type==='topups'){
    const rows=(await db.prepare("SELECT t.*,u.first_name,u.username FROM topup_requests t JOIN users u ON u.tg_id=t.user_tg_id WHERE t.status='pending' ORDER BY t.id LIMIT 10").all()).results??[];
    if(!rows.length)return sendText(env,uid,'✅ لا توجد طلبات شحن معلقة.',keyboard([button('🛡️ الإدارة','admin')],backRow()));
    for(const r of rows){
      await sendText(env,uid,`💳 طلب شحن #${r.id}\n👤 ${short(r.first_name,80)} (${r.user_tg_id})\n@${r.username||'بدون_معرف'}\n💰 ${formatIQD(r.amount_iqd)}\nالوسيلة: ${moneyMethods[r.method]}\nرقم التحويل: ${short(r.transfer_reference||'غير متوفر',120)}\n⚠️ تحقّق من وصول التحويل بنفسك قبل الموافقة.`,keyboard(
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
  const newStatus=approve?'approved':'rejected';
  const operations=[db.prepare("UPDATE topup_requests SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(newStatus,uid,id)];
  if(approve)operations.push(db.prepare(`INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
    SELECT user_tg_id,amount_iqd,'topup','topup:' || id,'Admin-verified manual topup'
    FROM topup_requests WHERE id=? AND status='approved'`).bind(id));
  const res=await db.batch(operations);
  if(!res[0].meta?.changes)return sendText(env,uid,'⚠️ الطلب غير موجود أو تمت معالجته بالفعل.');
  await audit(db,uid,approve?'approve':'reject','topup',id);
  const row=await db.prepare('SELECT * FROM topup_requests WHERE id=?').bind(id).first();
  await notifyUser(db,row.user_tg_id,approve?`✅ تمت الموافقة على شحن المحفظة #${id}\nأضيف ${formatIQD(row.amount_iqd)} إلى رصيدك الداخلي.`:`❌ رُفض طلب الشحن #${id}. تواصل مع الدعم لمزيد من المعلومات.`);
  return sendText(env,uid,`✅ تم ${approve?'قبول':'رفض'} طلب الشحن #${id}.`);
}
async function decideOrder(db,env,uid,id,approve){
  if(!isAdmin(env,uid))return;
  let res;
  try{res=await db.prepare(`UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_admin'`).bind(approve?'awaiting_payment':'rejected',id).run();}
  catch(e){if(/stock|unavailable/i.test(String(e)))return sendText(env,uid,'❌ تعذر الموافقة: المنتج غير متوفر أو المخزون غير كافٍ.');throw e;}
  if(!res.meta?.changes)return sendText(env,uid,'⚠️ الطلب عولج سابقاً أو لم يعد معلقاً.');
  await audit(db,uid,approve?'approve':'reject','order',id);
  const o=await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  await notifyUser(db,o.user_tg_id,approve?`✅ وافق المدير على طلبك #${id}.\nأصبح بإمكانك الدفع باستخدام Telegram Stars من خلال زر «طلباتي».`:`❌ رفض المدير طلبك #${id}. لم تُفرض عليك أي رسوم.`);
  return sendText(env,uid,`✅ ${approve?'تم قبول':'تم رفض'} الطلب #${id}.`);
}
async function deliverOrder(db,env,uid,id){
  if(!isAdmin(env,uid))return;
  const res=await db.prepare("UPDATE orders SET status='delivered',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid_pending_delivery'").bind(id).run();
  if(!res.meta?.changes)return sendText(env,uid,'⚠️ الطلب غير موجود أو لم يُدفع أو تم تسليمه بالفعل.');
  await audit(db,uid,'deliver','order',id);
  const o=await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  await notifyUser(db,o.user_tg_id,`✅ تم تحديد طلبك #${id} كمكتمل من المدير. إذا لم تستلم الخدمة، راسل /support.`);
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
  if(!uid)return;
  await ensureUser(db,q.from);
  // Answer immediately; expensive database work happens afterwards.
  try{await answerCallback(env,q.id)}catch(e){console.error('callback acknowledgement',String(e))}
  const data=String(q.data||'');
  if(data==='home'){await clearSession(db,uid);return ui.home(db,env,uid)}
  if(data==='categories')return ui.categories(db,env,uid);
  if(data==='featured')return ui.products(db,env,uid,0,null,null,true);
  if(data==='profile')return ui.profile(db,env,uid);
  if(data==='wallet')return ui.wallet(db,env,uid);
  if(data==='transactions')return ui.transactions(db,env,uid);
  if(data==='orders')return ui.orders(db,env,uid);
  if(data==='favorites')return ui.favorites(db,env,uid);
  if(data==='products:0' || /^products:\d+$/.test(data))return ui.products(db,env,uid,Math.min(100,Number(data.split(':')[1])));
  if(data==='search'){await setSession(db,uid,'search');return sendText(env,uid,'🔎 أدخل اسم المنتج الذي تبحث عنه. للإلغاء /cancel.');}
  if(data==='support'){await setSession(db,uid,'support');return sendText(env,uid,'🎧 أرسل رسالتك الآن. للإلغاء /cancel.');}
  if(data==='news')return env.NEWS_URL?.startsWith('https://')?sendText(env,uid,`📢 قناة الأخبار: ${env.NEWS_URL}`,keyboard(backRow())):sendText(env,uid,'لم يضف المدير قناة أخبار بعد.',keyboard(backRow()));
  if(data==='language')return sendText(env,uid,'🌐 اللغة الحالية: العربية\n\nسيتم دعم لغات إضافية بترجمة كاملة في تحديث لاحق.',keyboard([button('🇮🇶 العربية','language_ar')],backRow()));
  if(data==='language_ar')return sendText(env,uid,'✅ اللغة العربية مفعّلة.',keyboard(backRow()));
  if(data==='referrals'){
    const count=await db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first();
    const link=env.BOT_USERNAME?`https://t.me/${env.BOT_USERNAME.replace('@','')}?start=ref_${uid}`:'سيظهر الرابط عند ضبط BOT_USERNAME';
    return sendText(env,uid,`👥 برنامج الإحالات\n\nعدد الأصدقاء المدعوين: ${count?.n||0}\nرابطك: ${link}\n\nمكافآت الإحالة غير مفعّلة حالياً؛ لا توجد أرباح تلقائية من عمليات الشراء.`,keyboard(backRow()));
  }
  if(data.startsWith('category:')){
    const m=data.match(/^category:(\d+):(\d+)$/);
    if(m)return ui.products(db,env,uid,Math.min(Number(m[2]),100),Number(m[1]));
  }
  if(data.startsWith('product:'))return ui.productView(db,env,uid,Number(data.split(':')[1]));
  if(data.startsWith('favorite:')){
    const productId=positiveInt(data.split(':')[1]);if(!productId)return;
    const p=await getProduct(db,productId);if(!p)return;
    const existing=await db.prepare('SELECT 1 AS ok FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,productId).first();
    if(existing)await db.prepare('DELETE FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,productId).run();
    else await db.prepare('INSERT OR IGNORE INTO favorites(user_tg_id,product_id) VALUES (?,?)').bind(uid,productId).run();
    return ui.productView(db,env,uid,productId);
  }
  if(data.startsWith('buy:')){
    const id=positiveInt(data.split(':')[1]),p=id?await getProduct(db,id):null;
    if(!p || p.stock===0)return sendText(env,uid,'هذا المنتج غير متوفر حالياً.');
    return sendText(env,uid,`🛒 تأكيد الطلب\n\n${short(p.title,100)}\nالمدة: ${p.duration_months||'حسب الخدمة'} شهر\nالكمية: 1\nالسعر: ${formatStars(p.price_stars)}\n\nسيُراجع المدير طلبك قبل السماح بالدفع والتسليم.`,keyboard([button('✅ إرسال طلب للمدير',`confirm_buy:${p.id}`,'success')],[button('↩️ عودة للمنتج',`product:${p.id}`)]));
  }
  if(data.startsWith('confirm_buy:')){
    const id=positiveInt(data.split(':')[1]),p=id?await getProduct(db,id):null;
    if(!p || p.stock===0)return sendText(env,uid,'هذا المنتج لم يعد متاحاً.');
    const res=await db.prepare('INSERT OR IGNORE INTO orders(user_tg_id,product_id,quantity,unit_price_stars,total_stars,source_callback_id) VALUES (?,?,?,?,?,?)').bind(uid,p.id,1,p.price_stars,p.price_stars,q.id).run();
    const oid=res.meta?.changes ? res.meta.last_row_id : (await db.prepare('SELECT id FROM orders WHERE source_callback_id=?').bind(q.id).first())?.id;
    if(!res.meta?.changes) return sendText(env,uid,`تم تسجيل هذا الطلب مسبقاً برقم #${oid}.`);
    await notifyAdmins(db,env,`🛍️ طلب شراء جديد #${oid}\n👤 العميل: ${uid}\n🛍️ المنتج: ${short(p.title,160)}\n💰 السعر: ${formatStars(p.price_stars)}\n📦 الكمية: 1\n⏳ ينتظر موافقة المدير.\n\nللمراجعة: /admin`);
    ctx.waitUntil(flushOutbox(db,env));
    return sendText(env,uid,`✅ تم إنشاء طلبك #${oid}.\n\nبانتظار موافقة المدير. لن يُطلب منك الدفع قبل الموافقة.`,keyboard([button('📦 طلباتي','orders')],backRow()));
  }
  if(data.startsWith('pay:'))return invoice(db,env,uid,Number(data.split(':')[1]));
  if(data==='topup'){
    if(env.ENABLE_MANUAL_TOPUPS!=='true')return sendText(env,uid,'⛔ الشحن اليدوي غير مفعّل حالياً. الدفع مقابل المنتجات الرقمية يتم عبر Telegram Stars.',keyboard(backRow()));
    return ui.topupMethods(env,uid);
  }
  if(data.startsWith('topup_method:')){
    const method=data.split(':')[1];if(!moneyMethods[method])return;
    return ui.topupAmounts(env,uid,method);
  }
  if(data.startsWith('topup_custom:')){
    const method=data.split(':')[1];if(!moneyMethods[method])return;
    await setSession(db,uid,'topup_custom',{method});
    return sendText(env,uid,'✍️ أدخل مبلغ الشحن بالدينار العراقي (مثال: 25000).');
  }
  if(data.startsWith('topup_amount:')){
    const [,method,num]=data.split(':'),amount=positiveInt(num);
    if(!moneyMethods[method] || !amount || amount<1000 || amount>10000000)return;
    await setSession(db,uid,'topup_reference',{method,amount});
    return sendText(env,uid,`💰 مبلغ الشحن: ${formatIQD(amount)}\n\nأرسل رقم العملية أو بيانات التحويل. إذا لا يوجد رقم اكتب - ثم أرسل صورة الإثبات.`);
  }
  if(data==='admin')return adminMenu(db,env,uid);
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
