import {paymentQuote} from './payment-quote.js';
import {formatIQD,adminIds} from './common.js';

export const TRC20_METHOD='usdt_trc20';
// Public receiving address (never a private key); the QR asset encodes the same address.
export const DEFAULT_TRC20_RECEIVER='TMLhhXpUtAPkaG8Lw6XWuTzzJyou5wMvVR';
export const TRC20_QR_URL='https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/usdt-trc20-qr.png';
export const USDT_CONTRACT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRC20_TTL_SECONDS=15*60;
const TXID=/^[a-fA-F0-9]{64}$/;
const ADDRESS=/^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export const trc20AddressIsValid=x=>ADDRESS.test(String(x||'').trim());
export const trc20TxidIsValid=x=>TXID.test(String(x||'').trim());
export const isTrc20Method=method=>method===TRC20_METHOD;
export function formatUsdtMicro(micro){
 if(!Number.isSafeInteger(micro)||micro<0)throw new Error('Invalid USDT amount');
 return Math.floor(micro/1000000)+'.'+String(micro%1000000).padStart(6,'0')+' USDT';
}
export function configuredTrc20Receiver(env){
 const receiver=String(env?.WALLET_ADDRESS||DEFAULT_TRC20_RECEIVER).trim();
 return trc20AddressIsValid(receiver)?receiver:null;
}
export async function newTrc20Intent(db,uid,quote,method,env={}){
 const receiver=configuredTrc20Receiver(env);
 if(!receiver||!env.TRONGRID_API_KEY||method?.pay_currency!=='USD'||method?.quote_enabled===0)
   throw new Error('TRC20_NOT_CONFIGURED');
 const calculated=paymentQuote(method,quote);
 if(!calculated||calculated.currency!=='USD')throw new Error('TRC20_INVALID_QUOTE');
 const now=Math.floor(Date.now()/1000);
 const pending=await db.prepare("SELECT COUNT(*) n FROM trc20_payment_intents WHERE user_tg_id=? AND status='waiting' AND expires_at>?").bind(uid,now).first();
 if(Number(pending?.n||0)>=3)throw new Error('TRC20_TOO_MANY_PENDING');
 const id=crypto.randomUUID();
 // Use cent-sized unique order tags (e.g. 10.37 USDT). Do not reuse a
 // receiver+amount during the previous 24h: late payments must never fund a new order.
 for(let i=0;i<99;i++){
   const tag=(crypto.getRandomValues(new Uint32Array(1))[0]%99)+1;
   const micro=(calculated.totalMinor+tag)*10000;
   const used=await db.prepare('SELECT 1 found FROM trc20_payment_intents WHERE receiver=? AND expected_micro=? AND created_at>? LIMIT 1')
     .bind(receiver,micro,now-86400).first();
   if(used)continue;
   try{
     await db.prepare("INSERT INTO trc20_payment_intents(id,user_tg_id,receiver,amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,payment_base_minor,expected_micro,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
       .bind(id,uid,receiver,quote.amountIqd,quote.currency,quote.requestedMinor,quote.rate,calculated.totalMinor,micro,now+TRC20_TTL_SECONDS).run();
     return {intentId:id,expectedUsdtMicro:micro,receiver,expiresAt:now+TRC20_TTL_SECONDS};
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
async function tronFetch(url,env,options={}){
 const headers={...(options.headers||{}),'TRON-PRO-API-KEY':String(env.TRONGRID_API_KEY)};
 const res=await fetch(url,{...options,headers});
 if(!res.ok)throw new Error('TRONGRID_HTTP_'+res.status);
 const json=await res.json();
 if(!json||typeof json!=='object'||json.Error||json.success===false)throw new Error('TRONGRID_ERROR');
 return json;
}
export function trc20TransferUrl(receiver,minTime,limit=200){
 const url=new URL('https://api.trongrid.io/v1/accounts/'+receiver+'/transactions/trc20');
 url.searchParams.set('only_confirmed','true');
 url.searchParams.set('only_to','true');
 url.searchParams.set('contract_address',USDT_CONTRACT);
 url.searchParams.set('min_timestamp',String(minTime));
 url.searchParams.set('order_by','block_timestamp,desc');
 url.searchParams.set('limit',String(limit));
 return url;
}
export async function readConfirmedTrc20Transfers(env,receiver,minTime){
 if(!env.TRONGRID_API_KEY || configuredTrc20Receiver(env)!==receiver)throw new Error('TRC20_NOT_CONFIGURED');
 const result=await tronFetch(trc20TransferUrl(receiver,minTime).toString(),env);
 if(!Array.isArray(result.data))throw new Error('TRONGRID_INVALID_RESPONSE');
 return result.data;
}
export function inspectTrc20Transfer(event,intent){
 if(!event||!intent)return {status:'invalid'};
 if(!trc20TxidIsValid(event.transaction_id)||event.to!==intent.receiver ||
    String(event.token_info?.address||'')!==USDT_CONTRACT ||
    String(event.token_info?.decimals||'6')!=='6' ||event.type!=='Transfer'||
    event.confirmed===false)return {status:'invalid'};
 const ts=Number(event.block_timestamp);
 if(!Number.isSafeInteger(ts)||ts<=0)return {status:'invalid'};
 if(ts<Number(intent.created_at)*1000||ts>Number(intent.expires_at)*1000)return {status:'late'};
 let actual;try{actual=BigInt(String(event.value))}catch{return {status:'invalid'}}
 if(actual!==BigInt(intent.expected_micro))return {status:'mismatch'};
 return {status:'confirmed',txid:String(event.transaction_id).toLowerCase(),blockTimestamp:ts};
}
export async function verifyTrc20Payment(env,intent,txid){
 const id=String(txid||'').trim().toLowerCase();
 if(!TXID.test(id))return {status:'invalid'};
 if(!env.TRONGRID_API_KEY||configuredTrc20Receiver(env)!==intent?.receiver)return {status:'unconfigured'};
 if(intent.status!=='waiting'||Number(intent.expires_at)<=Math.floor(Date.now()/1000))return {status:'expired'};
 const url=trc20TransferUrl(intent.receiver,Number(intent.created_at)*1000);
 let candidate=null;
 // TXID fallback can paginate; the CRON path is strictly ONE API request.
 for(let i=0;i<3;i++){
   const j=await tronFetch(url.toString(),env);
   if(!Array.isArray(j.data))throw new Error('TRONGRID_INVALID_RESPONSE');
   candidate=j.data.find(x=>String(x.transaction_id||'').toLowerCase()===id) || null;
   if(candidate)break;
   if(!j.data.length||!j.meta?.fingerprint)break;
   url.searchParams.set('fingerprint',j.meta.fingerprint);
 }
 if(!candidate)return {status:'pending'};
 const checked=inspectTrc20Transfer(candidate,intent);
 if(checked.status!=='confirmed')return checked;
 // On-demand verification also validates the successful Solidity receipt.
 const receipt=await tronFetch('https://api.trongrid.io/walletsolidity/gettransactioninfobyid',env,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:id})
 });
 if(String(receipt.id||'').toLowerCase()!==id||receipt.receipt?.result!=='SUCCESS')
   return {status:'pending'};
 return checked;
}
export async function creditVerifiedTrc20(db,uid,id,txid,env={},blockTimestamp=null){
 if(!trc20TxidIsValid(txid))throw new Error('INVALID_TXID');
 const normalized=txid.toLowerCase();
 const intent=await db.prepare('SELECT * FROM trc20_payment_intents WHERE id=? AND user_tg_id=?').bind(id,uid).first();
 if(!intent||intent.status!=='waiting'||Number(intent.expires_at)<=Math.floor(Date.now()/1000))
   throw new Error('TRC20_ORDER_NOT_ACTIVE');
 if(configuredTrc20Receiver(env)!==intent.receiver)throw new Error('TRC20_RECEIVER_CHANGED');
 const ts=blockTimestamp===null?Math.floor(Date.now()/1000)*1000:blockTimestamp;
 if(!Number.isSafeInteger(ts)||ts<intent.created_at*1000||ts>intent.expires_at*1000)
   throw new Error('TRC20_TRANSFER_OUTSIDE_WINDOW');
 const confirmation='✅ تم شحن محفظتك تلقائياً بعد تأكيد حوالة USDT TRC20.\n💰 الرصيد المضاف: '+formatIQD(intent.amount_iqd)+
  '\n💸 المبلغ المستلم: '+formatUsdtMicro(intent.expected_micro)+'\n🔖 TXID: '+normalized;
 const notifications=[
   {chat_id:uid,text:confirmation},
   ...adminIds(env).map(owner=>({chat_id:owner,text:'✅ شحن TRC20 تلقائي ناجح\n👤 العميل: '+uid+
      '\n💰 المضاف: '+formatIQD(intent.amount_iqd)+'\n💵 الوارد: '+formatUsdtMicro(intent.expected_micro)+
      '\n🧾 TXID: '+normalized}))
 ];
 const steps=[
   db.prepare("UPDATE trc20_payment_intents SET status='credited',txid=?,credited_at=unixepoch() WHERE id=? AND user_tg_id=? AND status='waiting' AND expires_at>unixepoch() AND created_at*1000<=? AND expires_at*1000>=?")
     .bind(normalized,id,uid,ts,ts),
   db.prepare("INSERT INTO topup_requests(user_tg_id,method,custom_method_key,amount_iqd,transfer_reference,status,decided_at,credited_amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,submission_key,transfer_currency,transfer_base_minor,transfer_fee_minor,transfer_total_minor) SELECT user_tg_id,'binance','usdt_trc20',amount_iqd,txid,'approved',CURRENT_TIMESTAMP,amount_iqd,requested_currency,requested_amount_minor,quoted_rate_iqd,id,'USD',payment_base_minor,0,payment_base_minor FROM trc20_payment_intents WHERE id=? AND status='credited' AND txid=?")
     .bind(id,normalized),
   db.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note) SELECT user_tg_id,amount_iqd,'topup','trc20:'||txid,'TRC20 USDT confirmed on chain' FROM trc20_payment_intents WHERE id=? AND status='credited' AND txid=?")
     .bind(id,normalized),
   ...notifications.map(n=>db.prepare("INSERT INTO notification_outbox(method,payload) SELECT 'sendMessage',? WHERE EXISTS (SELECT 1 FROM trc20_payment_intents WHERE id=? AND status='credited' AND txid=?)")
     .bind(JSON.stringify(n),id,normalized))
 ];
 const results=await db.batch(steps);
 if(results.slice(0,3).some(r=>r.meta?.changes!==1))throw new Error('TRC20_SETTLEMENT_NOT_ATOMIC');
 return db.prepare('SELECT id,amount_iqd,user_tg_id FROM topup_requests WHERE submission_key=?').bind(id).first();
}
export async function notifyTrc20Alert(db,env,intent,txid,reason){
 if(!intent||!trc20TxidIsValid(txid))return false;
 const normalized=txid.toLowerCase();
 const r=await db.prepare('INSERT OR IGNORE INTO trc20_payment_alerts(intent_id,txid,reason) VALUES (?,?,?)')
   .bind(intent.id,normalized,String(reason).slice(0,90)).run();
 if(!r.meta?.changes)return false;
 for(const owner of adminIds(env)){
   const payload={chat_id:owner,text:'🚨 تحويل USDT TRC20 بحاجة لمراجعتك\n⚠️ السبب: '+reason+
     '\n👤 العميل: '+intent.user_tg_id+'\n💵 المبلغ المطلوب: '+formatUsdtMicro(intent.expected_micro)+
     '\n🧾 TXID: '+normalized+'\n❗ لم تُضف أي أرصدة تلقائياً.'};
   await db.prepare("INSERT INTO notification_outbox(method,payload) VALUES('sendMessage',?)").bind(JSON.stringify(payload)).run();
 }
 return true;
}
