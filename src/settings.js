// The only values that an administrator may edit from Telegram. Secrets and identity are immutable here.
export const SETTING_FIELDS=Object.freeze({
  store_name: {label:'🏪 اسم المتجر',max:80,required:true},
  welcome_text: {label:'👋 رسالة الترحيب',max:1500},
  storefront_instructions: {label:'🛍️ تعليمات المتجر',max:1500},
  purchase_instructions: {label:'🛒 تعليمات الطلب',max:1500},
  topup_instructions: {label:'💳 تعليمات الشحن',max:1500},
  payment_instructions: {label:'💎 تعليمات الدفع',max:1500},
  delivery_instructions: {label:'📦 تعليمات التسليم',max:1500},
  support_instructions: {label:'🎧 تعليمات الدعم',max:1500},
  terms_text: {label:'📜 شروط الاستخدام',max:3500},
  privacy_text: {label:'🔐 سياسة الخصوصية',max:3500},
  support_url: {label:'🔗 رابط الدعم',max:350,url:true},
  news_url: {label:'📣 رابط قناة الأخبار',max:350,url:true},
  asiacell_receiver: {label:'📱 بيانات استقبال آسيا سيل',max:250},
  zaincash_receiver: {label:'💸 بيانات استقبال زين كاش',max:250},
  superqi_receiver: {label:'🏦 بيانات استقبال سوبر كي',max:250},
  store_enabled: {label:'🔌 استقبال طلبات جديدة',max:5,toggle:true},
});

export function validateSetting(key,input){
  const field=SETTING_FIELDS[key];
  if(!field)return {ok:false,reason:'الإعداد غير مدعوم.'};
  const value=String(input??'').trim();
  if(field.toggle && !['true','false'].includes(value))return {ok:false,reason:'اختر تفعيل أو تعطيل من لوحة الإدارة.'};
  if(field.required && !value)return {ok:false,reason:'لا يمكن ترك هذا الحقل فارغاً.'};
  if(value.length>field.max)return {ok:false,reason:`الحد الأقصى ${field.max} حرف.`};
  if(field.url && value){
    try {const u=new URL(value); if(u.protocol!=='https:' || !u.hostname || u.username || u.password)throw Error('invalid');}
    catch{return {ok:false,reason:'الرابط يجب أن يبدأ بـ https:// ويكون صالحاً.'};}
  }
  return {ok:true,value};
}

export async function getSetting(db,key,fallback=''){
  if(!Object.hasOwn(SETTING_FIELDS,key))return fallback;
  const record=await db.prepare('SELECT value FROM bot_settings WHERE key=?').bind(key).first();
  return record?record.value:fallback;
}

export async function updateSetting(db,key,value,adminId){
  const valid=validateSetting(key,value);
  if(!valid.ok)throw new Error(valid.reason);
  await db.prepare(`INSERT INTO bot_settings(key,value,updated_by) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .bind(key,valid.value,adminId).run();
  return valid.value;
}

export async function storeAcceptsOrders(db){return (await getSetting(db,'store_enabled','true'))!=='false';}
