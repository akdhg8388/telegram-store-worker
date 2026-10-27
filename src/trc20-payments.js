import {paymentQuote} from './payment-quote.js';

export const TRC20_METHOD='usdt_trc20';
export const USDT_CONTRACT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TXID=/^[a-fA-F0-9]{64}$/;
const ADDRESS=/^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export const trc20AddressIsValid=x=>ADDRESS.test(String(x||'').trim());
export const trc20TxidIsValid=x=>TXID.test(String(x||'').trim());
export function formatUsdtMicro(micro){
 if(!Number.isSafeInteger(micro)||micro<0)throw new Error('Invalid USDT amount');
 const whole=Math.floor(micro/1000000);
 return whole+'.'+String(micro%1000000).padStart(6,'0')+' USDT';
}
export function isTrc20Method(method){return method===TRC20_METHOD}

export async function newTrc20Intent(db,uid,quote,method){
 const receiver=String(method?.receiver||'').trim();
 if(!trc20AddressIsValid(receiver)||method?.pay_currency!=='USD'||method?.quote_enabled===0)
   throw new Error('TRC20_NOT_CONFIGURED');
 const calculated=paymentQuote(method,quote);
 if(!calculated||calculated.currency!=='USD')throw new Error('TRC20_INVALID_QUOTE');
 const now=Math.floor(Date.now()/1000);
 // Reclaim only expired reservations; never change ledger or credited payments.
 await db.prepare("UPDATE trc20_payment_intents SET status='expired' WHERE status='waiting' AND expires_at<=?").bind(now).run();
 const pending=await db.prepare("SELECT COUNT(*) n FROM trc20_payment_intents WHERE user_tg_id=? AND status='waiting' AND expires_at>?").bind(uid,now).first();
 if(Number(pending?.n||0)>=3)throw new Error('TRC20_TOO_MANY_PENDING');
 const id=crypto.randomUUID();
 for(let i=0;i<18;i++){
   // Six decimal places. Fractional tag (up to 0.009999 USDT) uniquely
   // matches an order when multiple customers use one Binance deposit address.
   const tag=(crypto.getRandomValues(new Uint32Array(1))[0]%9999)+1;
   const micro=calculated.totalMinor*10000+tag;
   try{
     await db.prepare("INSERT INTO trc20_payment_intents(id,user_tg_id,receiver,amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,payment_base_minor,expected_micro,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
       .bind(id,uid,receiver,quote.amountIqd,quote.currency,quote.requestedMinor,quote.rate,calculated.totalMinor,micro,now+30*60).run();
     return {intentId:id,expectedUsdtMicro:micro,receiver,expiresAt:now+30*60};
   }catch(e){if(!/UNIQUE|constraint/i.test(String(e)))throw e}
 }
 throw new Error('TRC20_SLOTS_EXHAUSTED');
}
export async function cancelTrc20Intent(db,uid,id){
 if(!id)return;
 await db.prepare("UPDATE trc20_payment_intents SET status='cancelled' WHERE id=? AND user_tg_id=? AND status='waiting'").bind(id,uid).run();
}
export async function findTrc20Intent(db,uid,id){
 if(!/^[0-9a-f-]{36}$/i.test(String(id||'')))return null;
 return db.prepare('SELECT * FROM trc20_payment_intents WHERE id=? AND user_tg_id=?').bind(id,uid).first();
}
function apiHeaders(env,more={}){
 return {...more,...(env.TRONGRID_API_KEY?{'TRON-PRO-API-KEY':String(env.TRONGRID_API_KEY)}:{})};
}
async function tronFetch(url,env,options={}){
 const res=await fetch(url,{...options,headers:apiHeaders(env,options.headers)});
 if(!res.ok)throw new Error('TRONGRID_HTTP_'+res.status);
 const j=await res.json();
 if(!j||typeof j!=='object'||j.Error||j.success===false)throw new Error('TRONGRID_ERROR');
 return j;
}
export async function verifyTrc20Payment(env,intent,txid){
 const normalized=String(txid||'').trim().toLowerCase();
 if(!TXID.test(normalized))return {status:'invalid'};
 if(!env.TRONGRID_API_KEY)return {status:'unconfigured'};
 const now=Math.floor(Date.now()/1000);
 if(intent.status!=='waiting'||Number(intent.expires_at)<=now)return {status:'expired'};
 if(!trc20AddressIsValid(intent.receiver))return {status:'unconfigured'};
 const minTs=(Number(intent.created_at)-30)*1000;
 // Query the recipient's confirmed USDT transfers only, never other tokens.
 const url=new URL('https://api.trongrid.io/v1/accounts/'+intent.receiver+'/transactions/trc20');
 url.searchParams.set('only_confirmed','true');
 url.searchParams.set('only_to','true');
 url.searchParams.set('contract_address',USDT_CONTRACT);
 url.searchParams.set('min_timestamp',String(minTs));
 url.searchParams.set('limit','200');
 let event=null;let fingerprint=null;
 for(let page=0;page<3;page++){
   if(fingerprint)url.searchParams.set('fingerprint',fingerprint);
   const body=await tronFetch(url.toString(),env);
   const events=Array.isArray(body.data)?body.data:[];
   event=events.find(e=>String(e.transaction_id||'').toLowerCase()===normalized &&
      e.to===intent.receiver &&
      String(e.token_info?.address||'')===USDT_CONTRACT &&
      e.type==='Transfer' &&
      Number(e.block_timestamp)>=minTs);
   if(event)break;
   fingerprint=body.meta?.fingerprint;
   if(!fingerprint||!events.length)break;
 }
 if(!event)return {status:'pending'};
 // TRC20 USDT uses six decimal places. Reject underpayments AND mismatches.
 let micro;try{micro=BigInt(String(event.value))}catch{return {status:'invalid'}}
 if(micro!==BigInt(intent.expected_micro))return {status:'mismatch'};
 // TronGrid's confirmed index is not by itself a final execution receipt.
 const receipt=await tronFetch('https://api.trongrid.io/walletsolidity/gettransactioninfobyid',env,{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:normalized})
 });
 if(String(receipt.id||'').toLowerCase()!==normalized)return {status:'pending'};
 if(receipt.receipt?.result!=='SUCCESS'||receipt.result==='FAILED')return {status:'pending'};
 return {status:'confirmed',txid:normalized};
}
export async function creditVerifiedTrc20(db,uid,id,txid){
 // A single D1 atomic batch: claim the TXID, create an approved top-up, credit
 // through the existing ledger trigger. UNIQUE constraints prevent reuse.
 const statements=[
   db.prepare("UPDATE trc20_payment_intents SET status='credited',txid=?,credited_at=unixepoch() WHERE id=? AND user_tg_id=? AND status='waiting' AND expires_at>unixepoch()")
     .bind(txid,id,uid),
   db.prepare("INSERT INTO topup_requests(user_tg_id,method,custom_method_key,amount_iqd,transfer_reference,status,decided_at,credited_amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,submission_key,transfer_currency,transfer_base_minor,transfer_fee_minor,transfer_total_minor) SELECT user_tg_id,'binance','usdt_trc20',amount_iqd,txid,'approved',CURRENT_TIMESTAMP,amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,id,'USD',payment_base_minor,0,payment_base_minor FROM trc20_payment_intents WHERE id=? AND status='credited' AND txid=?")
     .bind(id,txid),
   db.prepare("INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note) SELECT user_tg_id,amount_iqd,'topup','trc20:'||txid,'Confirmed TRON USDT deposit via TXID' FROM trc20_payment_intents WHERE id=? AND status='credited' AND txid=?")
     .bind(id,txid)
 ];
 const results=await db.batch(statements);
 if(!results[0].meta?.changes||!results[1].meta?.changes||!results[2].meta?.changes)
   throw new Error('TRC20_ALREADY_SETTLED');
 return db.prepare('SELECT id,amount_iqd,user_tg_id FROM topup_requests WHERE submission_key=?').bind(id).first();
}
