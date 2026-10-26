import {HOME_BUTTONS} from './home-buttons.js';
import {button,keyboard,isAdmin,short} from './common.js';
import {sendText,sendOrEditText,telegram} from './telegram.js';
import {updateSetting} from './settings.js';
import {setSession,clearSession,audit} from './database.js';
import {choice,languageOf} from './i18n.js';

// The owner is exempt. Only top-level user navigation is intercepted;
// active wallet purchases, stock reservations and payment workflows are safe.
const targets=HOME_BUTTONS.filter(x=>x.id!=='admin');
const byId=new Map(targets.map(x=>[x.id,x]));
const byAction=new Map(targets.map(x=>[x.action,x.id]));
const defaultAr='🛠️ هذه الخدمة تحت الصيانة مؤقتاً.\nنعمل على تحسينها، يرجى المحاولة لاحقاً.';
const defaultEn='🛠️ This service is temporarily under maintenance.\nWe are improving it. Please try again later.';
const globalAr='🛠️ My Store تحت الصيانة مؤقتاً.\nيرجى المحاولة لاحقاً.';
const globalEn='🛠️ My Store is temporarily under maintenance.\nPlease try again later.';
const valid=id=>id==='global'||byId.has(id);
const key=(id,field)=>id==='global'
  ?(field==='enabled'?'maintenance_enabled':field==='sticker'?'maintenance_global_sticker':'maintenance_message_'+field)
  :'maintenance_button_'+id+'_'+field;
const label=id=>byId.get(id)?.ar||'الصيانة العامة';
const ownerButton=[button('🛡️ لوحة المدير','admin','primary')];
export const maintenanceActionId=action=>byAction.get(String(action))||null;
export function maintenanceCommandId(command){
 return {'/shop':'shop','/profile':'profile','/history':'transactions','/transactions':'transactions',
 '/orders':'orders','/wallet':'wallet','/currency':'currency','/support':'support'}[command]||null;
}
export const isMaintenanceButtonEnabled=(settings,id)=>settings?.[key(id,'enabled')]==='true';

