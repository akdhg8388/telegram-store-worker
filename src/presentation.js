import {getSetting} from './settings.js';

// Names here are deliberately presentation-only. Never let template text change
// money, access privileges, user identifiers, prices or counters in the database.
export const DEFAULT_HOME_TEMPLATE=`👋 أهلاً بك في {store}!\n\nاشترِ المنتجات الرقمية مباشرة من هنا.\n\n💰 رصيدك: IQD {balance_iqd} (≡ \${balance_usd} USD)\n👤 الاسم: {name}\n🆔 المعرّف: {id}\n👥 المستخدمون: {users}`;

export const UI_EMOJI_SETTINGS=Object.freeze({
  home:'home_custom_emoji_id',shop:'shop_custom_emoji_id',
  profile:'profile_custom_emoji_id',wallet:'wallet_custom_emoji_id',
  orders:'orders_custom_emoji_id',support:'support_custom_emoji_id'
});
export function renderHomeTemplate(template,values){
  const source=String(template||DEFAULT_HOME_TEMPLATE);
  return source.replace(/\{(store|balance_iqd|balance_usd|name|id|users|instructions)\}/g,(_match,key)=>String(values[key]??''))
    .slice(0,3800);
}
export function decimalMoney(value){return Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}

// Telegram custom emoji entities refer to an actual custom_emoji_id, not a GIF.
// Offset and length are UTF-16 code units as required by Telegram Bot API.
export async function decoratedMessage(db,key,text){
  const setting=UI_EMOJI_SETTINGS[key];
  if(!setting)return {text};
  const id=await getSetting(db,setting,'');
  if(!/^\d{10,30}$/.test(id))return {text};
  const first=Array.from(new Intl.Segmenter('ar',{granularity:'grapheme'}).segment(text))[0]?.segment||'';
  const symbol=/\p{Extended_Pictographic}/u.test(first)?first:'✨';
  const content=symbol===first?text:'✨ '+text;
  return {text:content,options:{entities:[{type:'custom_emoji',offset:0,length:symbol.length,custom_emoji_id:id}]}};
}
