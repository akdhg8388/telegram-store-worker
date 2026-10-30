import {languageOf,choice} from './i18n.js';
import {button,keyboard,backRow,formatIQD,short} from './common.js';
import {getUser,getProduct,getSession,setSession,clearSession} from './database.js';
import {usdRate,formatUSD,baghdadDate} from './wallet.js';
import {sendText,telegram} from './telegram.js';
import {trackPurchaseView} from './purchase-views.js';
import {warrantyLine} from './warranty.js';
import {sendPhotoCard,cardEntities} from './product-card.js';

export async function purchaseAvailability(db,p){
  if(!p || !p.active || !Number.isSafeInteger(p.price_iqd) || p.price_iqd<=0)
    return {ready:false,reason:'لم يحدد المدير سعر المحفظة لهذا المنتج بعد.'};
  if(p.stock===0)return {ready:false,reason:'نفد مخزون المنتج.'};
  if(p.fulfillment_mode==='shared')return String(p.delivery_shared_text||'').trim()
    ?{ready:true,count:p.stock}: {ready:false,reason:'محتوى التسليم غير مهيأ بعد.'};
  if(p.fulfillment_mode==='unique'){
    const r=await db.prepare(`SELECT COUNT(*) AS n FROM product_delivery_items i
       WHERE i.product_id=? AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL))` ).bind(p.id).first();
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
  const [u,rate]=await Promise.all([getUser(db,uid),usdRate(db)]);
  const amount=Number(p.price_iqd),balance=Number(u?.wallet_balance_iqd||0);
  const price=value=>u?.currency_preference==='USD'&&rate?formatUSD(Math.round(value*100/rate)):formatIQD(value);
  const title=short(languageOf(env)==='en'&&p.title_en||p.title,100);
  const warranty=warrantyLine(p,languageOf(env));
  if(balance<amount)return sendText(env,uid,languageOf(env)==='en'
    ?`💳 Insufficient wallet balance.\n\n🛍️ ${title}\n💰 Price: ${price(amount)}${warranty?'\n'+warranty:''}\n👛 Your balance: ${price(balance)}\n📉 Amount needed: ${price(amount-balance)}\n\nPlease top up your wallet to continue.`
    :`💳 رصيد المحفظة غير كافٍ.\n\n🛍️ ${title}\n💰 السعر: ${price(amount)}${warranty?'\n'+warranty:''}\n👛 رصيدك الحالي: ${price(balance)}\n📉 الناقص: ${price(amount-balance)}\n\nيرجى شحن محفظتك للمتابعة.`,keyboard([button('➕ شحن المحفظة','topup','success')],[button('💳 محفظتي','wallet')],backRow()),{preserveText:languageOf(env)==='en'});
  const nonce=nonceFactory();
  await setSession(db,uid,'wallet_purchase_confirm',{productId:p.id,nonce});
  const details=languageOf(env)==='en'
    ?`🛒 Confirm Wallet Purchase\n\n📦 Product: ${title}\n⏳ Duration: ${p.duration_months?p.duration_months+' month(s)':'As specified for this product'}\n💰 Price: ${price(amount)}${warranty?'\n'+warranty:''}\n👛 Your balance: ${price(balance)}\n\n✅ Your wallet will be charged once, and the item will be delivered immediately.`
    :`🛒 تأكيد الشراء من المحفظة\n\n📦 المنتج: ${title}\n⏳ المدة: ${p.duration_months?p.duration_months+' شهر':'حسب المنتج'}\n💰 السعر: ${price(amount)}${warranty?'\n'+warranty:''}\n👛 رصيدك: ${price(balance)}\n\n✅ سيتم خصم المبلغ مرة واحدة وتسليم المحتوى المتاح فوراً.`;
  const confirmation=await sendText(env,uid,details,keyboard(
    [button('✅ تأكيد الشراء الفوري',`wallet_confirm:${nonce}`,'success')],
    [button('↩️ رجوع للمنتج',`product:${p.id}`,'danger')]),{preserveText:languageOf(env)==='en'});
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
    product_name,product_description,duration_months,delivery_payload,usage_instructions,photo_file_id,
    warranty_visible,warranty_available,warranty_terms_ar,warranty_terms_en)
    SELECT ?,p.id,p.price_iqd,?,
      CASE WHEN p.fulfillment_mode='unique' THEN
        (SELECT i.id FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1)
        ELSE NULL END,
      p.title,p.description,p.duration_months,
      CASE WHEN p.fulfillment_mode='unique' THEN
        COALESCE((SELECT i.payload FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
           WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1),'')
        ELSE p.delivery_shared_text END,
      p.usage_instructions,p.photo_file_id,
      p.warranty_visible,p.warranty_available,p.warranty_terms_ar,p.warranty_terms_en
    FROM products p WHERE p.id=? AND p.active=1 AND p.price_iqd>0
      AND (p.stock IS NULL OR p.stock>0)
      AND ( (p.fulfillment_mode='shared' AND length(trim(p.delivery_shared_text))>0)
         OR (p.fulfillment_mode='unique' AND EXISTS(SELECT 1 FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
         AND NOT EXISTS(SELECT 1 FROM product_delivery_items older WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL)))))`;
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
  const sale=await db.prepare(`SELECT w.*,p.title_en AS current_title_en,p.description_en AS current_description_en,
      p.usage_instructions_en AS current_usage_en
    FROM wallet_purchases w LEFT JOIN products p ON p.id=w.product_id WHERE w.id=? AND w.user_tg_id=?`).bind(id,uid).first();
  if(!sale)return sendText(env,uid,'لا توجد عملية شراء بهذا الرقم لحسابك.');
  // Run independent reads together; never alter the existing atomic purchase,
  // ledger, inventory, or one-code-per-buyer logic.
  const [current,rate,ledger]=await Promise.all([
    getUser(db,uid),usdRate(db),
    db.prepare("SELECT id FROM wallet_ledger WHERE source_key=? AND user_tg_id=? LIMIT 1")
      .bind('wallet_purchase:'+sale.id,uid).first()
  ]);
  const format=value=>current?.currency_preference==='USD'&&rate?formatUSD(Math.round(Number(value)*100/rate)):formatIQD(value);
  const english=languageOf(env)==='en';
  const name=short(english&&sale.current_title_en||sale.product_name,150);
  const details=short(english&&sale.current_description_en||sale.product_description||'—',650);
  const usage=short(english&&sale.current_usage_en||sale.usage_instructions||choice(env,'لم يضف المدير تعليمات إضافية.','No additional instructions provided.'),900);
  const warranty=warrantyLine(sale,languageOf(env));
  // Historical balance is calculated from the committed ledger, not from the
  // customer's live balance, which can change after an old purchase.
  const later=ledger?await db.prepare('SELECT COALESCE(SUM(delta_iqd),0) AS total FROM wallet_ledger WHERE user_tg_id=? AND id>?').bind(uid,ledger.id).first():null;
  const remainder=ledger?Number(current?.wallet_balance_iqd||0)-Number(later?.total||0):Number(current?.wallet_balance_iqd||0);
  const labels=english
    ?['💰 Product price:','💸 Amount deducted:','💳 Balance after purchase:','📅 Purchase date & time:']
    :['💰 سعر المنتج:','💸 الرصيد المخصوم:','💳 الرصيد بعد الشراء:','📅 تاريخ ووقت الشراء:'];
  const itemLabel=choice(env,'📦 بيانات المنتج المستلم:','📦 Your delivered item:');
  const usageLabel=choice(env,'📖 طريقة الاستخدام:','📖 How to use:');
  const detailsLabel=choice(env,'📝 التفاصيل:','📝 Description:');
  const text=[
    choice(env,'✅ تم الشراء والتسليم بنجاح!','✅ Purchase & delivery successful!'),
    '🧾 '+choice(env,'رقم العملية: ','Purchase #')+sale.id,
    '🛍️ '+name,'',
    detailsLabel+'\n'+details,'',
    usageLabel+'\n'+usage,'',
    itemLabel+'\n'+(Number(sale.quantity||1)>1&&sale.delivery_item_id?'🔑 الأكواد والروابط المستلمة تظهر في رسائل تالية.':short(sale.delivery_payload,1400)),'',
    '📦 الكمية: '+Number(sale.quantity||1),
    '💵 السعر قبل الخصم: '+format(Number(sale.unit_price_iqd||sale.price_iqd)*Number(sale.quantity||1)),
    '🎁 خصم الكمية: '+Number(sale.discount_percent||0)+'%','',
    labels[0]+' '+format(sale.price_iqd),
    labels[1]+' '+format(sale.price_iqd),
    labels[2]+' '+format(remainder),
    labels[3]+' '+baghdadDate(sale.created_at,english?'en':'ar'),
    warranty||''
  ].join('\n');
  const markup=keyboard([button('📦 مشترياتي','wallet_purchases','success')],[button('🏠 الرئيسية','home','primary')]);
  const entities=cardEntities(text,labels);
  try{
    await sendPhotoCard(env,uid,sale.photo_file_id,text,markup,{
      entities,preserveText:true,onMessage:msg=>trackPurchaseView(db,uid,msg)
    });
    if(Number(sale.quantity||1)>1 && sale.delivery_item_id){
      const items=(await db.prepare('SELECT payload FROM product_delivery_items WHERE used_by_purchase_id=? OR bulk_purchase_id=? ORDER BY id LIMIT 100').bind(id,id).all()).results||[];
      let part='🔑 الأكواد والروابط المستلمة (#'+sale.id+'):\n';
      for(let i=0;i<items.length;i++){
        const line='\n'+(i+1)+'. '+items[i].payload+'\n';
        if(part.length+line.length>3300){
          const extra=await sendText(env,uid,part,undefined,{preserveText:true});
          await trackPurchaseView(db,uid,extra);
          part='🔑 متابعة الأكواد (#'+sale.id+'):\n';
        }
        part+=line;
      }
      if(part.trim()){
        const extra=await sendText(env,uid,part,keyboard([button('🏠 الرئيسية','home','primary')]),{preserveText:true});
        await trackPurchaseView(db,uid,extra);
      }
    }
  }catch(e){console.error('Wallet receipt Telegram failure',String(e));}
  return sale;
}
export async function purchaseList(db,env,uid,messageId=null){
  const {sendOrEditText}=await import('./telegram.js');
  const rows=(await db.prepare(`SELECT w.id,w.product_name,w.price_iqd,w.created_at,p.title_en FROM wallet_purchases w
    LEFT JOIN products p ON p.id=w.product_id WHERE w.user_tg_id=? AND w.created_at>=datetime('now','-30 days') ORDER BY w.id DESC LIMIT 15`).bind(uid).all()).results??[];
  return sendOrEditText(env,uid,languageOf(env)==='en'
    ?(rows.length?'📦 My Wallet Purchases\n\nSelect a purchase to view its details, photo, and instructions.':'📦 My Purchases\n\nYou have not made any wallet purchases yet.')
    :(rows.length?'📦 مشترياتي من المحفظة\n\nاختر عملية لعرض تفاصيل المنتج والصورة وطريقة الاستخدام.':'📦 مشترياتي\n\nلم تشترِ منتجات من المحفظة بعد.'),keyboard(
    ...rows.map(p=>[button(`#${p.id} • ${short(languageOf(env)==='en'&&p.title_en||p.product_name,32)}`,`wallet_receipt:${p.id}`,'primary')]),
    backRow()),messageId,{preserveText:languageOf(env)==='en'});
}
