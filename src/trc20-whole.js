import {trc20TxidIsValid,configuredTrc20Receiver} from './trc20-payments.js';
import {creditedTrc20IQD} from './trc20-single.js';

// On a shared public address, TXID is NOT proof that the claimant sent the
// funds. Confirm with TronGrid, then require owner attribution before credit.
export async function submitWholeTrc20ForReview(db,uid,id,proof,env={}){
 const txid=String(proof?.txid||'').trim().toLowerCase(),micro=Number(proof?.amountMicro),ts=Number(proof?.blockTimestamp);
 if(!trc20TxidIsValid(txid)||!Number.isSafeInteger(micro)||micro<=0||!Number.isSafeInteger(ts)||ts<=0)return {status:'invalid'};
 const intent=await db.prepare('SELECT * FROM trc20_payment_intents WHERE id=? AND user_tg_id=?').bind(id,uid).first();
 if(!intent||intent.integer_only!==1||intent.status!=='waiting'||intent.expires_at<=Math.floor(Date.now()/1000))return {status:'expired'};
 if(intent.receiver!==configuredTrc20Receiver(env))return {status:'unconfigured'};
 if(ts<intent.created_at*1000||ts>intent.expires_at*1000)return {status:'late'};
 const credit=creditedTrc20IQD(intent,micro);
 if(!credit)return {status:'amount_out_of_range'};
 const duplicate=await db.prepare("SELECT 1 x FROM trc20_payment_intents WHERE txid=? UNION SELECT 1 FROM trc20_payment_parts WHERE txid=? UNION SELECT 1 FROM trc20_single_transfers WHERE txid=? UNION SELECT 1 FROM topup_requests WHERE method='binance' AND transfer_reference=? LIMIT 1").bind(txid,txid,txid,txid).first();
 if(duplicate)return {status:'duplicate'};
 const cents=Math.round(micro/10000);
 let rows;
 try{rows=await db.batch([
   db.prepare("INSERT OR IGNORE INTO topup_requests (user_tg_id,method,custom_method_key,amount_iqd,transfer_reference,status,requested_currency,requested_amount_minor,quoted_rate_iqd,submission_key,transfer_currency,transfer_base_minor,transfer_fee_minor,transfer_total_minor) "+
      "SELECT user_tg_id,'binance','usdt_trc20',?,?,'pending',requested_currency,requested_amount_minor,quoted_rate_iqd,id,'USD',?,0,? FROM trc20_payment_intents WHERE id=? AND user_tg_id=? AND integer_only=1 AND status='waiting' AND expires_at>unixepoch() AND ? BETWEEN created_at*1000 AND expires_at*1000")
    .bind(credit,txid,cents,cents,id,uid,ts),
   db.prepare("UPDATE trc20_payment_intents SET status='cancelled',txid=? WHERE id=? AND user_tg_id=? AND status='waiting' AND integer_only=1 AND EXISTS(SELECT 1 FROM topup_requests WHERE submission_key=? AND transfer_reference=? AND user_tg_id=? AND status='pending')")
    .bind(txid,id,uid,id,txid,uid)
 ])}catch(e){if(/UNIQUE|constraint/i.test(String(e)))return {status:'duplicate'};throw e}
 if(rows[0]?.meta?.changes!==1||rows[1]?.meta?.changes!==1)return {status:'duplicate'};
 const topup=await db.prepare('SELECT id FROM topup_requests WHERE submission_key=? AND user_tg_id=?').bind(id,uid).first();
 if(intent.display_lyd_amount_milli!=null&&Number.isSafeInteger(intent.display_lyd_amount_milli)&&topup?.id)
    await db.prepare("UPDATE topup_requests SET display_lyd_amount_milli=?,display_lyd_per_usd_milli=? WHERE id=? AND user_tg_id=? AND status='pending'")
      .bind(intent.display_lyd_amount_milli,intent.display_lyd_per_usd_milli,topup.id,uid).run();
 if(intent.display_currency==='EGP'&&Number.isSafeInteger(intent.display_amount_minor)&&topup?.id)
   await db.prepare("UPDATE topup_requests SET display_currency='EGP',display_amount_minor=?,display_egp_per_usd_minor=? WHERE id=? AND user_tg_id=? AND status='pending'")
     .bind(intent.display_amount_minor,intent.display_egp_per_usd_minor,topup.id,uid).run();
 return {status:'pending_review',topupId:topup.id,creditedIqd:credit,amountMicro:micro};
}
