import {button,keyboard,backRow,isAdmin,formatIQD} from './common.js';
import {sendText,sendOrEditText} from './telegram.js';
import {setSession,clearSession,audit,getUser} from './database.js';
import {choice,languageOf} from './i18n.js';
import {usdRate,formatUSD} from './wallet.js';
import {getSetting,updateSetting} from './settings.js';
import {homeSettingKey} from './home-buttons.js';
export const policy=db=>db.prepare('SELECT * FROM referral_policy WHERE id=1').first();
export async function referralPage(db,env,uid,messageId=null){
 const [p,n,total,u,rate]=await Promise.all([
  policy(db),db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first(),
  db.prepare('SELECT COUNT(*) n, COALESCE(SUM(reward_iqd),0) total FROM referral_rewards WHERE referrer_tg_id=?').bind(uid).first(),
  getUser(db,uid),usdRate(db)]);
 const en=languageOf(env)==='en', money=u?.currency_preference==='USD'&&rate?formatUSD(Math.round(Number(total?.total||0)*100/rate)):formatIQD(total?.total);
 const link=env.BOT_USERNAME?'https://t.me/'+env.BOT_USERNAME.replace(/^@/,'')+'?start=ref_'+uid:choice(env,'اسم البوت غير مضبوط','Bot username not set');
 const cap=p.max_purchases===0?choice(env,'مدى الحياة','Lifetime'):String(p.max_purchases);
 const lines=[choice(env,'👥 برنامج الإحالات','👥 Referral Program'),'',
 choice(env,'👥 الأصدقاء المدعوون: ','👥 Invited friends: ')+(n?.n||0),
 choice(env,'🔗 رابط الإحالة: ','🔗 Referral link: ')+link,'',
 p.enabled?choice(env,'✅ مكافآت الإحالة مفعلة','✅ Referral rewards enabled'):choice(env,'⏸️ مكافآت الإحالة متوقفة','⏸️ Referral rewards paused'),
 choice(env,'🎁 نسبة المكافأة: ','🎁 Reward rate: ')+(p.basis_points/100)+'%',
 choice(env,'🔢 عدد مشتريات الصديق المؤهلة: ','🔢 Eligible purchases per friend: ')+cap,
 choice(env,'💰 إجمالي المكافآت: ','💰 Total rewards: ')+money,
 choice(env,'📜 مكافآت مستلمة: ','📜 Rewards earned: ')+(total?.n||0)];
 return sendOrEditText(env,uid,lines.join('\n'),keyboard(
 [button(choice(env,'📜 سجل الأرباح','📜 Earnings History'),'referral_history','primary')],backRow()),messageId,{preserveText:true});
}
export async function referralHistory(db,env,uid,messageId=null){
 const rows=(await db.prepare('SELECT purchase_id,reward_iqd,created_at FROM referral_rewards WHERE referrer_tg_id=? ORDER BY id DESC LIMIT 15').bind(uid).all()).results||[];
 return sendOrEditText(env,uid,choice(env,'📜 سجل أرباح الإحالات','📜 Referral Earnings History')+'\n\n'+(rows.map(x=>'#'+x.purchase_id+' • '+formatIQD(x.reward_iqd)+' • '+x.created_at).join('\n')||choice(env,'لا توجد مكافآت بعد.','No rewards yet.')),keyboard([button(choice(env,'↩️ الإحالات','↩️ Referrals'),'referrals')],backRow()),messageId,{preserveText:true});
}
const fields={basis_points:['📊 النسبة المئوية (اكتب 5 للنسبة 5%)',0,30],max_purchases:['🔢 عدد مرات المكافأة لكل صديق (0 = مدى الحياة)',0,100000],min_purchase_iqd:['💰 الحد الأدنى لعملية الشراء بالدينار',0,100000000],max_reward_iqd:['🛡️ سقف مكافأة الشراء الواحد (0 = غير محدود)',0,100000000]};
const ownerBack=[button('🛡️ لوحة المدير','admin')];
export async function referralAdmin(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return false;
 const [p,total,visible]=await Promise.all([policy(db),db.prepare('SELECT COUNT(*) n,COALESCE(SUM(reward_iqd),0) sum FROM referral_rewards').first(),getSetting(db,homeSettingKey('referrals','visible'),'true')]);
 return sendOrEditText(env,uid,'🎁 إدارة مكافآت الإحالات\n\nالحالة: '+(p.enabled?'🟢 مفعلة':'🔴 متوقفة')+'\nزر الإحالات: '+(visible==='false'?'مخفي':'ظاهر')+'\nالنسبة: '+p.basis_points/100+'%\nالمشتريات المؤهلة: '+(p.max_purchases||'مدى الحياة')+'\nالحد الأدنى: '+formatIQD(p.min_purchase_iqd)+'\nالسقف: '+(p.max_reward_iqd?formatIQD(p.max_reward_iqd):'بلا حد')+'\n\nالمكافآت: '+total.n+' • '+formatIQD(total.sum),keyboard(
 [button(p.enabled?'⏸️ إيقاف المكافآت':'✅ تشغيل المكافآت','refadmin_toggle',p.enabled?'danger':'success')],
 [button(visible==='false'?'👁️ إظهار الإحالات':'🙈 إخفاء الإحالات','refadmin_visible','primary')],
 ...Object.entries(fields).map(([k,v])=>[button('✏️ '+v[0],'refadmin_edit:'+k,'primary')]),
 [button('📜 سجل مكافآت الإحالات','refadmin_history')],ownerBack),messageId);
}
export async function adminHistory(db,env,uid,messageId=null){
 if(!isAdmin(env,uid))return false;
 const rows=(await db.prepare('SELECT purchase_id,buyer_tg_id,referrer_tg_id,reward_iqd,created_at FROM referral_rewards ORDER BY id DESC LIMIT 20').all()).results||[];
 return sendOrEditText(env,uid,'📜 أحدث مكافآت الإحالات\n\n'+(rows.map(x=>'#'+x.purchase_id+' • '+formatIQD(x.reward_iqd)+'\nالداعي: '+x.referrer_tg_id+' • المشتري: '+x.buyer_tg_id+' • '+x.created_at).join('\n\n')||'لا توجد مكافآت بعد.'),keyboard([button('↩️ إدارة الإحالات','refadmin')],ownerBack),messageId);
}
export async function referralAdminCallback(db,env,uid,data,messageId=null){
 if(!/^refadmin(?:_toggle|_visible|_history|_edit:(?:basis_points|max_purchases|min_purchase_iqd|max_reward_iqd))?$/.test(data))return false;
 if(!isAdmin(env,uid))return true;
 if(data==='refadmin')await referralAdmin(db,env,uid,messageId);
 else if(data==='refadmin_history')await adminHistory(db,env,uid,messageId);
 else if(data==='refadmin_toggle'||data==='refadmin_visible'){
  const field=data==='refadmin_toggle'?'enabled':'visible';
  if(field==='visible'){
    const key=homeSettingKey('referrals','visible');
    const current=await getSetting(db,key,'true');
    await updateSetting(db,key,current==='false'?'true':'false',uid);
  }else await db.prepare('UPDATE referral_policy SET enabled=1-enabled WHERE id=1').run();
  await audit(db,uid,'referral_'+field,'policy',1);
  await referralAdmin(db,env,uid,messageId);
 }else{
  const field=data.slice('refadmin_edit:'.length);
  await setSession(db,uid,'owner_referral_policy',{field});
  await sendText(env,uid,'✏️ '+fields[field][0]+'\nأرسل رقماً بين '+fields[field][1]+' و'+fields[field][2]+' أو /cancel.');
 }
 return true;
}
export async function referralAdminText(db,env,uid,session,message){
 if(!isAdmin(env,uid)||session?.action!=='owner_referral_policy')return false;
 const field=session.payload?.field,def=fields[field],text=String(message.text||'').trim();
 if(!def)return true;
 if(!/^\d{1,9}$/.test(text)||Number(text)<def[1]||Number(text)>def[2]){await sendText(env,uid,'❌ الرقم غير صالح.');return true;}
 await db.prepare('UPDATE referral_policy SET '+field+'=? WHERE id=1').bind(field==='basis_points'?Number(text)*100:Number(text)).run();
 await audit(db,uid,'referral_edit_'+field,'policy',1);
 await clearSession(db,uid);
 await referralAdmin(db,env,uid);
 return true;
}
