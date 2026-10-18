import {button,keyboard,short,isAdmin,positiveInt} from './common.js';
import {sendText,sendOrEditText,telegram,queueNotification,flushOutbox} from './telegram.js';
import {setSession,clearSession,getUser,audit} from './database.js';
import {baghdadDate} from './wallet.js';
import {decoratedMessage} from './presentation.js';
import {getSetting} from './settings.js';
import {homeSettingKey} from './home-buttons.js';
import {choice,languageOf} from './i18n.js';

const back=()=>[button('↩️ رجوع إلى الرسائل','support_inbox','danger')];
const adminBack=()=>[button('🛡️ لوحة الإدارة','admin','primary')];
function preview(row){
  return row.kind==='text'?short(row.body,80):row.kind==='photo'?'📷 صورة'+(row.body?' — '+short(row.body,50):''):'🎬 فيديو'+(row.body?' — '+short(row.body,50):'');
}
function media(message){
  if(message.video?.file_id)return {kind:'video',fileId:message.video.file_id,body:short(message.caption||'',900)};
  if(message.photo?.length)return {kind:'photo',fileId:message.photo.at(-1).file_id,body:short(message.caption||'',900)};
  const txt=String(message.text||'').trim();
  if(txt.length>=1&&txt.length<=3000)return {kind:'text',fileId:null,body:txt};
  return null;
}
export async function submitSupport(db,env,ctx,uid,message){
  const content=media(message);
  if(!content)return sendText(env,uid,'أرسل رسالة نصية أو صورة أو فيديو مع وصف اختياري (حتى 3000 حرف للنص).');
  const r=await db.prepare(`INSERT OR IGNORE INTO support_messages(user_tg_id,direction,kind,body,telegram_file_id,customer_message_id,is_unread)
    VALUES (?,'incoming',?,?,?,?,1)`)
    .bind(uid,content.kind,content.body,content.fileId,message.message_id||null).run();
  if(!r.meta?.changes)return sendText(env,uid,'✅ وصلتنا هذه الرسالة سابقاً.');
  const itemId=r.meta.last_row_id;
  const user=await getUser(db,uid);
  const date=(await db.prepare('SELECT created_at FROM support_messages WHERE id=?').bind(itemId).first()).created_at;
  const note=`📨 رسالة دعم جديدة #${itemId}\n👤 ${short(user?.first_name||'مستخدم',80)} ${user?.username?'@'+user.username:''}\n🆔 ${uid}\n🗓️ ${baghdadDate(date)}\n\n${preview({...content})}`;
  const markup=keyboard([button('💬 فتح المحادثة',`support_thread:${uid}`,'primary')]);
  for(const admin of String(env.ADMIN_ID||'').split(',').filter(s=>/^\d+$/.test(s))){
    const payload={chat_id:admin,...(content.kind==='text'?{text:short(note,3900)}:{[content.kind]:content.fileId,caption:short(note,950)}),reply_markup:markup};
    await queueNotification(db,content.kind==='text'?'sendMessage':content.kind==='photo'?'sendPhoto':'sendVideo',payload,{supportMessageId:itemId});
  }
  ctx.waitUntil(flushOutbox(db,env));
  return sendText(env,uid,'✅ وصلتنا رسالتك بنجاح. سيصلك الرد هنا عند معالجتها.',keyboard([button('🏠 الرئيسية','home','primary')]));
}
export async function inbox(db,env,uid,messageId=null){
  const threads=(await db.prepare(`SELECT m.user_tg_id, MAX(m.id) latest,COUNT(*) total,
    SUM(CASE WHEN m.direction='incoming' AND m.is_unread=1 THEN 1 ELSE 0 END) unread,
    u.first_name,u.username
    FROM support_messages m JOIN users u ON u.tg_id=m.user_tg_id
    GROUP BY m.user_tg_id ORDER BY latest DESC LIMIT 25`).all()).results??[];
  const rows=threads.map(t=>[button(`${t.unread?'🔴 '+t.unread+' • ':'💬 '}${short(t.first_name||t.username||String(t.user_tg_id),25)} • ${t.user_tg_id}`,`support_thread:${t.user_tg_id}`,'primary')]);
  rows.push([button('🔄 تحديث','support_inbox','primary')],adminBack());
  const decorated=await decoratedMessage(db,'support',`📨 صندوق الدعم الفني\n\n${threads.length?'اختر مستخدماً لعرض المحادثة والرد على رسائله.':'لا توجد رسائل دعم بعد.'}`);
  return sendOrEditText(env,uid,decorated.text,keyboard(...rows),messageId,decorated.options);
}
export async function thread(db,env,uid,target,messageId=null){
  const u=await getUser(db,target);
  if(!u)return sendText(env,uid,'المستخدم غير موجود.');
  const messages=(await db.prepare('SELECT * FROM support_messages WHERE user_tg_id=? ORDER BY id DESC LIMIT 15').bind(target).all()).results??[];
  await db.prepare("UPDATE support_messages SET is_unread=0 WHERE user_tg_id=? AND direction='incoming'").bind(target).run();
  const txt=messages.slice().reverse().map(m=>`#${m.id} ${m.direction==='incoming'?'👤 العميل':'🎧 الدعم'} • ${baghdadDate(m.created_at)}\n${preview(m)}`).join('\n\n');
  const rows=messages.filter(m=>m.kind!=='text').slice(0,6).map(m=>[button(`📎 عرض ${m.kind==='photo'?'الصورة':'الفيديو'} #${m.id}`,`support_media:${m.id}`,'primary')]);
  rows.push([button('↩️ الرد',`support_reply:${target}`,'success')]);
  rows.push([button('🗑️ حذف رسالة محددة',`support_select_delete:${target}`,'primary')]);
  rows.push([button('🗑️ حذف المحادثة من السجل',`support_delete_local:${target}`,'danger')]);
  rows.push([button('🗑️ محاولة الحذف من الطرفين',`support_delete_both:${target}`,'danger')]);
  rows.push(back(),adminBack());
  return sendOrEditText(env,uid,`📨 محادثة الدعم\n👤 ${short(u.first_name,80)}\n🔗 ${u.username?'@'+u.username:'بدون معرف'}\n🆔 ${target}\n\n${txt||'لا توجد رسائل.'}`,keyboard(...rows),messageId);
}
function deleteTarget(row){return row.customer_message_id;}
async function deleteTelegramMessage(env,chatId,messageId){
  if(!Number.isSafeInteger(messageId)||messageId<=0)return false;
  try{return Boolean(await telegram(env,'deleteMessage',{chat_id:chatId,message_id:messageId}));}
  catch{return false}
}
// Only removes locally if requested, or if the known Telegram message copies were removed.
async function deleteFromTelegram(db,env,uid,records){
  let fully=0,partial=0,failed=0;
  for(const m of records){
    const targets=[{chat:uid,msg:deleteTarget(m)}];
    if(m.admin_notice_message_id)targets.push({chat:Number(env.ADMIN_ID),msg:m.admin_notice_message_id});
    const results=await Promise.all(targets.map(t=>deleteTelegramMessage(env,t.chat,t.msg)));
    // Old messages may have no tracked notice ID. Never promise their copies are deleted.
    if(results.every(Boolean) && targets.length===2){
      await db.prepare('DELETE FROM support_messages WHERE id=? AND user_tg_id=?').bind(m.id,uid).run();fully++;
    }else if(results.some(Boolean)){partial++;}
    else failed++;
  }
  return {fully,partial,failed};
}
export async function handleSupportCallback(db,env,uid,data,messageId=null){
  if(!/^(?:support_inbox|support_thread:\d+|support_reply:\d+|support_media:\d+|support_select_delete:\d+|support_delete_one:\d+|support_confirm_one:\d+|support_delete_local:\d+|support_delete_both:\d+|support_confirm_local:\d+|support_confirm_both:\d+)$/.test(data))return false;
  if(!isAdmin(env,uid)){await sendText(env,uid,'⛔ هذا القسم للمدير فقط.');return true;}
  if(data==='support_inbox'){await inbox(db,env,uid,messageId);return true}
  const [action,raw]=data.split(':');const id=positiveInt(raw);
  if(!id)return true;
  if(action==='support_thread'){await thread(db,env,uid,id,messageId);return true}
  if(action==='support_reply'){
    if(!await getUser(db,id))return true;
    await setSession(db,uid,'owner_support_reply',{target:id});
    await sendText(env,uid,`↩️ أرسل الرد الآن للمستخدم ${id}.\nيمكنك إرسال نص أو صورة أو فيديو. للإلغاء /cancel.`,keyboard([button('↩️ رجوع للمحادثة',`support_thread:${id}`,'danger')]));return true;
  }
  if(action==='support_media'){
    const item=await db.prepare('SELECT * FROM support_messages WHERE id=?').bind(id).first();
    if(!item?.telegram_file_id)return true;
    const method=item.kind==='photo'?'sendPhoto':item.kind==='video'?'sendVideo':null;
    if(method)await telegram(env,method,{chat_id:uid,[item.kind]:item.telegram_file_id,caption:short('📎 مرفق رسالة #'+item.id+' • '+baghdadDate(item.created_at),900)});
    return true;
  }
  if(action==='support_select_delete'){
    const messages=(await db.prepare('SELECT id FROM support_messages WHERE user_tg_id=? ORDER BY id DESC LIMIT 10').bind(id).all()).results??[];
    await sendOrEditText(env,uid,'🗑️ اختر الرسالة لحذفها من سجل الدعم:',keyboard(...messages.map(m=>[button('🗑️ رسالة #'+m.id,`support_delete_one:${m.id}`,'danger')]),[button('↩️ رجوع للمحادثة',`support_thread:${id}`,'primary')]),messageId);return true;
  }
  if(action==='support_delete_one'){
    const m=await db.prepare('SELECT * FROM support_messages WHERE id=?').bind(id).first();if(!m)return true;
    await sendOrEditText(env,uid,'⚠️ تأكيد حذف الرسالة #'+id+' من سجل الدعم فقط؟',keyboard([button('✅ حذف الرسالة',`support_confirm_one:${id}`,'danger')],[button('↩️ رجوع للمحادثة',`support_thread:${m.user_tg_id}`,'primary')]),messageId);return true;
  }
  if(action==='support_confirm_one'){
    const m=await db.prepare('SELECT user_tg_id FROM support_messages WHERE id=?').bind(id).first();if(!m)return true;
    await db.prepare('DELETE FROM support_messages WHERE id=?').bind(id).run();
    await audit(db,uid,'support_delete_one','support',id);
    await thread(db,env,uid,m.user_tg_id,messageId);return true;
  }
  if(action==='support_delete_local'||action==='support_delete_both'){
    const both=action==='support_delete_both';
    await sendOrEditText(env,uid,both?'⚠️ سيحاول البوت حذف الرسائل المتعقبة من المحادثتين. تيليجرام قد يرفض الرسائل الأقدم من 48 ساعة، وبعض النسخ لا يمكن تتبعها. لن نؤكد الحذف الكامل إلا للرسائل التي تحققنا من حذفها.':'⚠️ سيُحذف سجل الدعم المخزن في المتجر فقط. لا تُحذف نسخ الرسائل داخل تيليجرام.',keyboard([button(both?'✅ ابدأ محاولة الحذف':'✅ حذف السجل',`${both?'support_confirm_both':'support_confirm_local'}:${id}`,'danger')],[button('↩️ رجوع',`support_thread:${id}`,'primary')]),messageId);return true;
  }
  if(action==='support_confirm_local'){
    await db.prepare('DELETE FROM support_messages WHERE user_tg_id=?').bind(id).run();
    await audit(db,uid,'support_delete_local','user',id);
    await inbox(db,env,uid,messageId);return true;
  }
  if(action==='support_confirm_both'){
    const recent=(await db.prepare('SELECT * FROM support_messages WHERE user_tg_id=? ORDER BY id DESC LIMIT 20').bind(id).all()).results??[];
    const result=await deleteFromTelegram(db,env,id,recent);
    await audit(db,uid,'support_delete_both_attempt','user',id);
    return sendOrEditText(env,uid,`🗑️ نتيجة محاولة الحذف من تيليجرام\n\n✅ تأكد حذف النسخ المتعقبة: ${result.fully}\n⚠️ حذف جزئي: ${result.partial}\n❌ تعذر الحذف أو التحقق: ${result.failed}\n\nلم تُحذف السجلات المتعذرة تلقائياً. يمكنك إعادة المحاولة أو حذف السجل المحلي.`,keyboard([button('🔄 مراجعة المتبقي',`support_thread:${id}`,'primary')],back()),messageId);
  }
  return true;
}
export async function handleSupportReply(db,env,uid,session,message){
  if(!isAdmin(env,uid)||session.action!=='owner_support_reply')return false;
  const target=positiveInt(session.payload?.target);
  if(!target||!await getUser(db,target)){await clearSession(db,uid);return true;}
  const content=media(message);
  if(!content){await sendText(env,uid,'أرسل نصاً أو صورة أو فيديو صالحاً.');return true;}
  const params={chat_id:target,...(content.kind==='text'?{text:'🎧 رد الدعم:\n\n'+content.body}:{[content.kind]:content.fileId,caption:short('🎧 رد الدعم'+(content.body?'\n\n'+content.body:''),950)})};
  let sent;
  try{sent=await telegram(env,content.kind==='text'?'sendMessage':content.kind==='photo'?'sendPhoto':'sendVideo',params)}
  catch(error){await sendText(env,uid,'⚠️ تعذر إرسال الرد؛ لم يتم اعتباره مُرسلاً. تحقق من حظر العميل للبوت وحاول مجدداً.');return true;}
  await db.prepare("INSERT INTO support_messages(user_tg_id,direction,kind,body,telegram_file_id,customer_message_id,admin_notice_message_id) VALUES (?,'outgoing',?,?,?,?,?)")
    .bind(target,content.kind,content.body,content.fileId,sent.message_id||null,message.message_id||null).run();
  await clearSession(db,uid);
  await sendText(env,uid,`✅ وصل رد الدعم للمستخدم ${target}.`,keyboard([button('💬 فتح المحادثة',`support_thread:${target}`,'primary')],back()));
  return true;
}

