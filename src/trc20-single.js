import {formatIQD,adminIds} from './common.js';
import {formatUsdtMicro,trc20TxidIsValid,configuredTrc20Receiver,uniqueTrc20FractionMatches} from './trc20-payments.js';

// New orders may settle with one verified payment of a different whole-dollar
// amount, provided all six fractional USDT digits match the unique quoted tag.
// A TXID is public; a random TXID alone never establishes payment ownership.
export function creditedTrc20IQD(intent,amountMicro){
 const rate=Number(intent?.quoted_rate_iqd);
 if(!Number.isSafeInteger(amountMicro)||amountMicro<=0||
   !Number.isSafeInteger(rate)||rate<100||rate>10000)return null;
 const credit=Math.round(amountMicro*rate/1000000);
 return Number.isSafeInteger(credit)&&credit>=1000&&credit<=10000000?credit:null;
}
export async function settleTrc20Single(db,uid,id,verified,env={}){
 const txid=String(verified?.txid||'').toLowerCase();
 const amount=Number(verified?.amountMicro),ts=Number(verified?.blockTimestamp);
 if(!trc20TxidIsValid(txid)||!Number.isSafeInteger(amount)||amount<=0||
   !Number.isSafeInteger(ts)||ts<=0)return {status:'invalid'};
 const intent=await db.prepare('SELECT * FROM trc20_payment_intents WHERE id=? AND user_tg_id=?').bind(id,uid).first();
 if(!intent||intent.status!=='waiting'||Number(intent.expires_at)<=Math.floor(Date.now()/1000))
   return {status:'expired'};
 if(configuredTrc20Receiver(env)!==intent.receiver)return {status:'unconfigured'};
 if(ts<Number(intent.created_at)*1000||ts>Number(intent.expires_at)*1000)return {status:'late'};
 if(!uniqueTrc20FractionMatches(intent,amount))return {status:'unreserved'};
 const credit=creditedTrc20IQD(intent,amount);
 if(!credit)return {status:'amount_out_of_range'};
 const found=await db.prepare(
   'SELECT 1 AS duplicate FROM trc20_payment_intents WHERE txid=? UNION '+
   'SELECT 1 FROM trc20_payment_parts WHERE txid=? UNION '+
   'SELECT 1 FROM trc20_single_transfers WHERE txid=? LIMIT 1').bind(txid,txid,txid).first();
 if(found)return {status:'duplicate'};
 const note='✅ تم تأكيد تحويل USDT TRC20 وشحن محفظتك تلقائياً.\n'+
   '💸 المحوّل الفعلي: '+formatUsdtMicro(amount)+'\n'+
   '💰 المضاف إلى المحفظة: '+formatIQD(credit)+'\n'+
   '🧾 رقم الطلب: '+id;
 const notifications=[{chat_id:uid,text:note},...adminIds(env).map(admin=>({
   chat_id:admin,text:'✅ شحن TRC20 تلقائي (حوالة واحدة)\n👤 العميل: '+uid+
   '\n💸 المبلغ المحوّل: '+formatUsdtMicro(amount)+
   '\n💰 الرصيد المضاف: '+formatIQD(credit)+
   '\n🧾 TXID: '+txid
 }))];
 // One atomic D1 batch: claim TXID once, update the order, insert the approved
 // top-up and ledger entry, and enqueue idempotent notices. Replays cannot
 // credit twice, even across cron and the user's manual TXID submission.
 const steps=[
   db.prepare('INSERT OR IGNORE INTO trc20_single_transfers(intent_id,txid,amount_micro,credited_iqd,block_timestamp) '+
     'SELECT id,?,?,?,? FROM trc20_payment_intents i WHERE id=? AND user_tg_id=? AND status=\'waiting\' '+
     'AND flexible_amount=1 AND receiver=? AND expires_at>unixepoch() '+
     'AND ? BETWEEN created_at*1000 AND expires_at*1000 '+
     'AND (? % 1000000)=(expected_micro % 1000000) '+
     'AND NOT EXISTS(SELECT 1 FROM trc20_payment_intents WHERE txid=?) '+
     'AND NOT EXISTS(SELECT 1 FROM trc20_payment_parts WHERE txid=?) '+
     'AND NOT EXISTS(SELECT 1 FROM trc20_payment_parts WHERE intent_id=i.id)')
     .bind(txid,amount,credit,ts,id,uid,intent.receiver,ts,amount,txid,txid),
   db.prepare('UPDATE trc20_payment_intents SET status=\'credited\',txid=?,credited_at=unixepoch() '+
     'WHERE id=? AND user_tg_id=? AND status=\'waiting\' AND flexible_amount=1 '+
     'AND expires_at>unixepoch() AND EXISTS(SELECT 1 FROM trc20_single_transfers '+
     'WHERE intent_id=? AND txid=? AND amount_micro=?)')
     .bind(txid,id,uid,id,txid,amount),
   db.prepare('INSERT OR IGNORE INTO topup_requests('+
     'user_tg_id,method,custom_method_key,amount_iqd,transfer_reference,status,decided_at,'+
     'credited_amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,submission_key,'+
     'transfer_currency,transfer_base_minor,transfer_fee_minor,transfer_total_minor) '+
     'SELECT i.user_tg_id,\'binance\',\'usdt_trc20\',t.credited_iqd,t.txid,\'approved\','+
     'CURRENT_TIMESTAMP,t.credited_iqd,i.requested_currency,i.requested_amount_minor,'+
     'i.quoted_rate_iqd,i.id,\'USD\',CAST(ROUND(t.amount_micro/10000.0) AS INTEGER),0,'+
     'CAST(ROUND(t.amount_micro/10000.0) AS INTEGER) FROM trc20_payment_intents i '+
     'JOIN trc20_single_transfers t ON t.intent_id=i.id '+
     'WHERE i.id=? AND i.status=\'credited\' AND i.txid=?')
     .bind(id,txid),
   db.prepare('INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note) '+
     'SELECT i.user_tg_id,t.credited_iqd,\'topup\',\'trc20-intent:\'||i.id,'+
     '\'USDT TRC20 confirmed single transfer\' FROM trc20_payment_intents i '+
     'JOIN trc20_single_transfers t ON t.intent_id=i.id '+
     'WHERE i.id=? AND i.status=\'credited\' AND i.txid=?')
     .bind(id,txid),
   ...notifications.map(n=>db.prepare('INSERT OR IGNORE INTO notification_outbox('+
     'method,payload,trc20_single_intent_id,trc20_single_recipient_id) '+
     'SELECT \'sendMessage\',?,?,? WHERE EXISTS('+
     'SELECT 1 FROM trc20_payment_intents WHERE id=? AND status=\'credited\' AND txid=?)')
     .bind(JSON.stringify(n),id,n.chat_id,id,txid))
 ];
 const results=await db.batch(steps);
 if(results[0]?.meta?.changes!==1){
   const current=await db.prepare('SELECT txid,status FROM trc20_payment_intents WHERE id=?').bind(id).first();
   return {status:current?.status==='credited'?'duplicate':'expired'};
 }
 if(results[1]?.meta?.changes!==1 || results[2]?.meta?.changes!==1 ||
   results[3]?.meta?.changes!==1)throw new Error('TRC20_SINGLE_SETTLEMENT_INCOMPLETE');
 const topup=await db.prepare('SELECT id,amount_iqd,user_tg_id FROM topup_requests WHERE submission_key=?').bind(id).first();
 return {status:'credited',topup,amountMicro:amount,creditedIqd:credit};
}
