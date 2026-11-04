import {button,keyboard,isAdmin} from './common.js';
import {telegram,sendText,sendOrEditText} from './telegram.js';
import {setSession,clearSession,audit} from './database.js';

const MAX_LENGTH=3500;
const BATCH_SIZE=20;
const adminBack=[button('🛠️ إدارة الصيانة','admin_maintenance','primary')];

export function broadcastBody(text){
 const body=String(text||'').trim();
 return body.length>=1&&body.length<=MAX_LENGTH?body:null;
}
export function broadcastOptions(text){
 return {entities:[{type:'bold',offset:0,length:String(text).length}],preserveText:true};
}
export async function broadcastMenu(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return false;
 const record=await db.prepare("SELECT id,status,queued_count,kind FROM maintenance_broadcast_jobs ORDER BY id DESC LIMIT 1").first();
 const status=record?'\n\n📊 آخر إرسال #'+record.id+': '+(record.status==='pending'?'⏳ جارٍ تجهيز الإرسال':'✅ اكتمل تجهيز الإرسال')+
   '\n📤 تم إدراج: '+record.queued_count+' مستلم':'';
 return sendOrEditText(env,uid,'📢 النشر العام\n\nاكتب رسالة خاصة بمتجرك مع الإيموجي؛ ستظهر للزبائن بخط عريض. \n'+
  '⚡ تُجهّز الرسائل على دفعات صغيرة في الخلفية من خلال الفحص المجدول، ولا يتم إرسالها قبل التأكيد.'+status,
  keyboard([button('📝 كتابة إعلان عام','broadcast_compose','success')],adminBack),messageId);
}
export async function queueBroadcast(db,uid,body,kind='manual'){
 const value=broadcastBody(body);
 if(!value||!['manual','resume'].includes(kind))throw Error('INVALID_BROADCAST');
 const result=await db.prepare("INSERT INTO maintenance_broadcast_jobs(kind,body,created_by) VALUES(?,?,?)")
   .bind(kind,value,uid).run();
 return result.meta.last_row_id;
}
export async function broadcastAdminCallback(db,env,uid,data,messageId=null){
 if(!['broadcast_menu','broadcast_compose','broadcast_confirm','broadcast_cancel'].includes(data))return false;
 if(!isAdmin(env,uid))return true;
 if(data==='broadcast_menu'){await broadcastMenu(db,env,uid,messageId);return true;}
 if(data==='broadcast_compose'){
   await setSession(db,uid,'owner_broadcast_compose');
   await sendText(env,uid,'📢 أرسل نص الإعلان العام (حتى 3500 حرف). يقبل الإيموجي ويظهر كله بخط عريض.\nلن يصل إلى الزبائن إلا بعد مراجعتك وتأكيدك. للإلغاء /cancel.');
   return true;
 }
 const session=await db.prepare("SELECT action,payload FROM user_sessions WHERE user_tg_id=?").bind(uid).first();
 if(session?.action!=='owner_broadcast_review')return sendText(env,uid,'انتهت هذه المعاينة. ابدأ إعلاناً جديداً.');
 const body=JSON.parse(session.payload||'{}').body;
 if(data==='broadcast_cancel'){
   await clearSession(db,uid);
   return sendText(env,uid,'❌ تم إلغاء الإعلان بدون إرسال.',keyboard(adminBack));
 }
 if(!broadcastBody(body))return sendText(env,uid,'⛔ النص غير صالح. لم يُرسل شيء.');
 const jobId=await queueBroadcast(db,uid,body);
 await clearSession(db,uid);
 await audit(db,uid,'start_broadcast','setting',jobId);
 return sendOrEditText(env,uid,'✅ تم اعتماد الإعلان #'+jobId+'\n\n⏳ سيتم تجهيزه تدريجياً ضمن طابور الرسائل المجدول، حتى لا تتباطأ استجابة البوت.',keyboard(adminBack),messageId);
}
export async function broadcastAdminText(db,env,uid,session,message){
 if(!isAdmin(env,uid)||session?.action!=='owner_broadcast_compose')return false;
 const body=broadcastBody(message.text);
 if(!body){
   await sendText(env,uid,'❌ أرسل رسالة نصية غير فارغة حتى 3500 حرف. يمكنك استخدام الإيموجي.');
   return true;
 }
 await setSession(db,uid,'owner_broadcast_review',{body});
 return sendText(env,uid,'👁️ معاينة الإعلان:\n\n'+body,keyboard(
   [button('✅ تأكيد النشر العام','broadcast_confirm','success')],
   [button('❌ عدم الإرسال','broadcast_cancel','danger')]),{
   // Make the user-authored text bold without parsing/escaping markdown.
   entities:[{type:'bold',offset:'👁️ معاينة الإعلان:\n\n'.length,length:body.length}],preserveText:true
 });
}
export async function stageBroadcasts(db){
 const job=await db.prepare("SELECT id,body,cursor_user_id FROM maintenance_broadcast_jobs WHERE status='pending' ORDER BY id LIMIT 1").first();
 if(!job)return 0;
 // Never enqueue thousands of messages in a webhook; process only a bounded
 // number per scheduled run. Unique(job,user) protects retries/restarts.
 const users=(await db.prepare('SELECT tg_id FROM users WHERE tg_id>? ORDER BY tg_id LIMIT ?').bind(job.cursor_user_id,BATCH_SIZE).all()).results||[];
 if(!users.length){
   await db.prepare("UPDATE maintenance_broadcast_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(job.id).run();
   return 0;
 }
 const bold=broadcastOptions(job.body);
 const insert=users.map(u=>db.prepare(
   "INSERT OR IGNORE INTO notification_outbox(method,payload,broadcast_job_id,broadcast_user_id) VALUES('sendMessage',?,?,?)")
   .bind(JSON.stringify({chat_id:u.tg_id,text:job.body,entities:bold.entities,_preserve_text:true}),job.id,u.tg_id));
 const newCursor=users[users.length-1].tg_id;
 insert.push(db.prepare("UPDATE maintenance_broadcast_jobs SET cursor_user_id=?,queued_count=(SELECT COUNT(*) FROM notification_outbox WHERE broadcast_job_id=?) WHERE id=? AND status='pending'")
   .bind(newCursor,job.id,job.id));
 await db.batch(insert);
 return users.length;
}