// Customer view. Every query uses the authenticated Telegram user ID; a user
// can never request or enumerate a different customer's support conversation.
export async function customerInbox(db,env,uid,messageId=null){
  const count=await db.prepare('SELECT COUNT(*) n FROM support_messages WHERE user_tg_id=?').bind(uid).first();
  const latest=await db.prepare('SELECT kind,direction,created_at FROM support_messages WHERE user_tg_id=? ORDER BY id DESC LIMIT 1').bind(uid).first();
  const en=languageOf(env)==='en';
  const defaultDescription=choice(env,'يمكنك مراجعة رسائلك وردود الإدارة والصور والفيديوهات وتاريخ كل رسالة.','Review your messages, support replies, photos, videos and message dates.');
  const description=await getSetting(db,homeSettingKey('messages',en?'description_en':'description_ar'),defaultDescription);
  const heading=choice(env,'📨 رسائلي — الدعم الفني','📨 My Messages — Support');
  const countLabel=choice(env,'📩 الرسائل المحفوظة: ','📩 Saved messages: ');
  const latestLabel=choice(env,'\n🕓 آخر تواصل: ','\n🕓 Last contact: ');
  const decorated=await decoratedMessage(db,'support',`${heading}\n\n${countLabel}${count?.n||0}${latest?latestLabel+baghdadDate(latest.created_at):''}\n\n${description||defaultDescription}`);
  return sendOrEditText(env,uid,decorated.text,keyboard(
    [button(choice(env,'💬 فتح سجل المحادثة','💬 View Conversation'),'my_support_thread:0','primary')],
    [button(choice(env,'✉️ رسالة جديدة للدعم','✉️ New Support Message'),'my_support_new','success')],
    [button(choice(env,'🏠 الرجوع للرئيسية','🏠 Back to Home'),'home','danger')]),messageId,{...decorated.options,preserveText:en});
}
export async function customerThread(db,env,uid,page=0,messageId=null){
  const offset=Math.max(0,Math.min(page,200))*8;
  const messages=(await db.prepare('SELECT * FROM support_messages WHERE user_tg_id=? ORDER BY id DESC LIMIT 9 OFFSET ?').bind(uid,offset).all()).results??[];
  const segment=messages.slice(0,8);
  // Reverse just this page to read top-to-bottom chronologically.
  const text=segment.slice().reverse().map(m=>`${m.direction==='incoming'?'👤 أنت':'🎧 فريق الدعم'} • ${baghdadDate(m.created_at)}\n${preview(m)}`).join('\n\n');
  const rows=segment.filter(m=>m.kind!=='text').map(m=>[button(`${m.kind==='photo'?'📷':'🎬'} فتح المرفق #${m.id}`,`my_support_media:${m.id}`,'primary')]);
  const nav=[];
  if(page>0)nav.push(button('⬅️ أحدث',`my_support_thread:${page-1}`,'primary'));
  if(messages.length>8)nav.push(button('أقدم ➡️',`my_support_thread:${page+1}`,'primary'));
  if(nav.length)rows.push(nav);
  rows.push([button('✉️ رد أو رسالة جديدة','my_support_new','success')]);
  rows.push([button('↩️ رجوع لرسائلي','my_support_inbox','danger')]);
  return sendOrEditText(env,uid,`📨 سجل رسائلي • صفحة ${page+1}\n\n${text||'لا توجد مراسلات بعد.'}`,keyboard(...rows),messageId);
}
export async function handleCustomerSupportCallback(db,env,uid,data,messageId=null){
  if(!/^(?:my_support_inbox|my_support_new|my_support_thread:\d+|my_support_media:\d+)$/.test(data))return false;
  if(data==='my_support_inbox'){await customerInbox(db,env,uid,messageId);return true;}
  if(data==='my_support_new'){
    await setSession(db,uid,'support');
    await sendText(env,uid,'✉️ أرسل نصاً أو صورة أو فيديو الآن. سيُحفظ تواصلك في «رسائلي» من القائمة الرئيسية.',keyboard([button('📨 رسائلي','my_support_inbox','primary')],[button('🏠 الرئيسية','home','danger')]));
    return true;
  }
  if(data.startsWith('my_support_thread:')){
    const page=Number(data.split(':')[1]);
    await customerThread(db,env,uid,Math.min(page,200),messageId);
    return true;
  }
  if(data.startsWith('my_support_media:')){
    const id=positiveInt(data.split(':')[1]);
    const m=id?await db.prepare('SELECT kind,telegram_file_id,created_at FROM support_messages WHERE id=? AND user_tg_id=?').bind(id,uid).first():null;
    if(!m?.telegram_file_id){await sendText(env,uid,'هذا المرفق غير متوفر ضمن رسائلك.');return true;}
    const method=m.kind==='photo'?'sendPhoto':m.kind==='video'?'sendVideo':null;
    if(method){
      try{await telegram(env,method,{chat_id:uid,[m.kind]:m.telegram_file_id,caption:'📎 مرفق من سجل الدعم • '+baghdadDate(m.created_at)});}
      catch{await sendText(env,uid,'تعذر عرض المرفق الآن. يمكنك التواصل مع الدعم لاسترجاعه.');}
    }
    return true;
  }
  return true;
}
