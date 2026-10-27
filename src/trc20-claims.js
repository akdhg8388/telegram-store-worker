import {formatUsdtMicro,trc20PaymentProgress,configuredTrc20Receiver} from './trc20-payments.js';

// An on-chain TXID is public. A prior, uniquely quoted exact transfer amount
// binds the future payment to the user's authenticated Telegram order.
// NEVER mint a claim for an on-chain transfer after it occurred.
export function parseSplitUsdCents(input){
 const value=String(input||'').trim();
 if(!/^(?:[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value))return null;
 const [whole,decimal='']=value.split('.');
 const minor=Number(whole)*100+Number(decimal.padEnd(2,'0'));
 return Number.isSafeInteger(minor)&&minor>=100?minor:null;
}
export async function activeTrc20Claim(db,intentId){
 return db.prepare("SELECT id,intent_id,amount_micro,created_at FROM trc20_payment_quotes WHERE intent_id=? AND status='waiting' LIMIT 1")
  .bind(intentId).first();
}
async function amountReservedRecently(db,receiver,amount,now){
 return !!(await db.prepare(
   "SELECT 1 AS found FROM trc20_payment_intents WHERE receiver=? AND expected_micro=? AND created_at>? "+
   "UNION SELECT 1 AS found FROM trc20_payment_quotes q "+
   "JOIN trc20_payment_intents i ON i.id=q.intent_id WHERE i.receiver=? AND q.amount_micro=? AND q.created_at>? LIMIT 1")
   .bind(receiver,amount,now-86400,receiver,amount,now-86400).first());
}
export async function issueTrc20Claim(db,env,uid,intentId,splitCents=null){
 const intent=await db.prepare('SELECT * FROM trc20_payment_intents WHERE id=? AND user_tg_id=?').bind(intentId,uid).first();
 const now=Math.floor(Date.now()/1000);
 if(!intent||intent.status!=='waiting'||Number(intent.expires_at)<=now)
   return {status:'expired'};
 if(configuredTrc20Receiver(env)!==intent.receiver)return {status:'unconfigured'};
 const progress=await trc20PaymentProgress(db,intentId);
 if(!progress||progress.remainingMicro<=0)return {status:'expired'};
 const current=await activeTrc20Claim(db,intentId);
 if(current)return {status:'ready',amountMicro:Number(current.amount_micro),remainingMicro:progress.remainingMicro,claimId:current.id,already:true};
 if(splitCents===null){
   // A remainder cannot be reserved until at least one unique preceding
   // installment was actually accepted. Initial complete-payment quote stays active.
   if(progress.partCount===0)return {status:'initial'};
 }else if(!Number.isSafeInteger(splitCents)||splitCents<100||
     splitCents*10000+990000>=progress.remainingMicro)
   return {status:'invalid_amount'};
 for(let attempt=0;attempt<(splitCents===null?1:99);attempt++){
   const centsTag=splitCents===null?0:(crypto.getRandomValues(new Uint32Array(1))[0]%99)+1;
   const amountMicro=splitCents===null?progress.remainingMicro:(splitCents+centsTag)*10000;
   if(await amountReservedRecently(db,intent.receiver,amountMicro,now))continue;
   const claimId=crypto.randomUUID();
   try{
     await db.batch([
       db.prepare("UPDATE trc20_payment_intents SET full_quote_active=0 WHERE id=? AND user_tg_id=? AND status='waiting' AND expires_at>unixepoch()")
         .bind(intentId,uid),
       db.prepare("INSERT INTO trc20_payment_quotes(id,intent_id,amount_micro) "+
         "SELECT ?,id,? FROM trc20_payment_intents WHERE id=? AND user_tg_id=? AND status='waiting' AND expires_at>unixepoch()")
         .bind(claimId,amountMicro,intentId,uid)
     ]);
     const issued=await db.prepare('SELECT * FROM trc20_payment_quotes WHERE id=?').bind(claimId).first();
     if(!issued)return {status:'expired'};
     return {status:'ready',amountMicro,remainingMicro:progress.remainingMicro,claimId};
   }catch(error){
     if(/UNIQUE|constraint/i.test(String(error))){
       const existing=await activeTrc20Claim(db,intentId);
       if(existing)return {status:'ready',amountMicro:Number(existing.amount_micro),remainingMicro:progress.remainingMicro,claimId:existing.id,already:true};
       continue;
     }
     throw error;
   }
 }
 return {status:'busy'};
}
export function trc20ClaimMessage(intent,claim){
 return '🔐 دفعة USDT محجوزة لهذا الطلب\n\n'+
  '💸 المطلوب تحويله الآن: '+formatUsdtMicro(claim.amountMicro)+
  '\n🌐 الشبكة: TRON (TRC20) فقط'+
  '\n🏦 عنوان الاستلام:\n'+intent.receiver+
  '\n💳 المتبقي من الطلب قبل هذه الدفعة: '+formatUsdtMicro(claim.remainingMicro)+
  '\n\n⚠️ يجب تحويل المبلغ المذكور بالضبط، وليس مبلغاً تقريبياً.'+
  '\n⏱️ الموعد النهائي هو نفس مهلة الطلب الأصلية (15 دقيقة).'+
  '\n✅ يفحص البوت الدفع تلقائياً، أو أرسل TXID بعد التحويل.';
}
