import {telegram} from './telegram.js';

// Store only bot-generated temporary top-up displays and customer evidence.
// Financial orders, receipts and unrelated chat history are not touched.
export async function trackTopupView(db,uid,message){
 const id=Number(message?.message_id??message);
 if(!Number.isSafeInteger(id)||id<=0)return;
 await db.prepare('INSERT OR IGNORE INTO topup_view_messages(user_tg_id,message_id) VALUES (?,?)').bind(uid,id).run();
}
export async function cleanTopupViews(db,env,uid){
 const entries=(await db.prepare('SELECT message_id FROM topup_view_messages WHERE user_tg_id=? ORDER BY message_id DESC LIMIT 60').bind(uid).all()).results||[];
 const done=[];
 for(let i=0;i<entries.length;i+=4){
  await Promise.all(entries.slice(i,i+4).map(async ({message_id})=>{
   try{await telegram(env,'deleteMessage',{chat_id:uid,message_id});done.push(message_id)}
   catch(e){if(/message to delete not found|message can't be deleted|message identifier is not specified|message_id_invalid/i.test(String(e)))done.push(message_id);}
  }));
 }
 if(done.length)await db.prepare('DELETE FROM topup_view_messages WHERE user_tg_id=? AND message_id IN ('+done.map(()=>'?').join(',')+')').bind(uid,...done).run();
 return done.length;
}
