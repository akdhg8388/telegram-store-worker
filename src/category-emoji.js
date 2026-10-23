import {button} from './common.js';

// Keep the ordinary Unicode glyph as a fallback when Telegram rejects custom icons.
const VALID_CUSTOM=/^\d{10,30}$/;
const ICON_CHAR=/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;
export function parseCategoryEmoji(message){
  const raw=String(message?.text??'');
  const glyph=raw.trim();
  const clusters=Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(glyph));
  if(clusters.length!==1||!ICON_CHAR.test(glyph)||glyph.length>16)return null;
  const custom=(message.entities||[]).find(e=>e.type==='custom_emoji'
    && VALID_CUSTOM.test(String(e.custom_emoji_id||''))
    && Number.isInteger(e.offset)&&Number.isInteger(e.length)
    && e.offset>=0&&e.length>0&&raw.slice(e.offset,e.offset+e.length)===glyph);
  return {emoji:glyph,customEmojiId:custom?String(custom.custom_emoji_id):null};
}
export function categoryButton(category,label,action,style='primary'){
  const emoji=String(category.emoji||'🛍️');
  const fallback=emoji+' '+label;
  const id=category.custom_emoji_id;
  if(!VALID_CUSTOM.test(String(id||'')))return button(fallback,action,style);
  const result=button(label,action,style);
  result.icon_custom_emoji_id=String(id);
  result._emoji_fallback_text=fallback;
  return result;
}
