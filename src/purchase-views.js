import {telegram} from './telegram.js';

// Only ephemeral purchase receipts, their photographs and the confirmation message.
// Do not register home menus, ordinary navigation, incoming customer messages or any financial records.
export async function trackPurchaseView(db,uid,message){
  const id=message?.message_id;
  if(!Number.isSafeInteger(id)||id<=0)return;
  try {
    await db.prepare('INSERT OR IGNORE INTO purchase_view_messages(user_tg_id,message_id) VALUES (?,?)').bind(uid,id).run();
  } catch(e) {console.error('Purchase-view tracking failed',String(e));}
}

export async function readPurchaseViewIds(db,uid){
  const data=await db.prepare('SELECT message_id FROM purchase_view_messages WHERE user_tg_id=? ORDER BY message_id DESC LIMIT 80').bind(uid).all();
  return (data.results??[]).map(x=>x.message_id);
}

// Called exclusively by the Home inline button. The selected message is edited into Home,
// so it must NEVER be deleted. Telegram may refuse old messages; don't hide that error.
export async function cleanupPurchaseViews(db,env,uid,messageIds,homeMessageId=null){
  const ids=[...new Set(messageIds.filter(n=>Number.isSafeInteger(n)&&n>0))];
  const exempt=Number.isSafeInteger(homeMessageId)?homeMessageId:null;
  const deleted=[];
  if(exempt!==null && ids.includes(exempt))deleted.push(exempt);
  const toDelete=ids.filter(n=>n!==exempt);
  // Small bounded parallel groups: speedy while avoiding a request burst.
  for(let i=0;i<toDelete.length;i+=4){
    await Promise.all(toDelete.slice(i,i+4).map(async message_id=>{
      try {
        await telegram(env,'deleteMessage',{chat_id:uid,message_id});
        deleted.push(message_id);
      } catch(e){
        // Old/previously-deleted messages cannot be removed. Do not retry them forever.
        if(/message to delete not found|message can't be deleted|message identifier is not specified|message_id_invalid/i.test(String(e))){
          deleted.push(message_id);
        } else console.error('Temporary purchase message deletion failed',message_id,String(e));
      }
    }));
  }
  if(deleted.length){
    // One indexed D1 write. Only delete tracked display IDs, never orders or wallet data.
    const placeholders=deleted.map(()=>'?').join(',');
    await db.prepare(`DELETE FROM purchase_view_messages WHERE user_tg_id=? AND message_id IN (${placeholders})`).bind(uid,...deleted).run();
  }
  return {attempted:toDelete.length,removed:deleted.length};
}
