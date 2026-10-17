// V16 experiment: Rich Message buttons keep a pasted custom emoji INSIDE the
// label, preserving its logical position for RTL text instead of moving it
// into InlineKeyboardButton.icon_custom_emoji_id. No DB changes are needed.
const validEmoji=id=>/^\d{10,30}$/.test(String(id||''));
const custom=(id,alt)=>({type:'custom_emoji',custom_emoji_id:String(id),alternative_text:alt||'✨'});

export function richHomeNeeded(rows){
  return rows.some(row=>row.some(b=>{
    if(!validEmoji(b?.icon_custom_emoji_id)||!b?._emoji_fallback_text)return false;
    const at=b._emoji_fallback_text.indexOf(b.text);
    return at>0 && b._emoji_fallback_text.slice(0,at).trim().length>0;
  }));
}

export function richHomeButton(btn){
  let text=btn.text;
  if(validEmoji(btn.icon_custom_emoji_id)){
    const fallback=btn._emoji_fallback_text;
    const at=typeof fallback==='string'?fallback.indexOf(btn.text):-1;
    if(at>=0){
      const before=fallback.slice(0,at),after=fallback.slice(at+btn.text.length);
      if(before.trim()&&!after.trim()){
        const glyph=before.trim();
        text=[custom(btn.icon_custom_emoji_id,glyph),before.slice(glyph.length),btn.text].filter(x=>x!=='');
      }else if(after.trim()&&!before.trim()){
        const glyph=after.trim();
        text=[btn.text,after.slice(0,after.length-glyph.length),custom(btn.icon_custom_emoji_id,glyph)].filter(x=>x!=='');
      }else text=[custom(btn.icon_custom_emoji_id,'✨'),' ',btn.text];
    }else text=[custom(btn.icon_custom_emoji_id,'✨'),' ',btn.text];
  }
  // RichMessageButton accepts the same callback and URL actions as inline buttons.
  return {text,...(btn.style?{style:btn.style}:{}),
    ...(btn.callback_data?{callback_data:btn.callback_data}:{}),
    ...(btn.url?{url:btn.url}:{})};
}

export function richHomeText(text,entities=[]){
  // Preserve greeting and field-name bold entities, and owner-supplied custom
  // emojis. Bot API offsets are UTF-16 code units, as are JS string positions.
  const valid=entities.filter(e=>Number.isInteger(e.offset)&&Number.isInteger(e.length)
    &&e.offset>=0&&e.length>0&&e.offset+e.length<=text.length
    &&(e.type==='bold'||(e.type==='custom_emoji'&&validEmoji(e.custom_emoji_id))));
  const cuts=[...new Set([0,text.length,...valid.flatMap(e=>[e.offset,e.offset+e.length])])].sort((a,b)=>a-b);
  const parts=[];
  for(let n=1;n<cuts.length;n++){
    const start=cuts[n-1],end=cuts[n];
    if(end===start)continue;
    const content=text.slice(start,end);
    const emoji=valid.find(e=>e.type==='custom_emoji'&&e.offset<=start&&e.offset+e.length>=end);
    const bold=valid.some(e=>e.type==='bold'&&e.offset<=start&&e.offset+e.length>=end);
    let part=emoji?custom(emoji.custom_emoji_id,content):content;
    if(bold)part={type:'bold',text:part};
    parts.push(part);
  }
  return parts.length===1?parts[0]:parts;
}

export function richHomeMessage(text,entities,rows){
  return {is_rtl:true,blocks:[
    {type:'paragraph',text:richHomeText(text,entities)},
    ...rows.filter(row=>row.length).map(row=>({
      type:'buttons',align:'center',buttons:row.map(richHomeButton)
    }))
  ]};
}
