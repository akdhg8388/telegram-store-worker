import {button,keyboard,isAdmin} from './common.js';
import {sendText,sendOrEditText,flushOutbox} from './telegram.js';
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
export async function broadcastStats(db,jobId=null){
 const sql="SELECT j.id,j.kind,j.status,j.queued_count,j.cursor_user_id, "+
   "(SELECT COUNT(*) FROM notification_outbox o WHERE o.broadcast_job_id=j.id AND o.state='sent') AS sent_count, "+
   "(SELECT COUNT(*) FROM notification_outbox o WHERE o.broadcast_job_id=j.id AND o.state!='sent') AS waiting_count, "+
   "(SELECT COALESCE(SUM(CASE WHEN o.attempts>0 AND o.state!='sent' THEN 1 ELSE 0 END),0) FROM notification_outbox o WHERE o.broadcast_job_id=j.id) AS retry_count "+
   "FROM maintenance_broadcast_jobs j ";
 return jobId?db.prepare(sql+"WHERE j.id=?").bind(jobId).first():
   db.prepare(sql+"ORDER BY j.id DESC LIMIT 1").first();
}
export async function broadcastMenu(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return false;
 const [record,total]=await Promise.all([
   broadcastStats(db),db.prepare("SELECT COUNT(*) AS n FROM users").first()
 ]);
 const ready=Number(record?.queued_count||0);
 const status=record?
   '\n\n📊 الإعلان #'+record.id+' • '+(record.status==='pending'?'⏳ جارٍ تجهيز المستلمين':'✅ اكتمل إدراج المستلمين')+
   '\n👥 المستخدمون المسجلون: '+Number(total?.n||0)+
   '\n📥 أُدرج بالطابور: '+ready+
   '\n✅ تم الإرسال فعلياً: '+Number(record.sent_count||0)+
   '\n⏳ بانتظار الإرسال: '+Number(record.waiting_count||0)+
   '\n🔄 جاري إعادة المحاولة: '+Number(record.retry_count||0)+
   (record.status==='completed'&&Number(record.waiting_count||0)>0?'\n⚠️ انتهى إدراج المستلمين، لكن إيصال الرسائل لم يكتمل بعد.':''):
   '\n\nلا توجد إعلانات مُعتمدة حتى الآن.';
 return sendOrEditText(env,uid,'📢 النشر العام\n\nتستطيع إرسال إعلان بدون تفعيل وضع الصيانة.'+
   '\n✍️ النص والإيموجي يظهران بخط عريض.\n⚡ يبدأ إرسال أول دفعة عند التأكيد وتُستكمل الدفعات تدريجياً.'+status,
  keyboard(
    [button('📝 كتابة إعلان عام','broadcast_compose','success')],
    ...(record?[[button('🔄 تحديث حالة التوصيل','broadcast_menu','primary')],
      [button('🚀 استكمال الإعلان #'+record.id,'broadcast_resume:'+record.id,'success')]]:[]),
    adminBack),messageId);
}
export async function queueBroadcast(db,uid,body,kind='manual'){
 const value=broadcastBody(body);
 if(!value||!['manual','resume'].includes(kind))throw Error('INVALID_BROADCAST');
 const result=await db.prepare("INSERT INTO maintenance_broadcast_jobs(kind,body,created_by) VALUES(?,?,?)")
   .bind(kind,value,uid).run();
 return result.meta.last_row_id;
}
export async function broadcastAdminCallback(db,env,uid,data,messageId=null,ctx=null){
 if(!['broadcast_menu','broadcast_compose','broadcast_confirm','broadcast_cancel'].includes(data)&&
    !/^broadcast_resume:\d+$/.test(data))return false;
 if(!isAdmin(env,uid))return true;
 if(data==='broadcast_menu'){await broadcastMenu(db,env,uid,messageId);return true;}
 if(data.startsWith('broadcast_resume:')){
   const jobId=Number(data.slice('broadcast_resume:'.length));
   if(!Number.isSafeInteger(jobId)||jobId<=0)return true;
   const existing=await broadcastStats(db,jobId);
   if(!existing)return sendText(env,uid,'لا يوجد إعلان بهذا الرقم.');
   if(existing.status==='pending')await stageBroadcasts(db,jobId);
   // Fast bounded sends in the request's background; never block navigation.
   const dispatch=flushOutbox(db,env,8,jobId).catch(e=>console.error('Broadcast dispatch failed',jobId,String(e)));
   if(ctx?.waitUntil)ctx.waitUntil(dispatch);else await dispatch;
   await broadcastMenu(db,env,uid,messageId);
   return true;
 }
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
 // Start the first recipients on THIS click. Scheduled runs are a fallback,
 // not the only path to delivery. Every recipient is uniquely keyed in D1.
 await stageBroadcasts(db,jobId);
 const dispatch=flushOutbox(db,env,8,jobId).catch(e=>console.error('Broadcast first dispatch failed',jobId,String(e)));
 if(ctx?.waitUntil)ctx.waitUntil(dispatch);else await dispatch;
 return sendOrEditText(env,uid,'✅ تم اعتماد الإعلان #'+jobId+
   '\n🚀 بدأ تجهيز المستلمين وإرسال الدفعة الأولى.\n\nافتح متابعة الإعلان لمعرفة عدد الرسائل التي وصل إرسالها فعلياً.',keyboard(
   [button('📊 متابعة الإعلان','broadcast_menu','success')],adminBack),messageId);
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
export async function stageBroadcasts(db,jobId=null){
 const job=jobId?
   await db.prepare("SELECT id,body,cursor_user_id FROM maintenance_broadcast_jobs WHERE id=? AND status='pending'").bind(jobId).first():
   await db.prepare("SELECT id,body,cursor_user_id FROM maintenance_broadcast_jobs WHERE status='pending' ORDER BY id LIMIT 1").first();
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
 insert.push(db.prepare("UPDATE maintenance_broadcast_jobs SET cursor_user_id=MAX(cursor_user_id,?),queued_count=(SELECT COUNT(*) FROM notification_outbox WHERE broadcast_job_id=?) WHERE id=? AND status='pending'")
   .bind(newCursor,job.id,job.id));
 await db.batch(insert);
 return users.length;
}
