import {button,keyboard,short,isAdmin,positiveInt,formatIQD} from './common.js';
import {sendText,sendOrEditText,queueNotification} from './telegram.js';
import {getUser,setSession,clearSession,audit} from './database.js';
import {baghdadDate} from './wallet.js';
import {suspensionTime,SUSPENSION_HOURS,restrictionLabel,cleanReason} from './moderation.js';

const home=()=>[button('↩️ لوحة المدير','admin','primary')];
const back=()=>[button('↩️ إدارة المستخدمين','admin_users','primary')];

export async function listUsers(db,env,uid,messageId=null){
  const list=(await db.prepare('SELECT * FROM users WHERE tg_id != ? ORDER BY joined_at DESC,tg_id DESC LIMIT 20').bind(Number(env.ADMIN_ID)).all()).results??[];
  return sendOrEditText(env,uid,'👥 إدارة المستخدمين\n\nاختر حساباً لمراجعته أو استخدم البحث بالمعرف الرقمي.',keyboard(
    ...list.map(u=>[button(`${u.is_blocked?'🚫':u.suspended_until>Date.now()/1000?'⏳':'👤'} ${short(u.first_name||u.username||String(u.tg_id),25)} • ${u.tg_id}`,`admin_user:${u.tg_id}`,'primary')]),
    [button('🔎 البحث عن مستخدم','admin_find_user','primary')],home()),messageId);
}
export async function userDetail(db,env,uid,id,messageId=null){
  const u=await getUser(db,id);
  if(!u)return sendText(env,uid,'لم يتم العثور على هذا المستخدم.');
  const rows=[];
  if(String(id)!==String(env.ADMIN_ID)){
    rows.push([button('🚫 حظر نهائي',`admin_ban:${id}`,'danger')]);
    rows.push([button('⏳ تعليق مؤقت',`admin_suspend:${id}`,'primary')]);
    if(u.is_blocked||u.suspended_until)rows.push([button('✅ رفع الحظر أو التعليق',`admin_unban:${id}`,'success')]);
  }
  rows.push(back(),home());
  return sendOrEditText(env,uid,`👤 ملف المستخدم\n\nالاسم: ${short(u.first_name,110)}\nالمعرّف: ${u.username?'@'+u.username:'غير متوفر'}\n🆔 ${id}\n💳 الرصيد: ${formatIQD(u.wallet_balance_iqd)}\n🗓️ التسجيل: ${baghdadDate(u.joined_at)}\n📌 الحالة: ${restrictionLabel(u)}${u.restriction_reason?'\n📝 السبب: '+short(u.restriction_reason,210):''}`,keyboard(...rows),messageId);
}
export async function handleUserCallback(db,env,uid,data,messageId=null){
  if(!/^(?:admin_users|admin_user:\d+|admin_user_toggle:\d+|admin_ban:\d+|admin_suspend:\d+|admin_suspend_hours:\d+:\d+|admin_suspend_custom:\d+|admin_confirm_ban:\d+|admin_confirm_suspend:\d+:\d+|admin_unban:\d+|admin_confirm_unban:\d+)$/.test(data))return false;
  if(!isAdmin(env,uid)){await sendText(env,uid,'⛔ غير مصرح.');return true;}
  if(data==='admin_users'){await listUsers(db,env,uid,messageId);return true}
  const [action,a,b]=data.split(':');const target=positiveInt(a);
  if(!target)return true;
  if(action==='admin_user'||action==='admin_user_toggle'){await userDetail(db,env,uid,target,messageId);return true}
  if(String(target)===String(env.ADMIN_ID)){await sendText(env,uid,'🚫 لا يمكن تقييد حساب المدير الأساسي.');return true}
  const user=await getUser(db,target);if(!user){await sendText(env,uid,'الحساب غير موجود.');return true}
  if(action==='admin_ban'){
    await setSession(db,uid,'owner_ban_reason',{target});
    await sendText(env,uid,`🚫 حظر نهائي للمستخدم ${target}\nاكتب سبب الحظر (حتى 220 حرفاً) أو - بدون سبب. ستظهر شاشة تأكيد قبل التنفيذ.`,keyboard([button('↩️ رجوع',`admin_user:${target}`,'primary')]));return true;
  }
  if(action==='admin_suspend'){
    return sendOrEditText(env,uid,`⏳ تعليق المستخدم ${target}\n\nاختر المدة المطلوبة:`,keyboard(
      ...SUSPENSION_HOURS.map(n=>[button(n>=24?`${n/24} يوم`:n+' ساعة',`admin_suspend_hours:${target}:${n}`,'primary')]),
      [button('✏️ مدة مخصصة بالساعات',`admin_suspend_custom:${target}`,'primary')],
      [button('↩️ رجوع',`admin_user:${target}`,'danger')]),messageId);
  }
  if(action==='admin_suspend_hours'){
    const hours=positiveInt(b);
    if(!SUSPENSION_HOURS.includes(hours))return true;
    await setSession(db,uid,'owner_suspend_reason',{target,hours});
    await sendText(env,uid,`📝 سبب تعليق ${target} لمدة ${hours} ساعة؟ أرسل سبباً حتى 220 حرفاً أو - بدون سبب.`,keyboard([button('↩️ رجوع',`admin_user:${target}`,'primary')]));return true;
  }
  if(action==='admin_suspend_custom'){
    await setSession(db,uid,'owner_suspend_custom',{target});
    await sendText(env,uid,'⏳ اكتب مدة التعليق بالساعات من 1 إلى 8760 ساعة.');return true;
  }
  if(action==='admin_confirm_ban'||action==='admin_confirm_suspend'){
    const session=await db.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=?').bind(uid).first();
    const payload=session?JSON.parse(session.payload):null;
    const expected=action==='admin_confirm_ban'?'owner_ban_confirm':'owner_suspend_confirm';
    if(session?.action!==expected || Number(payload?.target)!==target){await sendText(env,uid,'انتهت جلسة التأكيد، افتح المستخدم مجدداً.');return true}
    if(action==='admin_confirm_suspend'&&Number(b)!==Number(payload.hours))return true;
    const until=action==='admin_confirm_ban'?null:suspensionTime(Date.now(),payload.hours);
    if(action==='admin_confirm_suspend'&&!until)return true;
    const result=await db.prepare('UPDATE users SET is_blocked=?,suspended_until=?,restriction_reason=?,restricted_by=?,restricted_at=CURRENT_TIMESTAMP WHERE tg_id=? AND tg_id!=?')
      .bind(action==='admin_confirm_ban'?1:0,until,payload.reason||'',uid,target,Number(env.ADMIN_ID)).run();
    await clearSession(db,uid);
    if(result.meta?.changes){
      await audit(db,uid,action==='admin_confirm_ban'?'ban_permanent':'suspend_temporary','user',target);
      await queueNotification(db,'sendMessage',{chat_id:target,text:action==='admin_confirm_ban'?'🚫 تم تعليق إمكانية استخدام My Store بشكل دائم.':'⏳ تم تعليق إمكانية استخدام My Store حتى '+baghdadDate(new Date(until*1000).toISOString())});
    }
    await userDetail(db,env,uid,target,messageId);return true;
  }
  if(action==='admin_unban'){
    await sendOrEditText(env,uid,`هل تريد رفع الحظر والتعليق عن المستخدم ${target}؟`,keyboard([button('✅ تأكيد رفع التقييد',`admin_confirm_unban:${target}`,'success')],[button('↩️ رجوع',`admin_user:${target}`,'primary')]),messageId);return true;
  }
  if(action==='admin_confirm_unban'){
    await db.prepare('UPDATE users SET is_blocked=0,suspended_until=NULL,restriction_reason=\'\',restricted_by=NULL,restricted_at=NULL WHERE tg_id=? AND tg_id!=?')
      .bind(target,Number(env.ADMIN_ID)).run();
    await audit(db,uid,'unban','user',target);
    await queueNotification(db,'sendMessage',{chat_id:target,text:'✅ تمت إعادة تفعيل حسابك في My Store. يمكنك استخدام المتجر الآن.'});
    await userDetail(db,env,uid,target,messageId);return true;
  }
  return true;
}
export async function handleUserText(db,env,uid,session,message){
  if(!isAdmin(env,uid))return false;
  if(!['owner_ban_reason','owner_suspend_custom','owner_suspend_reason'].includes(session.action))return false;
  const target=positiveInt(session.payload?.target);
  if(!target||String(target)===String(env.ADMIN_ID)){await clearSession(db,uid);return true}
  const value=String(message.text||'').trim();
  if(session.action==='owner_suspend_custom'){
    const hours=Number(value);
    if(!Number.isSafeInteger(hours)||hours<1||hours>8760){await sendText(env,uid,'أدخل رقماً من 1 إلى 8760 ساعة.');return true}
    await setSession(db,uid,'owner_suspend_reason',{target,hours});
    await sendText(env,uid,`📝 اكتب سبب تعليق ${target} لمدة ${hours} ساعة، أو - بدون سبب.`);return true;
  }
  const reason=cleanReason(value);
  if(reason===null){await sendText(env,uid,'السبب يجب ألا يتجاوز 220 حرفاً. أرسل - إن أردت عدم ذكر سبب.');return true}
  const ban=session.action==='owner_ban_reason';
  const hours=session.payload.hours;
  await setSession(db,uid,ban?'owner_ban_confirm':'owner_suspend_confirm',{target,reason,hours});
  const callback=ban?`admin_confirm_ban:${target}`:`admin_confirm_suspend:${target}:${hours}`;
  await sendText(env,uid,`⚠️ مراجعة القرار قبل التنفيذ\n👤 المستخدم: ${target}\n📌 الإجراء: ${ban?'حظر نهائي':'تعليق لمدة '+hours+' ساعة'}\n📝 السبب: ${reason||'غير محدد'}\n\nلن يتغير رصيد المحفظة أو الطلبات.`,keyboard([button('✅ تنفيذ القرار',callback,'danger')],[button('↩️ إلغاء','admin_users','primary')]));
  return true;
}
