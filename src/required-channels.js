import {button,keyboard,isAdmin,short} from './common.js';
import {telegram,sendOrEditText,sendText} from './telegram.js';
import {choice,languageOf} from './i18n.js';
import {getSetting,updateSetting} from './settings.js';
import {setSession,clearSession,audit} from './database.js';
const BACK=[button('🛡️ لوحة المدير','admin','primary')];
const validId=v=>/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)||/^-100\d{5,20}$/.test(v);
const normalize=v=>v.startsWith('@')||v.startsWith('-')?v:'@'+v;
const validUrl=s=>{try{const u=new URL(s);return u.protocol==='https:'&&u.hostname.toLowerCase()==='t.me'&&!u.username&&!u.password&&u.pathname.length>1;}catch{return false;}};
const linkFor=(id,url)=>url||(id.startsWith('@')?'https://t.me/'+id.slice(1):'');
export async function listRequired(db){return (await db.prepare('SELECT * FROM required_channels WHERE active=1 ORDER BY id LIMIT 30').all()).results||[];}
export async function gateState(db,env,uid){
 if(isAdmin(env,uid)||(await getSetting(db,'required_channels_enabled','false'))!=='true')return {allowed:true,missing:[]};
 const channels=await listRequired(db);const missing=[];
 for(const c of channels){
   try{const m=await telegram(env,'getChatMember',{chat_id:c.chat_id,user_id:uid});
     if(!['creator','administrator','member'].includes(m?.status)&&!(m?.status==='restricted'&&m.is_member===true))missing.push(c);
   }catch(error){console.error('Channel membership lookup unavailable',c.id,String(error).replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[hidden]'));missing.push(c);}
 }
 return {allowed:missing.length===0,missing};
}
export async function showGate(db,env,uid,state,messageId=null){
 const en=languageOf(env)==='en';
 const rows=state.missing.map(c=>[{text:'📢 '+short(en&&c.title_en||c.title_ar,70),url:c.join_url,style:'primary'}]);
 rows.push([button(choice(env,'✅ التحقق من الاشتراك','✅ Verify Subscription'),'required_verify','success')]);
 const text=choice(env,'📢 الاشتراك الإجباري\n\nيرجى الانضمام إلى القنوات التالية ثم الضغط على زر التحقق للمتابعة.','📢 Required Subscription\n\nJoin all channels below, then press Verify to continue.');
 return sendOrEditText(env,uid,text,keyboard(...rows),messageId,{preserveText:true});
}
export async function manageChannels(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return;
 const enabled=await getSetting(db,'required_channels_enabled','false');
 const channels=(await db.prepare('SELECT * FROM required_channels ORDER BY id DESC LIMIT 30').all()).results||[];
 const rows=channels.map(c=>[button((c.active?'🟢 ':'⚫ ')+short(c.title_ar,34),'required_detail:'+c.id,'primary')]);
 rows.push([button('➕ إضافة قناة','required_add','success')]);
 rows.push([button(enabled==='true'?'⏸️ تعطيل الاشتراك الإجباري':'✅ تفعيل الاشتراك الإجباري','required_toggle',enabled==='true'?'danger':'success')],BACK);
 return sendOrEditText(env,uid,'📢 الاشتراك الإجباري\n\nالحالة: '+(enabled==='true'?'مفعّل':'معطّل')+'\nالقنوات: '+channels.length+'\n\nيجب إضافة البوت مشرفاً لكل قناة حتى يقرأ عضوية المستخدمين.',keyboard(...rows),messageId);
}
export async function channelDetail(db,env,uid,id,messageId){
 const c=await db.prepare('SELECT * FROM required_channels WHERE id=?').bind(id).first();
 if(!c)return manageChannels(db,env,uid,messageId);
 const text='📢 '+c.title_ar+'\nEnglish: '+(c.title_en||'—')+'\nالمعرف: '+c.chat_id+'\nالرابط: '+c.join_url+'\nالحالة: '+(c.active?'ظاهر':'معطل');
 return sendOrEditText(env,uid,text,keyboard([button('✏️ تعديل الاسم العربي','required_edit:'+id+':ar')],[button('✏️ Edit English Name','required_edit:'+id+':en')],[button(c.active?'🙈 إيقاف القناة':'👁️ تفعيل القناة','required_active:'+id,c.active?'danger':'success')],[button('🗑️ حذف القناة','required_delete:'+id,'danger')],[button('↩️ إدارة القنوات','required_manage')]),messageId);
}
export async function handleChannelAdmin(db,env,uid,data,messageId=null){
 if(!/^required_(?:manage|add|toggle|detail:\d+|active:\d+|delete:\d+|delete_confirm:\d+|edit:\d+:(?:ar|en))$/.test(data))return false;
 if(!isAdmin(env,uid))return true;
 if(data==='required_manage'){await manageChannels(db,env,uid,messageId);return true;}
 if(data==='required_add'){await setSession(db,uid,'owner_required_add');
   await sendText(env,uid,'📢 أرسل:\nاسم القناة بالعربي | English name | @username أو -100ID | رابط الانضمام\n\nيمكن ترك الرابط الأخير فارغاً للقناة العامة. للقناة الخاصة اكتب رابط https://t.me/+...\nاجعل البوت مشرفاً بالقناة. للإلغاء /cancel.');return true;}
 if(data==='required_toggle'){
   const current=await getSetting(db,'required_channels_enabled','false');
   if(current!=='true'){
     const active=await listRequired(db);
     if(!active.length){await sendText(env,uid,'⚠️ أضف قناة نشطة أولاً.');return true;}
     const bot=await telegram(env,'getMe',{});
     for(const c of active)try{const m=await telegram(env,'getChatMember',{chat_id:c.chat_id,user_id:bot.id});if(!['administrator','creator'].includes(m.status))throw Error('not admin');}
       catch{await sendText(env,uid,'⚠️ البوت ليس مشرفاً بالقناة '+c.title_ar+'. أضفه مشرفاً أولاً.');return true;}
   }
   await updateSetting(db,'required_channels_enabled',current==='true'?'false':'true',uid);
   await audit(db,uid,'required_channels_toggle','setting',0);await manageChannels(db,env,uid,messageId);return true;
 }
 const id=Number(data.split(':')[1]);const c=await db.prepare('SELECT * FROM required_channels WHERE id=?').bind(id).first();
 if(!c){await manageChannels(db,env,uid,messageId);return true;}
 if(data.startsWith('required_detail:')){await channelDetail(db,env,uid,id,messageId);return true;}
 if(data.startsWith('required_active:')){await db.prepare('UPDATE required_channels SET active=? WHERE id=?').bind(c.active?0:1,id).run();await audit(db,uid,'required_channel_active','channel',id);await channelDetail(db,env,uid,id,messageId);return true;}
 if(data.startsWith('required_edit:')){const lang=data.split(':')[2];await setSession(db,uid,'owner_required_edit',{id,lang});await sendText(env,uid,'✏️ أرسل الاسم الجديد ('+(lang==='en'?'English':'العربية')+') بحد أقصى 70 حرف.');return true;}
 if(data.startsWith('required_delete_confirm:')){await db.prepare('DELETE FROM required_channels WHERE id=?').bind(id).run();await audit(db,uid,'required_channel_delete','channel',id);await manageChannels(db,env,uid,messageId);return true;}
 if(data.startsWith('required_delete:')){await sendOrEditText(env,uid,'⚠️ تأكيد حذف القناة «'+c.title_ar+'»؟',keyboard([button('🗑️ تأكيد الحذف','required_delete_confirm:'+id,'danger')],[button('↩️ إلغاء','required_detail:'+id)]),messageId);return true;}
 return true;
}
export async function handleChannelAdminText(db,env,uid,session,message){
 if(!isAdmin(env,uid))return false;
 const input=String(message.text||'').trim();
 if(session.action==='owner_required_add'){
   const p=input.split('|').map(x=>x.trim());if(p.length!==4){await sendText(env,uid,'❌ اكتب: الاسم العربي | English name | معرف القناة | الرابط');return true;}
   const [ar,en,raw,url]=p;const id=normalize(raw);const join=linkFor(id,url);
   if(!ar||ar.length>70||en.length>70||!validId(id)||!validUrl(join)){await sendText(env,uid,'❌ تحقق من الاسم والمعرف ورابط https://t.me.');return true;}
   if(await db.prepare('SELECT id FROM required_channels WHERE chat_id=?').bind(id).first()){await sendText(env,uid,'⚠️ هذه القناة موجودة.');return true;}
   try{const chat=await telegram(env,'getChat',{chat_id:id});if(chat.type!=='channel')throw Error('not channel');
     const bot=await telegram(env,'getMe',{});const m=await telegram(env,'getChatMember',{chat_id:id,user_id:bot.id});if(!['administrator','creator'].includes(m.status))throw Error('not admin');
   }catch{await sendText(env,uid,'⚠️ تعذر تأكيد القناة وإشراف البوت عليها. لم تتم الإضافة.');return true;}
   await db.prepare('INSERT INTO required_channels(chat_id,title_ar,title_en,join_url) VALUES(?,?,?,?)').bind(id,ar,en,join).run();
   await audit(db,uid,'required_channel_add','channel',0);await clearSession(db,uid);
   await sendText(env,uid,'✅ تمت إضافة القناة.',keyboard([button('📢 إدارة القنوات','required_manage')]));return true;
 }
 if(session.action==='owner_required_edit'){
   const {id,lang}=session.payload||{};if(!['ar','en'].includes(lang)||!input||input.length>70){await sendText(env,uid,'❌ الاسم غير صالح.');return true;}
   const field=lang==='en'?'title_en':'title_ar';
   await db.prepare('UPDATE required_channels SET '+field+'=? WHERE id=?').bind(input,id).run();
   await audit(db,uid,'required_channel_rename','channel',Number(id));await clearSession(db,uid);
   await sendText(env,uid,'✅ تم تعديل اسم القناة.',keyboard([button('📢 إدارة القنوات','required_manage')]));return true;
 }
 return false;
}
