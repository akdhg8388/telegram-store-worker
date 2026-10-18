import {homeButtonSettings} from './home-buttons.js';
// The only values that an administrator may edit from Telegram. Secrets and identity are immutable here.
export const SETTING_FIELDS=Object.freeze({
  store_name: {label:'🏪 اسم المتجر',max:80,required:true},
  bot_public_name: {label:'🏷️ اسم البوت العام قبل البدء',max:64,botProfile:'setMyName'},
  bot_public_description: {label:'📝 وصف البوت قبل زر ابدأ',max:512,botProfile:'setMyDescription'},
  bot_public_short_description: {label:'📃 وصف البوت المختصر',max:120,botProfile:'setMyShortDescription'},
  users_display_adjustment: {label:'👥 فرق عداد المستخدمين المعروض',max:12,internal:true},
  support_direct_username: {label:'🔗 حساب المسؤول للتواصل المباشر',max:33,username:true},
  support_direct_label: {label:'👤 عنوان زر المسؤول',max:60},
  support_direct_enabled: {label:'👁️ إظهار زر تواصل المسؤول',max:5,toggle:true},
  home_template: {label:'👋 قالب رسالة الرئيسية (حقول حقيقية)',max:3200},
  home_template_en: {label:'👋 English home message template',max:3200},
  welcome_text: {label:'👋 نص الترحيب السابق (للتوافق)',max:1500},
  home_custom_emoji_id: {label:'✨ الرمز المتحرك للرئيسية',max:30,customEmoji:true},
  shop_custom_emoji_id: {label:'✨ الرمز المتحرك للمتجر',max:30,customEmoji:true},
  profile_custom_emoji_id: {label:'✨ الرمز المتحرك للملف الشخصي',max:30,customEmoji:true},
  wallet_custom_emoji_id: {label:'✨ الرمز المتحرك للمحفظة',max:30,customEmoji:true},
  orders_custom_emoji_id: {label:'✨ الرمز المتحرك للطلبات',max:30,customEmoji:true},
  support_custom_emoji_id: {label:'✨ الرمز المتحرك للدعم',max:30,customEmoji:true},
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
  zain_balance_receiver: {label:'📱 رقم استقبال رصيد زين',max:250},
  binance_receiver: {label:'🟡 Binance Pay ID أو العنوان والشبكة',max:350},
  usd_rate_iqd: {label:'💱 سعر الدولار بالدينار العراقي (لكل 1 USD)',max:5,required:true,rate:true},
  manual_topups_enabled: {label:'💳 تشغيل طلبات شحن المحفظة',max:5,toggle:true},
  store_enabled: {label:'🔌 استقبال طلبات جديدة',max:5,toggle:true},
  maintenance_enabled: {label:'🛠️ وضع الصيانة',max:5,toggle:true},
  maintenance_message_ar: {label:'🛠️ رسالة الصيانة بالعربي',max:800},
  maintenance_message_en: {label:'🛠️ Maintenance message (English)',max:800},
  ...homeButtonSettings(),
});

export function validateSetting(key,input){
  const field=SETTING_FIELDS[key];
  if(!field)return {ok:false,reason:'الإعداد غير مدعوم.'};
  const value=String(input??'').trim();
  if(field.internal && !field.internalText && (!/^-?\d+$/.test(value) || Math.abs(Number(value))>1000000000))return {ok:false,reason:'فرق العداد غير صالح.'};
  if(field.username && value && !/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value))return {ok:false,reason:'اكتب اسم مستخدم تيليجرام صحيحاً مثل @MyAccount (بدون رابط).'};
  if(field.customEmoji && value && !/^\d{10,30}$/.test(value))return {ok:false,reason:'أرسل custom_emoji_id الصحيح أو أرسل رسالة تتضمن الرمز المتحرك، أو /empty للمسح.'};
  if(field.rate && (!/^\d+$/.test(value) || Number(value)<100 || Number(value)>10000))return {ok:false,reason:'أدخل سعراً صحيحاً بين 100 و10,000 دينار لكل دولار واحد.'};
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

export async function storeAcceptsOrders(db){return (await getSetting(db,'store_enabled','true'))!=='false' && (await getSetting(db,'maintenance_enabled','false'))!=='true';}
export async function maintenanceActive(db){return (await getSetting(db,'maintenance_enabled','false'))==='true';}
