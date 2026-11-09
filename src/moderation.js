import {baghdadDate} from './wallet.js';
import {formatEgpMinor,formatLydMilli} from './display-currency.js';
import {formatIQD,short} from './common.js';
import {getUser} from './database.js';

export const SUSPENSION_HOURS=Object.freeze([1,6,24,72,168,720]);
export function suspensionTime(nowMs, hours){
  if(!Number.isSafeInteger(hours)||hours<1||hours>24*365)return null;
  return Math.floor(nowMs/1000)+hours*3600;
}
export function restrictionLabel(user,now=Math.floor(Date.now()/1000)){
  if(user?.is_blocked===1)return '🚫 محظور بشكل دائم';
  if(Number(user?.suspended_until)>now)return '⏳ معلّق حتى '+baghdadDate(new Date(user.suspended_until*1000).toISOString());
  return '✅ نشط';
}
export async function guardUser(db,env,uid,knownUser=undefined){
  if(String(uid)===String(env.ADMIN_ID))return null;
  const user=knownUser===undefined?await getUser(db,uid):knownUser;
  if(!user)return null;
  if(user.is_blocked===1)return '🚫 تم إيقاف وصولك إلى My Store بشكل دائم.'+
    (user.restriction_reason?'\n📋 السبب: '+short(user.restriction_reason,220):'');
  if(user.suspended_until){
    if(Number(user.suspended_until)<=Math.floor(Date.now()/1000)){
      await db.prepare('UPDATE users SET suspended_until=NULL,restriction_reason=\'\',restricted_by=NULL,restricted_at=NULL WHERE tg_id=? AND suspended_until IS NOT NULL AND suspended_until<=?')
        .bind(uid,Math.floor(Date.now()/1000)).run();
      return null;
    }
    return '⏳ حسابك معلّق مؤقتاً حتى '+baghdadDate(new Date(user.suspended_until*1000).toISOString())+
      (user.restriction_reason?'\n📋 السبب: '+short(user.restriction_reason,220):'');
  }
  return null;
}
export function cleanReason(text){
  const reason=String(text||'').trim();
  return reason==='-'?'':reason.length>=1&&reason.length<=220?reason:null;
}
export function amountInIQD(text,ceiling=10000000){
  const trimmed=String(text||'').trim().replace(/,/g,'');
  if(!/^\d{1,8}$/.test(trimmed))return null;
  const amount=Number(trimmed);
  return Number.isSafeInteger(amount)&&amount>=1&&amount<=Math.min(ceiling,10000000)?amount:null;
}
export function topupDecisionText(record,credit){
  const lyd=record.display_lyd_amount_milli!=null?'🇱🇾 المبلغ المطلوب بالدينار الليبي: '+formatLydMilli(Number(record.display_lyd_amount_milli))+'\n':'';
  const egp=record.display_currency==='EGP'&&Number.isSafeInteger(record.display_amount_minor)
    ?'🇪🇬 المبلغ المطلوب بالجنيه: '+formatEgpMinor(record.display_amount_minor)+'\n':'';
  return `📋 تأكيد شحن الطلب #${record.id}\n\n${lyd}${egp}💰 المقابل المحاسبي: ${formatIQD(record.amount_iqd)}\n✅ المبلغ المعتمد: ${formatIQD(credit)}\n\nتأكد من وصول التحويل وملكيته قبل الاعتماد النهائي.`;
}
