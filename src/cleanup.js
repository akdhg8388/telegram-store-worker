import {telegram} from './telegram.js';

// Keep presentation cleanup separate from D1 financial and support records.
// Incoming message IDs may be deleted from a private conversation within Telegram's allowed window.
export async function trackChatMessage(db,uid,messageId,direction='incoming'){
  if(!Number.isSafeInteger(Number(uid)) || !Number.isSafeInteger(messageId) || messageId<=0)return;
  await db.prepare(`INSERT OR IGNORE INTO chat_cleanup_messages(user_tg_id,message_id,direction)
    VALUES (?,?,?)`).bind(uid,messageId,direction).run();
}

export async function cleanChatOnHome(db,env,uid){
  // Telegram deleteMessages can remove up to 100 at once. Keep an upper bound to
  // avoid blocking updates on accounts with huge conversations.
  await db.prepare("DELETE FROM chat_cleanup_messages WHERE created_at < datetime('now','-47 hours')").run();
  const records=(await db.prepare(`SELECT message_id FROM chat_cleanup_messages
    WHERE user_tg_id=? ORDER BY message_id DESC LIMIT 80`).bind(uid).all()).results??[];
  const ids=records.map(r=>r.message_id).filter(n=>Number.isSafeInteger(n)&&n>0);
  if(!ids.length)return {deleted:0,failed:0};
  let deleted=0, failed=0;
  // Try batches first, falling back to per-message deletion for older/unavailable IDs.
  for(let start=0;start<ids.length;start+=40){
    const batch=ids.slice(start,start+40);
    let successful=[];
    try{
      const ok=await telegram(env,'deleteMessages',{chat_id:uid,message_ids:batch});
      if(ok===true)successful=batch;
    }catch{}
    if(successful.length!==batch.length){
      successful=[];
      for(const id of batch){
        try{if(await telegram(env,'deleteMessage',{chat_id:uid,message_id:id})===true)successful.push(id)}
        catch{failed++}
      }
    }
    if(successful.length){
      // Parameterized SQL; no chat text, proof, balances or financial records touched.
      await db.prepare(`DELETE FROM chat_cleanup_messages WHERE user_tg_id=? AND message_id IN (${successful.map(()=>'?').join(',')})`)
        .bind(uid,...successful).run();
      deleted+=successful.length;
    }
  }
  return {deleted,failed};
}
