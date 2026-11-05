import {readConfirmedTrc20Transfers,inspectTrc20Transfer,creditVerifiedTrc20,notifyTrc20Alert,configuredTrc20Receiver,trc20TxidIsValid,USDT_CONTRACT} from './trc20-payments.js';
import {queueNotification} from './telegram.js';
import {settleTrc20Single} from './trc20-single.js';

// Exactly ONE external TronGrid GET at most per minute. Zero without recent orders.
// The manual TXID verification path is separate from this Cron worker.
export async function pollTrc20Payments(db,env){
 const now=Math.floor(Date.now()/1000);
 const receiver=configuredTrc20Receiver(env);
 let credited=0,alerts=0,expired=0,networkCalls=0;
 // Indexed, bounded lookback covers the active 25-minute window and a short
 // late-payment alert period. Unrelated wallet payments require no D1 writes.
 const intents=receiver?(await db.prepare(
   "SELECT * FROM trc20_payment_intents WHERE receiver=? AND created_at>=? AND status IN ('waiting','expired','cancelled') ORDER BY created_at DESC LIMIT 250"
 ).bind(receiver,now-30*60).all()).results||[]:[];
 let error=null;
 if(receiver&&env.TRONGRID_API_KEY&&intents.length){
   try{
     const oldest=Math.min(...intents.map(x=>Number(x.created_at)));
     networkCalls++;
     const events=await readConfirmedTrc20Transfers(env,receiver,oldest*1000);
     // New orders match their unique six-decimal fingerprint. Historical
     // requests continue to require the original exact amount.
     const amounts=new Map(intents.filter(i=>i.status==='waiting'&&i.flexible_amount!==1&&i.full_quote_active===1).map(i=>[String(i.expected_micro),i]));
     const fractions=new Map(intents.filter(i=>i.status==='waiting'&&i.flexible_amount===1).map(i=>[Number(i.expected_micro)%1000000,i]));
     for(const event of events){
       if(!trc20TxidIsValid(event.transaction_id)||event.to!==receiver||
         event.type!=='Transfer'||String(event.token_info?.address||'')!==USDT_CONTRACT)
         continue;
       const micro=Number(event.value);
       if(!Number.isSafeInteger(micro)||micro<=0)continue;
       const intent=amounts.get(String(micro))||fractions.get(micro%1000000);
       if(!intent)continue;
       const outcome=inspectTrc20Transfer(event,intent);
       if(outcome.status==='invalid'||outcome.status==='mismatch')continue;
       if(intent.status==='waiting'&&intent.expires_at>now&&outcome.status==='confirmed'){
         try{
           if(intent.flexible_amount===1){
             const payment=await settleTrc20Single(db,intent.user_tg_id,intent.id,outcome,env);
             if(payment.status!=='credited')continue;
           }else await creditVerifiedTrc20(db,intent.user_tg_id,intent.id,outcome.txid,env,outcome.blockTimestamp);
           credited++;
           intent.status='credited';
         }catch(e){console.error('TRC20 cron settlement skipped',String(e))}
       }else if(outcome.status==='late'||intent.status==='expired'||intent.status==='cancelled'||intent.expires_at<=now){
         const reason=intent.status==='cancelled'?'حوالة بعد إلغاء الطلب':'حوالة متأخرة بعد انتهاء مهلة الطلب';
         if(await notifyTrc20Alert(db,env,intent,event.transaction_id,reason))alerts++;
       }
     }
   }catch(e){error=e}
 }
 // Always expire time-limited requests, even if the network is unavailable.
 const ended=(await db.prepare(
   "UPDATE trc20_payment_intents SET status='expired' WHERE status='waiting' AND expires_at<=? RETURNING id,user_tg_id"
 ).bind(now).all()).results||[];
 for(const item of ended){
   expired++;
   await queueNotification(db,'sendMessage',{chat_id:item.user_tg_id,
     text:'⏰ انتهت مهلة طلب شحن USDT TRC20 (25 دقيقة). لن تُعتمد هذه العملية تلقائياً بعد الآن. إذا حولت بالفعل، تواصل مع الدعم ولا تحول مرة ثانية.'});
 }
 if(error)throw error;
 return {credited,alerts,expired,networkCalls};
}
