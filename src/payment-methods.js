import {getSetting} from './settings.js';
import {button} from './common.js';
const defaults={zain_balance:'ZAIN_BALANCE_RECEIVER',superqi:'SUPERQI_RECEIVER',binance:'BINANCE_RECEIVER',asiacell:'ASIACELL_RECEIVER',zaincash:'ZAINCASH_RECEIVER'};
export const LEGACY_KEYS=Object.freeze(Object.keys(defaults));
// Telegram custom emoji buttons have a separate icon: remove duplicate glyphs
// from historical names at read time without changing stored payment data.
export function paymentName(m,lang='ar'){
 const raw=String(lang==='en'&&m.name_en||m.name_ar||m.method_key);
 if(!/^\d{10,30}$/.test(String(m.icon_custom_emoji_id||'')))return raw.slice(0,65);
 const fallback=String(m.icon_fallback||'');
 const withoutFallback=fallback?raw.split(fallback).join(' '):raw;
 const clean=withoutFallback
   .replace(/^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)+/u,'')
   .replace(/\s*(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+)+$/u,'')
   .trim().replace(/\s{2,}/g,' ');
 return (clean||raw.trim()).slice(0,65);
}
export function paymentButton(m,lang,callback){
 const name=paymentName(m,lang);
 const b=button(name,callback,'success');
 if(/^\d{10,30}$/.test(String(m.icon_custom_emoji_id||''))){
   b.icon_custom_emoji_id=m.icon_custom_emoji_id;
   b._emoji_fallback_text=(m.icon_fallback||'💳')+' '+name;
 }
 return b;
}
export async function methodList(db,env,{activeOnly=false}={}){
 const rows=(await db.prepare('SELECT * FROM payment_methods ORDER BY sort_order,method_key LIMIT 60').all()).results||[];
 const legacyKeys=rows.filter(x=>x.legacy_setting_key&&(!x.receiver_ar)).map(x=>x.legacy_setting_key);
 const values=await Promise.all(legacyKeys.map(k=>getSetting(db,k,String(env[defaults[rows.find(x=>x.legacy_setting_key===k)?.method_key]]||''))));
 const fallback=Object.fromEntries(legacyKeys.map((k,i)=>[k,values[i]]));
 const all=rows.map(x=>({...x,receiver:x.receiver_ar||fallback[x.legacy_setting_key]||''}));
 return activeOnly?all.filter(x=>x.enabled&&x.visible&&x.receiver.trim()):all;
}
export async function paymentMethod(db,env,key){
 if(!/^[a-z][a-z0-9_]{0,31}$/.test(String(key||'')))return null;
 const m=await db.prepare('SELECT * FROM payment_methods WHERE method_key=?').bind(key).first();
 if(!m)return null;
 const receiver=m.receiver_ar || (m.legacy_setting_key?await getSetting(db,m.legacy_setting_key,String(env[defaults[key]]||'')):'');
 return {...m,receiver};
}
export function extractPaymentEmoji(message){
 const text=String(message.text||message.caption||'');
 const found=(message.entities||message.caption_entities||[]).find(e=>e.type==='custom_emoji'&&/^\d{10,30}$/.test(String(e.custom_emoji_id))&&e.offset>=0&&e.length>0&&e.offset+e.length<=text.length);
 return {id:found?.custom_emoji_id||null,fallback:found?text.slice(found.offset,found.offset+found.length):''};
}
export function paymentEntities(text,message){
 const entities=(message.entities||message.caption_entities||[]).filter(e=>e.type==='custom_emoji'&&/^\d{10,30}$/.test(String(e.custom_emoji_id))&&Number.isInteger(e.offset)&&e.offset>=0&&e.offset+e.length<=text.length).map(e=>({type:'custom_emoji',offset:e.offset,length:e.length,custom_emoji_id:String(e.custom_emoji_id)}));
 return JSON.stringify(entities);
}