// Global and individual state in one indexed D1 query; no extra request for
// checkout callbacks. The same mechanism works with missing settings (off).
export async function maintenanceStatus(db,buttonId=null){
 const name=byId.has(buttonId)?key(buttonId,'enabled'):'_none_';
 const rows=(await db.prepare('SELECT key,value FROM bot_settings WHERE key IN (?,?)')
  .bind('maintenance_enabled',name).all()).results||[];
 const values=Object.fromEntries(rows.map(x=>[x.key,x.value]));
 return {global:values.maintenance_enabled==='true',button:values[name]==='true'};
}
export async function sendMaintenanceNotice(db,env,uid,id='global'){
 if(!valid(id))return false;
 const lang=languageOf(env)==='en'?'en':'ar',a=key(id,lang),b=key(id,'sticker');
 const rows=(await db.prepare('SELECT key,value FROM bot_settings WHERE key IN (?,?)').bind(a,b).all()).results||[];
 const v=Object.fromEntries(rows.map(x=>[x.key,x.value]));
 const fallback=id==='global'?(lang==='en'?globalEn:globalAr):(lang==='en'?defaultEn:defaultAr);
 const text=short(v[a]||fallback,800);
 if(v[b])try{await telegram(env,'sendSticker',{chat_id:uid,sticker:v[b]});}
 catch(error){console.error('Maintenance sticker send failed',String(error));}
 return sendText(env,uid,text,keyboard([button(choice(env,'↩️ الرجوع للرئيسية','↩️ Back to Home'),'home','primary')]),{
  entities:[{type:'bold',offset:0,length:text.length}],preserveText:true
 });
}
async function details(db,id){
 const fields=['enabled','ar','en','sticker'].map(v=>key(id,v));
 const rows=(await db.prepare('SELECT key,value FROM bot_settings WHERE key IN (?,?,?,?)').bind(...fields).all()).results||[];
 return Object.fromEntries(rows.map(x=>[x.key,x.value]));
}
async function save(db,uid,name,value){
 await db.prepare('INSERT INTO bot_settings(key,value,updated_by) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP')
  .bind(name,value,uid).run();
}
export async function maintenanceMenu(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return false;
 const rows=(await db.prepare("SELECT key,value FROM bot_settings WHERE key='maintenance_enabled' OR key LIKE 'maintenance_button_%_enabled'").all()).results||[];
 const v=Object.fromEntries(rows.map(x=>[x.key,x.value]));
 const buttons=targets.map(x=>[button((v[key(x.id,'enabled')]==='true'?'🔴 ':'🟢 ')+x.ar,'maintenance_view:'+x.id,'primary')]);
 return sendOrEditText(env,uid,'🛠️ إدارة الصيانة\n\n🌐 الصيانة العامة: '+(v.maintenance_enabled==='true'?'🔴 مفعلة':'🟢 متوقفة')+
 '\n\n🔧 اختر الزر الذي تريد صيانته، ويظل ظاهراً للعملاء لكن تظهر رسالة الصيانة عند الضغط. بقية الخدمات تستمر بالعمل.\n\n🛡️ لوحة المدير لا تتوقف أبداً.',
 keyboard([button('🌐 إعداد الصيانة العامة','maintenance_view:global','primary')],...buttons,ownerButton),messageId);
}
export async function maintenanceDetail(db,env,uid,id,messageId=null){
 if(!isAdmin(env,uid)||!valid(id))return false;
 const s=await details(db,id),active=s[key(id,'enabled')]==='true',global=id==='global';
 const lines=['🛠️ '+label(id),'', 'الحالة: '+(active?'🔴 مفعلة':'🟢 متوقفة'),
 'الملصق المتحرك: '+(s[key(id,'sticker')]?'✅ محفوظ':'غير مضاف'),
 '', '🇮🇶 الرسالة العربية:',s[key(id,'ar')]||(global?globalAr:defaultAr),
 '', '🇬🇧 English:',s[key(id,'en')]||(global?globalEn:defaultEn),
 '', 'تظهر رسالة الصيانة بخط عريض كامل عند المستخدم.'];
 return sendOrEditText(env,uid,lines.join('\n'),keyboard(
 [button(active?'✅ إنهاء الصيانة':'🛠️ تشغيل الصيانة','maintenance_toggle:'+id,active?'success':'danger')],
 [button('📝 تعديل النص العربي','maintenance_edit:'+id+':ar','primary')],
 [button('🎞️ إضافة ملصق متحرك','maintenance_sticker:'+id,'primary')],
 [button('🗑️ إزالة الملصق','maintenance_remove_sticker:'+id,'danger')],
 [button('♻️ استعادة النص الافتراضي','maintenance_reset:'+id,'primary')],
 [button('👁️ معاينة الصيانة','maintenance_preview:'+id,'primary')],
 [button('↩️ قائمة الصيانة','admin_maintenance','primary')],ownerButton),messageId,{preserveText:true});
}
export async function maintenanceAdminCallback(db,env,uid,data,messageId=null){
 if(data!=='admin_maintenance'&&data!=='admin_maintenance_toggle'&&
 !/^maintenance_(?:view|toggle|sticker|remove_sticker|reset|preview):[a-z_]+$/.test(data)&&
 !/^maintenance_edit:[a-z_]+:(?:ar|en)$/.test(data))return false;
 if(!isAdmin(env,uid))return true;
 if(data==='admin_maintenance'){await maintenanceMenu(db,env,uid,messageId);return true;}
 if(data==='admin_maintenance_toggle')data='maintenance_toggle:global';
 const [action,id,lang]=data.split(':');
 if(!valid(id))return true;
 if(action==='maintenance_view')await maintenanceDetail(db,env,uid,id,messageId);
 else if(action==='maintenance_toggle'){
  const name=key(id,'enabled'),v=await db.prepare('SELECT value FROM bot_settings WHERE key=?').bind(name).first();
  if(id==='global')await updateSetting(db,name,v?.value==='true'?'false':'true',uid);
  else await save(db,uid,name,v?.value==='true'?'false':'true');
  await audit(db,uid,'toggle_maintenance_'+id,'setting',0);
  await maintenanceDetail(db,env,uid,id,messageId);
 }else if(action==='maintenance_edit'){
  await setSession(db,uid,'owner_maintenance_text',{scope:id,lang});
  await sendText(env,uid,'✏️ '+label(id)+' — '+(lang==='en'?'English':'العربية')+'\nأرسل النص (حتى 800 حرف). يظهر للمستخدم كله بخط سميك.\n/empty للاستعادة أو /cancel للإلغاء.');
 }else if(action==='maintenance_sticker'){
  await setSession(db,uid,'owner_maintenance_sticker',{scope:id});
  await sendText(env,uid,'🎞️ أرسل ملصق Telegram متحركاً أو ملصق فيديو، ليظهر أعلى رسالة الصيانة.\n/empty لإزالته، أو /cancel للإلغاء.');
 }else if(action==='maintenance_remove_sticker'){
  await save(db,uid,key(id,'sticker'),'');
  await audit(db,uid,'maintenance_remove_sticker_'+id,'setting',0);
  await maintenanceDetail(db,env,uid,id,messageId);
 }else if(action==='maintenance_reset'){
  await db.batch(['ar','en'].map(x=>db.prepare('DELETE FROM bot_settings WHERE key=?').bind(key(id,x))));
  await audit(db,uid,'maintenance_reset_'+id,'setting',0);
  await maintenanceDetail(db,env,uid,id,messageId);
 }else if(action==='maintenance_preview')await sendMaintenanceNotice(db,env,uid,id);
 return true;
}
export async function maintenanceAdminText(db,env,uid,session,message){
 if(!isAdmin(env,uid)||!['owner_maintenance_text','owner_maintenance_sticker'].includes(session?.action))return false;
 const id=session.payload?.scope;if(!valid(id)){await clearSession(db,uid);return true;}
 if(session.action==='owner_maintenance_text'){
  const lang=session.payload?.lang,t=String(message.text||'').trim();
  if(!['ar','en'].includes(lang))return true;
  if((t!=='/empty'&&!t)||t.length>800){
   await sendText(env,uid,'❌ أرسل رسالة نصية حتى 800 حرف أو /empty.');return true;
  }
  if(id==='global')await updateSetting(db,key(id,lang),t==='/empty'?'':t,uid);
  else await save(db,uid,key(id,lang),t==='/empty'?'':t);
 }else{
  const sticker=message.sticker,remove=String(message.text||'').trim()==='/empty';
  if(!remove&&(!sticker?.file_id||(!sticker.is_animated&&!sticker.is_video))){
   await sendText(env,uid,'❌ أرسل ملصق Telegram متحركاً أو ملصق فيديو، وليس صورة أو ملصقاً ثابتاً.');return true;
  }
  await save(db,uid,key(id,'sticker'),remove?'':sticker.file_id);
 }
 await audit(db,uid,'maintenance_customize_'+id,'setting',0);
 await clearSession(db,uid);
 await sendText(env,uid,'✅ تم حفظ التخصيص.',keyboard(
 [button('🛠️ إعداد هذا الزر','maintenance_view:'+id,'primary')],ownerButton));
 return true;
}
