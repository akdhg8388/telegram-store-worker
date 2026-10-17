import {getSetting} from './settings.js';

// Financial values and identities come from D1. Editors only change presentation.
// {balance} displays exactly one preferred currency, without a second conversion.
export const DEFAULT_HOME_TEMPLATE_EN=`👋 Welcome to {store}!\n\nBuy digital products instantly from our store.\n\n💰 Your balance: {balance}\n👤 Name: {name}\n🆔 ID: {id}\n👥 Users: {users}`;
export const DEFAULT_HOME_TEMPLATE=`👋 أهلاً بك في {store}!\n\nاشترِ المنتجات الرقمية مباشرة من هنا.\n\n💰 رصيدك: {balance}\n👤 الاسم: {name}\n🆔 المعرّف: {id}\n👥 المستخدمون: {users}`;

export const UI_EMOJI_SETTINGS=Object.freeze({
  home:'home_custom_emoji_id',shop:'shop_custom_emoji_id',
  profile:'profile_custom_emoji_id',wallet:'wallet_custom_emoji_id',
  orders:'orders_custom_emoji_id',support:'support_custom_emoji_id'
});
const PLACEHOLDER=/\{(store|balance|balance_iqd|balance_usd|name|id|users|instructions)\}/g;
const INLINE_EMOJI=/\[\[emoji:(\d{10,30})\|([^\]\r\n]{1,16})\]\]/g;
const HOME_BOLD_LABELS=['رصيدك:','الاسم:','المعرّف:','المستخدمون:','Your balance:','Name:','ID:','Users:'];

export function renderHomeTemplate(template,values){
  // Upgrade the V9 default balance fragment even if it was saved as an owner template.
  // Other owner edits and placeholders are preserved.
  const oldBalance=/IQD\s*\{balance_iqd\}\s*\(≡\s*\$\{balance_usd\}\s*USD\)/g;
  return String(template||DEFAULT_HOME_TEMPLATE).replace(oldBalance,'{balance}')
    .replace(PLACEHOLDER,(_match,key)=>String(values[key]??''))
    .slice(0,3800);
}
export function decimalMoney(value){return Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}

// Convert the real Telegram custom_emoji entities sent by the owner into stable
// inline markers. Offsets in Telegram are UTF-16 (JS string) code units.
// Plain values/placeholder text can later change length without breaking spans.
export function preserveCustomEmojiInTemplate(text,entities=[]){
  let encoded=String(text??'');
  let before=encoded.length+1;
  const customs=(Array.isArray(entities)?entities:[])
    .filter(e=>e?.type==='custom_emoji' && /^\d{10,30}$/.test(String(e.custom_emoji_id)) &&
      Number.isInteger(e.offset)&&Number.isInteger(e.length)&&e.length>0)
    .sort((a,b)=>b.offset-a.offset);
  for(const e of customs){
    if(e.offset<0 || e.offset+e.length>before-1 || e.offset+e.length>encoded.length)continue;
    const symbol=encoded.slice(e.offset,e.offset+e.length);
    if(!symbol || symbol.includes(']') || symbol.includes('\n') || symbol.length>16)continue;
    encoded=encoded.slice(0,e.offset)+`[[emoji:${e.custom_emoji_id}|${symbol}]]`+encoded.slice(e.offset+e.length);
    before=e.offset;
  }
  return encoded;
}

// Parse inline custom emoji after substituting changing user values, then apply
// bold entities to the exact labels. No HTML/Markdown injection is possible.
export function homeTextAndEntities(rendered){
  const source=String(rendered??'');
  let text='',entities=[],index=0;
  for(const found of source.matchAll(INLINE_EMOJI)){
    text+=source.slice(index,found.index);
    const offset=text.length;
    text+=found[2];
    entities.push({type:'custom_emoji',offset,length:found[2].length,custom_emoji_id:found[1]});
    index=found.index+found[0].length;
  }
  text+=source.slice(index);
  // Bold the main greeting and field names; keep user-generated values normal.
  const firstEnd=text.indexOf('\n');
  const headingLength=firstEnd>=0?firstEnd:text.length;
  if(headingLength>0 && headingLength<=150 && /أهلاً|مرحبا|مرحباً|Welcome/.test(text.slice(0,headingLength)))
    entities.push({type:'bold',offset:0,length:headingLength});
  for(const label of HOME_BOLD_LABELS){
    const offset=text.indexOf(label);
    if(offset>=0)entities.push({type:'bold',offset,length:label.length});
  }
  return {text,entities};
}

// Telegram custom emoji entities refer to real custom_emoji_id values, not GIFs.
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

export async function decoratedHome(db,text,customEmojiValue=null){
  const formatted=homeTextAndEntities(text);
  const setting=customEmojiValue===null?await getSetting(db,'home_custom_emoji_id',''):customEmojiValue;
  if(/^\d{10,30}$/.test(setting)){
    const first=Array.from(new Intl.Segmenter('ar',{granularity:'grapheme'}).segment(formatted.text))[0]?.segment||'';
    const symbol=/\p{Extended_Pictographic}/u.test(first)?first:'✨';
    if(symbol!==first){
      formatted.text='✨ '+formatted.text;
      formatted.entities=formatted.entities.map(e=>({...e,offset:e.offset+2}));
    }
    // Explicit inline custom emoji has priority if placed at the beginning.
    if(!formatted.entities.some(e=>e.type==='custom_emoji' && e.offset===0))
      formatted.entities.unshift({type:'custom_emoji',offset:0,length:symbol.length,custom_emoji_id:setting});
  }
  // Prevent invalid offsets if Telegram text size is close to the maximum.
  const max=3900;
  if(formatted.text.length>max)formatted.text=formatted.text.slice(0,max);
  const entities=formatted.entities.filter(e=>e.offset>=0 && e.offset+e.length<=formatted.text.length);
  return {text:formatted.text,options:{entities}};
}

// Product heading, price and stock can each have a real Telegram custom emoji
// entity; icons on inline buttons are a separate Bot API feature.
export function decorateProductText(text,icons={}){
  const entries=[['product','🛍️'],['price','💰'],['stock','📦']];
  const entities=[];
  for(const [kind,symbol] of entries){
    const id=icons[kind];
    if(!/^\d{10,30}$/.test(String(id||'')))continue;
    const position=text.indexOf(symbol);
    if(position>=0)entities.push({type:'custom_emoji',offset:position,length:symbol.length,custom_emoji_id:String(id)});
  }
  return {text,options:entities.length?{entities}:{}};
}
