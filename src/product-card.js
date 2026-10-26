import {sendText,sendOrEditText,telegram} from './telegram.js';

// Native Telegram photo captions appear WITH the image and its buttons inside
// one chat bubble. The Bot API caps captions at 1024 UTF-16 code units.
// Preserve all the remaining text rather than silently trimming instructions,
// credentials or one-time delivery links.
export function cardEntities(text,labels,base=[]){
  const additions=[];
  for(const label of labels){
    const offset=text.indexOf(label);
    if(offset>=0)additions.push({type:'bold',offset,length:label.length});
  }
  return [...base.filter(e=>e.offset>=0&&e.offset+e.length<=text.length),...additions];
}
export function splitPhotoCaption(text,entities=[]){
  if(text.length<=1024)return {caption:text,remaining:'',captionEntities:entities,remainingEntities:[]};
  const cutAt=text.lastIndexOf('\n',995);
  const cut=cutAt>=450?cutAt+1:995;
  const caption=text.slice(0,cut);
  const remaining=text.slice(cut);
  // Bold spans may cross the 1024-caption boundary; clip each piece safely.
  // Custom emoji entities must remain intact to preserve Telegram UTF-16 offsets.
  const first=entities.flatMap(e=>{
    if(e.offset<0||e.offset>=cut)return [];
    if(e.offset+e.length<=cut)return [e];
    return e.type==='bold'?[{...e,length:cut-e.offset}]:[];
  });
  const second=entities.flatMap(e=>{
    if(e.offset+e.length<=cut||e.offset>=text.length)return [];
    if(e.offset>=cut)return [{...e,offset:e.offset-cut}];
    return e.type==='bold'?[{...e,offset:0,length:e.offset+e.length-cut}]:[];
  });
  return {caption,remaining,captionEntities:first,remainingEntities:second};
}
export async function sendPhotoCard(env,uid,photo,text,markup,options={}){
  const {entities=[],preserveText=false,messageId=null,onMessage=null}=options;
  if(!photo){
    const sent=await sendOrEditText(env,uid,text,markup,messageId,{entities,preserveText});
    if(onMessage&&sent)await onMessage(sent);
    return sent;
  }
  const parts=splitPhotoCaption(text,entities);
  const params={chat_id:uid,photo,caption:parts.caption,reply_markup:markup,
    ...(parts.captionEntities.length?{caption_entities:parts.captionEntities}:{}),
    ...(preserveText?{_preserve_text:true}:{})};
  let sent;
  // Edit captions only when the originating callback really came from media.
  // A normal text menu has no caption; skipping that invalid API call makes
  // the transition into a photo product card both faster and more reliable.
  const canEditCaption=Number.isSafeInteger(messageId)&&messageId>0 &&
    (!env.__callback_message_id || (env.__callback_media&&messageId===env.__callback_message_id));
  if(canEditCaption){
    try{
      const {photo:_photo,...edit}=params;
      sent=await telegram(env,'editMessageCaption',{...edit,message_id:messageId});
    }catch(error){
      if(/message is not modified/i.test(String(error)))return null;
      // Only media-caption mismatch/edit restrictions are safe to retry by
      // sending a new photo. Preserve other failures (e.g. rate limits).
      if(!/there is no caption|message to edit not found|message can't be edited|message identifier is not specified|message is not a media message|no media|message has no caption|message is not a photo message|message is not a photo or video/i.test(String(error)))throw error;
    }
  }
  if(!sent){
    try{sent=await telegram(env,'sendPhoto',params);}
    catch(error){
      // A bad/stale image must never hide the product, payment receipt or
      // delivery payload. The fallback is a complete, ordinary text card.
      if(!/400:|wrong file|photo|image|file_id/i.test(String(error)))throw error;
      const fallback=await sendOrEditText(env,uid,text,markup,null,{entities,preserveText});
      if(onMessage&&fallback)await onMessage(fallback);
      return fallback;
    }
  }
  if(onMessage&&sent)await onMessage(sent);
  if(parts.remaining){
    const more=await sendText(env,uid,parts.remaining,undefined,{entities:parts.remainingEntities,preserveText});
    if(onMessage&&more)await onMessage(more);
  }
  return sent;
}
