import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {
 newTrc20Intent,inspectTrc20Transfer,TRC20_TTL_SECONDS,uniqueTrc20FractionMatches,
 TRC20_METHOD,configuredTrc20Receiver,USDT_CONTRACT
} from '../src/trc20-payments.js';
import {creditedTrc20IQD,settleTrc20Single} from '../src/trc20-single.js';

const receiver='TMLhhXpUtAPkaG8Lw6XWuTzzJyou5wMvVR';
const env={WALLET_ADDRESS:receiver,TRONGRID_API_KEY:'TEST_ONLY',ADMIN_ID:'991'};
function setup(){
 const c=new DatabaseSync(':memory:');c.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^00\d\d_.+\.sql$/.test(x)).sort())
  c.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 c.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Buyer'),(102,'Other'),(991,'Admin')").run();
 const db={
  prepare(sql){const stmt=c.prepare(sql);let args=[];const q={
   bind(...x){args=x;return q},
   async first(){return stmt.get(...args)||null},
   async all(){return {results:stmt.all(...args)}},
   async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
  };return q;},
  async batch(items){c.exec('BEGIN IMMEDIATE');try{
   const result=[];for(const item of items)result.push(await item.run());
   c.exec('COMMIT');return result;
  }catch(e){c.exec('ROLLBACK');throw e}}
 };
 return {c,db};
}
const method={method_key:TRC20_METHOD,pay_currency:'USD',quote_enabled:1,fee_mode:'none',fee_value:0};
const quote={currency:'USD',requestedMinor:50000,amountIqd:760000,rate:1520};
async function order(db,uid=101){
 const value=await newTrc20Intent(db,uid,quote,method,env);
 const intent=await db.prepare('SELECT * FROM trc20_payment_intents WHERE id=?').bind(value.intentId).first();
 return {value,intent};
}
function proof(intent,whole,digit='a'){
 const amountMicro=whole*1000000+Number(intent.expected_micro)%1000000;
 return {txid:digit.repeat(64),amountMicro,blockTimestamp:(Math.floor(Date.now()/1000)+1)*1000};
}
test('new topups have 25-minute lifetime, no split claims, and unique full six-decimal fraction',async()=>{
 const {c,db}=setup();try{
  assert.equal(TRC20_TTL_SECONDS,1500);
  const {intent}=await order(db);
  const {intent:other}=await order(db,102);
  assert.equal(intent.flexible_amount,1);
  assert.equal(intent.expires_at-intent.created_at,1500);
  assert.notEqual(intent.expected_micro%1000000,other.expected_micro%1000000);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM trc20_payment_quotes').get().n,0);
  assert.equal(uniqueTrc20FractionMatches(intent,proof(intent,300).amountMicro),true);
  assert.equal(uniqueTrc20FractionMatches(intent,proof(intent,600).amountMicro+1),false);
 }finally{c.close()}
});
test('a verified $300.x transfer for a requested $500 credits the actual amount once',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  const payment=proof(intent,300,'a');
  const settled=await settleTrc20Single(db,101,intent.id,payment,env);
  assert.equal(settled.status,'credited');
  const expected=creditedTrc20IQD(intent,payment.amountMicro);
  assert.equal(settled.creditedIqd,expected);
  assert.ok(expected<760000);
  assert.equal(c.prepare('SELECT wallet_balance_iqd AS b FROM users WHERE tg_id=101').get().b,expected);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE kind=\'topup\'').get().n,1);
  assert.equal(c.prepare('SELECT credited_amount_iqd AS x FROM topup_requests WHERE submission_key=?').get(intent.id).x,expected);
  assert.equal(c.prepare('SELECT status FROM trc20_payment_intents WHERE id=?').get(intent.id).status,'credited');
  assert.equal((await settleTrc20Single(db,101,intent.id,payment,env)).status,'expired');
  assert.equal(c.prepare('SELECT wallet_balance_iqd AS b FROM users WHERE tg_id=101').get().b,expected);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE trc20_single_intent_id=?').get(intent.id).n,2);
 }finally{c.close()}
});
test('a verified $600.x transfer for a requested $500 credits $600.x, never the quote',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  const paid=proof(intent,600,'b');
  const result=await settleTrc20Single(db,101,intent.id,paid,env);
  assert.equal(result.status,'credited');
  const actual=creditedTrc20IQD(intent,paid.amountMicro);
  assert.ok(actual>760000);
  assert.equal(c.prepare('SELECT wallet_balance_iqd AS b FROM users WHERE tg_id=101').get().b,actual);
  assert.equal(c.prepare('SELECT amount_iqd AS b FROM topup_requests WHERE submission_key=?').get(intent.id).b,actual);
 }finally{c.close()}
});
test('reject mismatched fingerprint, forged user, repeated TXID and expired/future timestamp without credit',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  const normal=proof(intent,300,'c');
  assert.equal((await settleTrc20Single(db,102,intent.id,normal,env)).status,'expired');
  assert.equal((await settleTrc20Single(db,101,intent.id,{...normal,amountMicro:normal.amountMicro+1},env)).status,'unreserved');
  assert.equal((await settleTrc20Single(db,101,intent.id,{...normal,blockTimestamp:(intent.expires_at+1)*1000},env)).status,'late');
  const other=await order(db,102);
  assert.equal((await settleTrc20Single(db,101,intent.id,normal,env)).status,'credited');
  assert.equal((await settleTrc20Single(db,102,other.intent.id,normal,env)).status,'unreserved');
  const second={...proof(other.intent,400,'c'),txid:normal.txid};
  assert.equal((await settleTrc20Single(db,102,other.intent.id,second,env)).status,'duplicate');
  assert.equal(c.prepare('SELECT wallet_balance_iqd b FROM users WHERE tg_id=102').get().b,0);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM topup_requests WHERE custom_method_key=\'usdt_trc20\'').get().n,1);
 }finally{c.close()}
});
test('cron transfer inspection accepts only confirmed USDT, recipient, time, and reserved fraction',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  const verified=proof(intent,300,'d');
  const event={transaction_id:verified.txid,block_timestamp:verified.blockTimestamp,
   token_info:{address:USDT_CONTRACT,decimals:6},to:receiver,type:'Transfer',confirmed:true,
   value:String(verified.amountMicro)};
  const ok=inspectTrc20Transfer(event,intent);
  assert.equal(ok.status,'confirmed');
  assert.equal(ok.amountMicro,verified.amountMicro);
  assert.equal(inspectTrc20Transfer({...event,value:String(verified.amountMicro+1)},intent).status,'mismatch');
  assert.equal(inspectTrc20Transfer({...event,to:'Other'},intent).status,'invalid');
  assert.equal(inspectTrc20Transfer({...event,confirmed:false},intent).status,'invalid');
  assert.equal(inspectTrc20Transfer({...event,token_info:{address:'Other',decimals:6}},intent).status,'invalid');
  assert.equal(inspectTrc20Transfer({...event,block_timestamp:(intent.expires_at+5)*1000},intent).status,'late');
 }finally{c.close()}
});

