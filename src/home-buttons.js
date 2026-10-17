import {button,urlButton,short} from './common.js';

// Button actions are immutable; owner can only edit labels and icons.
// Older page-header emoji settings remain compatible with the home icons.
export const HOME_BUTTONS=Object.freeze([
  {id:'shop',action:'categories',ar:'🛍️ المتجر',en:'🛍️ Shop',legacy:'shop_custom_emoji_id'},
  {id:'featured',action:'featured',ar:'💎 المنتجات المميزة',en:'💎 Featured Products'},
  {id:'wallet',action:'wallet',ar:'💳 محفظتي',en:'💳 My Wallet',legacy:'wallet_custom_emoji_id'},
  {id:'profile',action:'profile',ar:'👤 ملفي الشخصي',en:'👤 My Profile',legacy:'profile_custom_emoji_id'},
  {id:'currency',action:'currency',ar:'💱 تغيير العملة 🇮🇶/🇺🇸',en:'💱 Change Currency 🇮🇶/🇺🇸'},
  {id:'orders',action:'orders',ar:'📦 طلباتي',en:'📦 My Orders',legacy:'orders_custom_emoji_id'},
  {id:'transactions',action:'transactions',ar:'📜 سجل العمليات',en:'📜 Transaction History'},
  {id:'referrals',action:'referrals',ar:'👥 الإحالات',en:'👥 Referrals'},
  {id:'language',action:'language',ar:'🌐 اللغة',en:'🌐 Language'},
  {id:'support',action:'support',ar:'🎧 الدعم',en:'🎧 Support',legacy:'support_custom_emoji_id'},
  {id:'news',action:'news',ar:'📢 الأخبار',en:'📢 News'},
  {id:'admin',action:'admin',ar:'🛡️ لوحة تحكم المدير',en:'🛡️ Admin Panel'},
  {id:'reseller',action:'reseller',ar:'🔑 API Reseller',en:'🔑 API Reseller'}
]);
export const ICON_SLOTS=Object.freeze([
  {id:'product',ar:'🛍️ رمز المنتج',en:'🛍️ Product icon'},
  {id:'price',ar:'💰 رمز السعر',en:'💰 Price icon'},
  {id:'stock',ar:'📦 رمز المخزون',en:'📦 Stock icon'}
]);
const VALID_EMOJI=/^\d{10,30}$/;
export const homeSettingKey=(id,kind)=>`home_button_${id}_${kind}`;
export const productIconKey=(id)=>`${id}_custom_emoji_id`;
export function homeButtonSettings(){
  const result={};
  for(const x of HOME_BUTTONS){
    result[homeSettingKey(x.id,'label_ar')]={label:`✏️ اسم زر ${x.ar} بالعربي`,max:52};
    result[homeSettingKey(x.id,'label_en')]={label:`✏️ English label for ${x.en}`,max:52};
    result[homeSettingKey(x.id,'icon')]={label:`✨ رمز زر ${x.ar}`,max:30,customEmoji:true};
  }
  for(const x of ICON_SLOTS)result[productIconKey(x.id)]={label:x.ar,max:30,customEmoji:true};
  return result;
}
export function emojiId(value){return VALID_EMOJI.test(String(value||''))?String(value):null;}
export async function loadVisualSettings(db){
  const rows=await db.prepare(`SELECT key,value FROM bot_settings WHERE key LIKE 'home_button_%' OR key LIKE '%_custom_emoji_id' OR key IN ('store_name','home_template','home_template_en','storefront_instructions','users_display_adjustment','purchase_instructions','usd_rate_iqd')`).all();
  return Object.fromEntries((rows.results||[]).map(row=>[row.key,row.value]));
}
export function resolvedHomeButton(settings,id,lang='ar'){
  const def=HOME_BUTTONS.find(x=>x.id===id);
  if(!def)return null;
  const key=homeSettingKey(id,lang==='en'?'label_en':'label_ar');
  const title=String(settings[key]||'').trim()||def[lang==='en'?'en':'ar'];
  const iconKey=homeSettingKey(id,'icon');
  const icon=emojiId(Object.hasOwn(settings,iconKey)?settings[iconKey]:(def.legacy?settings[def.legacy]:''));
  return {text:short(title,52),icon};
}
export function homeActionButton(settings,id,lang='ar',style='primary'){
  const def=HOME_BUTTONS.find(x=>x.id===id);
  if(!def)return null;
  const visual=resolvedHomeButton(settings,id,lang);
  const out=button(visual.text,def.action,style);
  if(visual.icon)out.icon_custom_emoji_id=visual.icon;
  return out;
}
export function homeUrlButton(settings,id,url,lang='ar'){
  const visual=resolvedHomeButton(settings,id,lang);
  const out=urlButton(visual.text,url);
  if(visual.icon)out.icon_custom_emoji_id=visual.icon;
  return out;
}
export function withButtonIcon(item,id){
  const icon=emojiId(id);
  if(icon)item.icon_custom_emoji_id=icon;
  return item;
}
