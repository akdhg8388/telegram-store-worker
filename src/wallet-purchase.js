import {button,keyboard,backRow,formatIQD,short} from './common.js';
import {getUser,getProduct,getSession,setSession,clearSession} from './database.js';
import {usdRate,formatUSD,baghdadDate} from './wallet.js';
import {sendText,telegram} from './telegram.js';
import {trackPurchaseView} from './purchase-views.js';

export async function purchaseAvailability(db,p){
  if(!p || !p.active || !Number.isSafeInteger(p.price_iqd) || p.price_iqd<=0)
    return {ready:false,reason:'لم يحدد المدير سعر المحفظة لهذا المنتج بعد.'};
  if(p.stock===0)return {ready:false,reason:'نفد مخزون المنتج.'};
  if(p.fulfillment_mode==='shared')return String(p.delivery_shared_text||'').trim()
    ?{ready:true,count:p.stock}: {ready:false,reason:'محتوى التسليم غير مهيأ بعد.'};
  if(p.fulfillment_mode==='unique'){
    const r=await db.prepare(`SELECT COUNT(*) AS n FROM product_delivery_items i
       WHERE i.product_id=? AND i.used_by_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL))` ).bind(p.id).first();
    const available=Number(r?.n||0);
    return available>0?{ready:true,count:p.stock===null?available:Math.min(available,p.stock)}
      :{ready:false,reason:'نفدت بيانات التسليم الجاهزة.'};
  }
  return {ready:false,reason:'التسليم التلقائي غير مفعّل لهذا المنتج.'};
}
export async function priceDisplay(db,uid,price){
  const user=await getUser(db,uid);
  if(user?.currency_preference==='USD'){
    const rate=await usdRate(db);
    if(rate)return formatUSD(Math.round(price*100/rate));
  }
  return formatIQD(price);
}
export async function beginPurchase(db,env,uid,p,nonceFactory=()=>crypto.randomUUID()){
  const status=await purchaseAvailability(db,p);
  if(!status.ready)return sendText(env,uid,'⛔ '+status.reason);
  const u=await getUser(db,uid);
  const amount=Number(p.price_iqd),balance=Number(u?.wallet_balance_iqd||0);
  const shownPrice=await priceDisplay(db,uid,amount);
  const shownBalance=await priceDisplay(db,uid,balance);
  if(balance<amount)return sendText(env,uid,
    `💳 رصيد المحفظة غير كافٍ.\n\n🛍️ ${short(p.title,100)}\n💰 السعر: ${shownPrice}\n👛 رصيدك الحالي: ${shownBalance}\n📉 الناقص: ${await priceDisplay(db,uid,amount-balance)}\n\nيرجى شحن محفظتك للمتابعة.`,keyboard([button('➕ شحن المحفظة','topup','success')],[button('💳 محفظتي','wallet')],backRow()));
  const nonce=nonceFactory();
  await setSession(db,uid,'wallet_purchase_confirm',{productId:p.id,nonce});
  const confirmation=await sendText(env,uid,`🛒 تأكيد الشراء من المحفظة\n\n📦 المنتج: ${short(p.title,100)}\n⏳ المدة: ${p.duration_months?p.duration_months+' شهر':'حسب المنتج'}\n💰 السعر: ${shownPrice}\n👛 رصيدك: ${shownBalance}\n\n✅ سيتم خصم المبلغ مرة واحدة وتسليم المحتوى المتاح فوراً.`,keyboard(
    [button('✅ تأكيد الشراء الفوري',`wallet_confirm:${nonce}`,'success')],
    [button('↩️ رجوع للمنتج',`product:${p.id}`,'danger')]));
  await trackPurchaseView(db,uid,confirmation);
  return confirmation;
}
export async function commitPurchase(db,env,uid,nonce){
  if(!/^[0-9a-f-]{36}$/i.test(nonce))return null;
  const existing=await db.prepare('SELECT id FROM wallet_purchases WHERE user_tg_id=? AND submission_key=?').bind(uid,nonce).first();
  if(existing)return {id:existing.id,repeated:true};
  const session=await getSession(db,uid);
  if(session?.action!=='wallet_purchase_confirm' || session.payload?.nonce!==nonce)return null;
  const p=await getProduct(db,Number(session.payload.productId));
  const status=await purchaseAvailability(db,p);
  if(!status.ready)return {failed:status.reason};
  const row=await db.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=?').bind(uid).first();
  if(Number(row?.wallet_balance_iqd||0)<p.price_iqd)return {failed:'رصيد المحفظة غير كافٍ. يرجى شحن محفظتك.'};
  // One INSERT + SQLite triggers: debit, delivery-code claim, and stock decrement
  // succeed atomically or all roll back. Never trust a price sent by the callback.
  const insert=`INSERT INTO wallet_purchases (user_tg_id,product_id,price_iqd,submission_key,delivery_item_id,
    product_name,product_description,duration_months,delivery_payload,usage_instructions,photo_file_id)
    SELECT ?,p.id,p.price_iqd,?,
      CASE WHEN p.fulfillment_mode='unique' THEN
        (SELECT i.id FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1)
        ELSE NULL END,
      p.title,p.description,p.duration_months,
      CASE WHEN p.fulfillment_mode='unique' THEN
        COALESCE((SELECT i.payload FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1),'')
        ELSE p.delivery_shared_text END,
      p.usage_instructions,p.photo_file_id
    FROM products p WHERE p.id=? AND p.active=1 AND p.price_iqd>0
      AND (p.stock IS NULL OR p.stock>0)
      AND ( (p.fulfillment_mode='shared' AND length(trim(p.delivery_shared_text))>0)
         OR (p.fulfillment_mode='unique' AND EXISTS(SELECT 1 FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL)))))`;
  try {
    const result=await db.prepare(insert).bind(uid,nonce,p.id).run();
    if(!result.meta?.changes)return {failed:'لم يعد هذا المنتج متوفراً. لم يُخصم شيء.'};
    await clearSession(db,uid);
    return {id:result.meta.last_row_id,repeated:false};
  }catch(e){
    // A second concurrent callback may have completed successfully.
    const prior=await db.prepare('SELECT id FROM wallet_purchases WHERE user_tg_id=? AND submission_key=?').bind(uid,nonce).first();
    if(prior)return {id:prior.id,repeated:true};
    if(/constraint|unavailable|insufficient|stock|used/i.test(String(e)))return {failed:'تغير الرصيد أو المخزون قبل تأكيد العملية. لم يُخصم شيء إذا لم يُسجل طلب ناجح.'};
    throw e;
  }
}
export async function showReceipt(db,env,uid,id){
  const sale=await db.prepare('SELECT * FROM wallet_purchases WHERE id=? AND user_tg_id=?').bind(id,uid).first();
  if(!sale)return sendText(env,uid,'لا توجد عملية شراء بهذا الرقم لحسابك.');
  const current=await getUser(db,uid);
  const amount=await priceDisplay(db,uid,sale.price_iqd);
  const balance=await priceDisplay(db,uid,Number(current?.wallet_balance_iqd||0));
  const text=`✅ تم الشراء والتسليم بنجاح!\n\n🧾 العملية: #${sale.id}\n🛍️ المنتج: ${short(sale.product_name,150)}\n📝 التفاصيل: ${short(sale.product_description||'—',650)}\n⏳ المدة: ${sale.duration_months?sale.duration_months+' شهر':'حسب المنتج'}\n💰 المبلغ المخصوم: ${amount}\n💳 رصيدك المتبقي: ${balance}\n📅 التاريخ والوقت: ${baghdadDate(sale.created_at)}\n\n📦 بيانات المنتج المستلم:\n${short(sale.delivery_payload,1400)}\n\n📖 طريقة الاستخدام:\n${short(sale.usage_instructions||'لم يضف المدير تعليمات إضافية.',900)}`;
  const markup=keyboard([button('📦 مشترياتي','wallet_purchases','success')],[button('🏠 الرئيسية','home','primary')]);
  // The receipt is saved BEFORE sending. A transient Telegram error never loses
  // the purchased content; the customer can reopen it under My Purchases.
  try {const msg=await sendText(env,uid,text,markup);await trackPurchaseView(db,uid,msg);}catch(e){console.error('Wallet receipt Telegram failure',String(e));}
  if(sale.photo_file_id){
    try {const msg=await telegram(env,'sendPhoto',{chat_id:uid,photo:sale.photo_file_id,caption:`🖼️ صورة ${short(sale.product_name,110)} — عملية #${sale.id}`});await trackPurchaseView(db,uid,msg);}
    catch(e){console.error('Wallet receipt photo failure',String(e));}
  }
  return sale;
}
export async function purchaseList(db,env,uid,messageId=null){
  const {sendOrEditText}=await import('./telegram.js');
  const rows=(await db.prepare('SELECT id,product_name,price_iqd,created_at FROM wallet_purchases WHERE user_tg_id=? ORDER BY id DESC LIMIT 15').bind(uid).all()).results??[];
  return sendOrEditText(env,uid,rows.length?'📦 مشترياتي من المحفظة\n\nاختر عملية لعرض تفاصيل المنتج والصورة وطريقة الاستخدام.':'📦 مشترياتي\n\nلم تشترِ منتجات من المحفظة بعد.',keyboard(
    ...rows.map(p=>[button(`#${p.id} • ${short(p.product_name,32)}`,`wallet_receipt:${p.id}`,'primary')]),
    backRow()),messageId);
}
