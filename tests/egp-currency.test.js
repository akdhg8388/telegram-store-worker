import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {
  formatEgpMinor,formatPreferredIQD,egpQuoteToIQD,parseEgpPerUsdMinor,egpRate
} from '../src/display-currency.js';
import {quoteFromUSD,egpTopupQuote,formatQuote,parseCustomMinor,topupStatusMessage} from '../src/wallet.js';
import {getUser} from '../src/database.js';
import {validateSetting,updateSetting} from '../src/settings.js';
import {paymentQuote} from '../src/payment-quote.js';
import {currencyMenu} from '../src/ui.js';

function setup(){
 const c=new DatabaseSync(':memory:');
 c.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\d\d_.+\.sql$/.test(n)).sort())
   c.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const db={prepare(sql){
  const stmt=c.prepare(sql);let args=[];const q={
   bind(...items){args=items;return q},
   async first(){return stmt.get(...args)||null},
   async all(){return {results:stmt.all(...args)}},
   async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
  };return q;
 }};
 return {c,db};
}
test('EGP is fixed and display-only: $500 is 27,120 EGP at 54.24; IQD remains 760,000',()=>{
 const quote=quoteFromUSD(500,1520,'IQD');
 const egp={...quote,displayCurrency:'EGP',displayMinor:500*5424,egpRateMinor:5424};
 assert.equal(formatQuote(egp),'27,120.00 ج.م');
 assert.equal(formatPreferredIQD(760000,'EGP',1520,5424),'27,120.00 ج.م');
 assert.equal(formatPreferredIQD(760000,'IQD',1520,5424),'760,000 د.ع');
 assert.equal(quote.amountIqd,760000);
 assert.equal(egpTopupQuote(500*5424,1520,5424).amountIqd,760000);
 assert.equal(egpQuoteToIQD(50000,1520,5424),14012);
 assert.equal(formatEgpMinor(50000),'500.00 ج.م');
 assert.equal(parseCustomMinor('100000.50','EGP'),10000050);
 assert.equal(parseEgpPerUsdMinor('54.24'),5424);
 assert.equal(parseEgpPerUsdMinor('0'),null);
 assert.equal(parseEgpPerUsdMinor('54.245'),null);
});
test('EGP rate belongs to the owner, no FX API, and default USD/IQD wallets survive overlay disable',async()=>{
 const {c,db}=setup();
 try{
  c.prepare("INSERT INTO users(tg_id,first_name,currency_preference,wallet_balance_iqd) VALUES (401,'Egypt','USD',15200)").run();
  const old=c.prepare('SELECT wallet_balance_iqd,currency_preference FROM users WHERE tg_id=401').get();
  assert.equal(await egpRate(db),5424);
  c.prepare('INSERT INTO user_egp_display(user_tg_id) VALUES(401)').run();
  assert.equal((await getUser(db,401)).currency_preference,'EGP');
  assert.equal((await getUser(db,401)).wallet_balance_iqd,15200);
  assert.equal(validateSetting('egp_rate_per_usd','53.90').ok,true);
  assert.equal(validateSetting('egp_rate_per_usd','error').ok,false);
  await updateSetting(db,'egp_rate_per_usd','53.90',401);
  assert.equal(await egpRate(db),5390);
  await updateSetting(db,'egp_display_enabled','false',401);
  c.prepare('UPDATE user_egp_display SET enabled=0 WHERE user_tg_id=401').run();
  assert.equal((await getUser(db,401)).currency_preference,'USD');
  assert.deepEqual(c.prepare('SELECT wallet_balance_iqd,currency_preference FROM users WHERE tg_id=401').get(),old);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
 }finally{c.close()}
});
test('Egyptian EGP input keeps payment rails in real USD/IQD, no EGP stored in legacy currency checks',()=>{
 const quote=egpTopupQuote(542400,1520,5424);
 assert.equal(quote.currency,'IQD');
 assert.equal(quote.amountIqd,152000);
 const usd=paymentQuote({pay_currency:'USD',quote_enabled:1,fee_mode:'none',fee_value:0},quote);
 assert.equal(usd.currency,'USD');
 assert.equal(usd.totalMinor,10000);
 const invoice={
   id:33,amount_iqd:152000,requested_currency:'IQD',requested_amount_minor:152000,
   quoted_rate_iqd:1520,credited_amount_iqd:76000,status:'approved',method:'binance',created_at:'2026-11-09 10:00:00'
 };
 const shown=topupStatusMessage(invoice,'EGP',1520,5424);
 assert.ok(shown.includes('5,424.00 ج.م'));
 assert.ok(shown.includes('2,712.00 ج.م'));
 assert.ok(!shown.includes('152,000 د.ع'));
});

test('currency menu shows EGP for USD and IQD customers, with the owner-set fixed rate',async()=>{
 const {c,db}=setup();
 const oldFetch=globalThis.fetch;
 const sent=[];
 globalThis.fetch=async(_url,options)=>{
   sent.push(JSON.parse(options.body));
   return new Response(JSON.stringify({ok:true,result:{message_id:1001}}),{status:200});
 };
 try{
   c.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES (601,'USD User','USD'),(602,'IQD User','IQD')").run();
   c.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520')").run();
   const env={TELEGRAM_BOT_TOKEN:'TEST',ADMIN_ID:'999'};
   for(const uid of [601,602]){
     await currencyMenu(db,env,uid);
     const message=sent.at(-1);
     const callbacks=message.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
     assert.ok(callbacks.includes('currency_set:USD'));
     assert.ok(callbacks.includes('currency_set:IQD'));
     assert.ok(callbacks.includes('currency_set:EGP'),'EGP hidden for current '+uid);
     assert.match(message.text,/54\.24/);
   }
   await updateSetting(db,'egp_rate_per_usd','53.90',999);
   await currencyMenu(db,env,601);
   assert.match(sent.at(-1).text,/53\.90/);
   assert.ok(sent.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='currency_set:EGP'));
   await updateSetting(db,'egp_display_enabled','false',999);
   await currencyMenu(db,env,601);
   assert.ok(!sent.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='currency_set:EGP'));
   assert.equal(c.prepare("SELECT currency_preference FROM users WHERE tg_id=601").get().currency_preference,'USD');
 }finally{
   globalThis.fetch=oldFetch;
   c.close();
 }
});
