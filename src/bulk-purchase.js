import {purchaseAvailability,priceDisplay} from './wallet-purchase.js';
import {getProduct,getUser,getSession,setSession,clearSession} from './database.js';
import {usdRate,formatUSD} from './wallet.js';
import {button,keyboard,formatIQD,short} from './common.js';
import {sendText} from './telegram.js';
import {trackPurchaseView} from './purchase-views.js';
import {warrantyLine} from './warranty.js';

export function quantityPricing(p,qty){
 if(!p||!Number.isSafeInteger(qty)||qty<1||qty>Math.min(100,Number(p.max_purchase_qty||100)))return null;
 const unit=Number(p.price_iqd),discount=Math.max(Number(p.discount_general_percent||0),qty>=20?Number(p.discount_20_percent||0):0,qty>=5?Number(p.discount_5_percent||0):0);
 if(!Number.isSafeInteger(unit)||unit<=0||!Number.isInteger(discount)||discount<0||discount>90)return null;
 const original=unit*qty,total=Math.floor((original*(100-discount)+50)/100);
 return {qty,unit,discount,original,total,saved:original-total};
}
export async function quantityPicker(db,env,uid,p){
 const available=await purchaseAvailability(db,p);
 if(!available.ready)return sendText(env,uid,'⛔ '+available.reason);
 const user=await getUser(db,uid),rate=user?.currency_preference==='USD'?await usdRate(db):null;
 const price=value=>rate?formatUSD(Math.round(value*100/rate)):formatIQD(value);
 const msg=await sendText(env,uid,'🛒 اختر الكمية\n\n📦 المنتج: '+short(p.title,110)+
   '\n💰 سعر الوحدة: '+price(p.price_iqd)+
   '\n📦 المخزون: '+(available.count??'غير محدود')+
   '\n📋 الحد الأقصى للطلب: '+Math.min(100,p.max_purchase_qty||100)+
   '\n🏷️ خصم عام: '+(p.discount_general_percent||0)+'%'+
   '\n🎁 خصم 5 فأكثر: '+(p.discount_5_percent||0)+'%'+
   '\n🎁 خصم 20 فأكثر: '+(p.discount_20_percent||0)+'%'+
   '\n\nيُطبّق أعلى خصم مستحق، دون جمع الخصومات. الكمية يجب ألا تتجاوز المخزون أو الحد الأقصى.',
   keyboard([button('1','buy_qty:'+p.id+':1','success'),button('5','buy_qty:'+p.id+':5','success'),button('20','buy_qty:'+p.id+':20','success')],
     [button('✏️ عدد مخصص','buy_custom:'+p.id,'primary')],
     [button('⬅️ رجوع للمنتج','product:'+p.id,'primary')],
     [button('❌ إلغاء الشراء','buy_cancel','danger')],
     [button('🏠 الرئيسية','home','danger')]));
 await trackPurchaseView(db,uid,msg);
 return msg;
}
export async function bulkConfirm(db,env,uid,p,qty){
 const available=await purchaseAvailability(db,p);
 if(!available.ready)return sendText(env,uid,'⛔ '+available.reason);
 const q=quantityPricing(p,qty);
 if(!q)return sendText(env,uid,'❌ العدد غير صحيح أو يتجاوز الحد الأقصى للطلب.',keyboard([button('🛒 تغيير الكمية','buy:'+p.id)]));
 if(available.count!==null&&available.count!==undefined&&qty>available.count)
   return sendText(env,uid,'❌ المخزون غير كافٍ. المتوفر '+available.count+' فقط.',keyboard([button('🛒 تغيير الكمية','buy:'+p.id)]));
 const [user,rate]=await Promise.all([getUser(db,uid),usdRate(db)]);
 const price=value=>user?.currency_preference==='USD'&&rate?formatUSD(Math.round(value*100/rate)):formatIQD(value);
 const balance=Number(user?.wallet_balance_iqd||0);
 if(balance<q.total)return sendText(env,uid,'💳 رصيدك غير كافٍ.\n💵 المطلوب: '+price(q.total)+'\n👛 الرصيد: '+price(balance)+
   '\n📉 المتبقي: '+price(q.total-balance),keyboard(
   [button('➕ شحن المحفظة','topup','success')],[button('⬅️ تغيير الكمية','buy:'+p.id)],[button('🏠 الرئيسية','home')]));
 const nonce=crypto.randomUUID();
 await setSession(db,uid,'bulk_purchase_confirm',{productId:p.id,qty,nonce,unit:q.unit,discount:q.discount,total:q.total});
 const msg=await sendText(env,uid,'🛒 مراجعة الشراء\n\n📦 '+short(p.title,110)+
   '\n🔢 الكمية: '+qty+
   '\n💰 الوحدة: '+price(q.unit)+
   '\n💵 قبل الخصم: '+price(q.original)+
   '\n🎁 الخصم: '+q.discount+'%'+
   '\n💚 التوفير: '+price(q.saved)+
   '\n✅ الإجمالي: '+price(q.total)+
   '\n👛 رصيدك: '+price(balance)+
   (warrantyLine(p,'ar')?'\n'+warrantyLine(p,'ar'):'')+
   '\n\nسيُخصم السعر مرة واحدة وتُسلَّم '+qty+' قطعة فوراً.',
   keyboard([button('✅ تأكيد الشراء','bulk_confirm:'+nonce,'success')],
     [button('⬅️ تعديل الكمية','buy:'+p.id,'primary')],
     [button('❌ إلغاء الشراء','buy_cancel','danger')],
     [button('🏠 الرئيسية','home','danger')]));
 await trackPurchaseView(db,uid,msg);
 return msg;
}
export async function commitBulkPurchase(db,uid,nonce){
 if(!/^[a-f0-9-]{36}$/i.test(String(nonce||'')))return null;
 const previous=await db.prepare('SELECT id FROM wallet_purchases WHERE user_tg_id=? AND submission_key=?').bind(uid,nonce).first();
 if(previous)return {id:previous.id,repeated:true};
 const session=await getSession(db,uid);
 if(session?.action!=='bulk_purchase_confirm'||session.payload?.nonce!==nonce)return null;
 const p=await getProduct(db,Number(session.payload.productId)),qty=Number(session.payload.qty),q=quantityPricing(p,qty);
 if(!q)return {failed:'الكمية أو المنتج غير متاحين.'};
 if(session.payload.unit!==q.unit||session.payload.discount!==q.discount||session.payload.total!==q.total)
   return {failed:'تغيّر السعر أو الخصم. افتح المنتج لمراجعة السعر الجديد.'};
 const available=await purchaseAvailability(db,p);
 if(!available.ready||(available.count!=null&&qty>available.count))
   return {failed:'المخزون لم يعد يكفي هذه الكمية. لم يُخصم رصيد.'};
 const sql=[
  "INSERT INTO wallet_purchases (user_tg_id,product_id,price_iqd,submission_key,delivery_item_id,",
  "product_name,product_description,duration_months,delivery_payload,usage_instructions,photo_file_id,",
  "warranty_visible,warranty_available,warranty_terms_ar,warranty_terms_en,quantity,unit_price_iqd,discount_percent)",
  "SELECT ?,p.id,?,?,CASE WHEN p.fulfillment_mode='unique' THEN",
  "(SELECT i.id FROM product_delivery_items i WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL",
  "AND NOT EXISTS(SELECT 1 FROM product_delivery_items older WHERE older.product_id=i.product_id AND older.payload=i.payload",
  "AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1)",
  "ELSE NULL END,p.title,p.description,p.duration_months,",
  "CASE WHEN p.fulfillment_mode='unique' THEN",
  "COALESCE((SELECT i.payload FROM product_delivery_items i WHERE i.product_id=p.id",
  "AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL",
  "AND NOT EXISTS(SELECT 1 FROM product_delivery_items older WHERE older.product_id=i.product_id AND older.payload=i.payload",
  "AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL)) ORDER BY i.id LIMIT 1),'')",
  "ELSE p.delivery_shared_text END,p.usage_instructions,p.photo_file_id,",
  "p.warranty_visible,p.warranty_available,p.warranty_terms_ar,p.warranty_terms_en,?,?,?",
  "FROM products p WHERE p.id=? AND p.active=1 AND p.price_iqd>0"
 ].join(' ');
 try{
   const res=await db.prepare(sql).bind(uid,q.total,nonce,qty,q.unit,q.discount,p.id).run();
   if(!res.meta?.changes)return {failed:'المنتج غير متوفر. لم يُخصم شيء.'};
   await clearSession(db,uid);
   return {id:res.meta.last_row_id,repeated:false};
 }catch(error){
   const prior=await db.prepare('SELECT id FROM wallet_purchases WHERE user_tg_id=? AND submission_key=?').bind(uid,nonce).first();
   if(prior)return {id:prior.id,repeated:true};
   if(/constraint|wallet_purchase|insufficient|stock|delivery_item/i.test(String(error)))return {failed:'الكمية أو الرصيد تغيرا. لم يُخصم أي مبلغ.'};
   throw error;
 }
}