test('automatic cron credits the exact received USDT transfer and ignores unrelated amounts',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  const paid=proof(intent,300,'e');
  const event={transaction_id:paid.txid,to:receiver,type:'Transfer',confirmed:true,
   token_info:{address:USDT_CONTRACT,decimals:6},block_timestamp:paid.blockTimestamp,
   value:String(paid.amountMicro)};
  const previous=globalThis.fetch;
  let requests=0;
  globalThis.fetch=async(url)=>{
   if(!String(url).includes('transactions/trc20'))throw Error('Unexpected HTTP request');
   requests++;
   return new Response(JSON.stringify({data:[
     {...event,value:String(paid.amountMicro+1),transaction_id:'1'.repeat(64)},
     event
   ]}),{status:200});
  };
  try{
   const {pollTrc20Payments}=await import('../src/trc20-cron.js');
   const first=await pollTrc20Payments(db,env);
   assert.equal(first.credited,1);
   assert.equal(first.networkCalls,1);
   assert.equal(c.prepare('SELECT wallet_balance_iqd b FROM users WHERE tg_id=101').get().b,
     creditedTrc20IQD(intent,paid.amountMicro));
   const twice=await pollTrc20Payments(db,env);
   assert.equal(twice.credited,0);
   assert.equal(c.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='topup'").get().n,1);
   assert.ok(requests>=1);
  }finally{globalThis.fetch=previous}
 }finally{c.close()}
});
test('Paid button followed by a final verified TXID credits once without split steps',async()=>{
 const {c,db}=setup();try{
  const {intent}=await order(db);
  // A real wallet top-up session is only processed while top-ups are enabled.
  c.prepare("INSERT INTO bot_settings(key,value) VALUES('manual_topups_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  const paid=proof(intent,600,'f');
  const {tronAddressHex}=await import('../src/trc20-payments.js');
  const hex=await tronAddressHex(receiver);
  const receipt={id:paid.txid,receipt:{result:'SUCCESS'},blockTimeStamp:paid.blockTimestamp,
   log:[{address:'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
     topics:['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
       '0'.repeat(64),'0'.repeat(24)+hex],
     data:paid.amountMicro.toString(16).padStart(64,'0')}]};
  const priorFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
   const name=String(url);
   if(name.includes('/walletsolidity/gettransactioninfobyid'))
    return new Response(JSON.stringify(receipt),{status:200});
   const method=name.split('/').at(-1);
   calls.push({method,body:JSON.parse(options.body)});
   return new Response(JSON.stringify({ok:true,result:{message_id:719}}),{status:200});
  };
  try{
   const {processUpdate}=await import('../src/bot.js');
   const tasks=[];
   const ctx={waitUntil(p){tasks.push(p)}};
   const e={...env,TELEGRAM_BOT_TOKEN:'MOCK'};
   await processUpdate(db,e,ctx,{update_id:990101,callback_query:{
     id:'paid-button',from:{id:101,first_name:'Buyer'},
     message:{chat:{type:'private',id:101},message_id:713},data:'topup_trc20_paid:'+intent.id}});
   assert.equal(c.prepare('SELECT action FROM user_sessions WHERE user_tg_id=101').get().action,'topup_trc20_txid');
   assert.ok(calls.some(x=>x.method==='sendMessage'&&x.body.text.includes('TXID')));
   await processUpdate(db,e,ctx,{update_id:990102,message:{
     from:{id:101,first_name:'Buyer'},chat:{type:'private',id:101},
     message_id:714,text:paid.txid}});
   await Promise.all(tasks);
   assert.equal(c.prepare('SELECT wallet_balance_iqd b FROM users WHERE tg_id=101').get().b,
     creditedTrc20IQD(intent,paid.amountMicro));
   assert.equal(c.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='topup'").get().n,1);
   assert.ok(calls.some(x=>x.method==='sendMessage'&&x.body.text.includes('تم تأكيد تحويل USDT')));
  }finally{globalThis.fetch=priorFetch}
 }finally{c.close()}
});
