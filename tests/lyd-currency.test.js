import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {
 parseLydPerUsdMilli,formatLydMilli,lydQuoteToIQD,lydRate,
 lydRateFromVisual,formatPreferredIQD,rateFromVisual,egpRate
} from '../src/display-currency.js';
import {
 formatQuote,quoteFromUSD,lydTopupQuote,parseCustomMinor,topupStatusMessage,quoteOfRecord,usdRate
} from '../src/wallet.js';
import {getUser} from '../src/database.js';
import {validateSetting,updateSetting} from '../src/settings.js';
import {home,products,productView,wallet,currencyMenu,walletSummary,topupPresets} from '../src/ui.js';
import {paymentQuote} from '../src/payment-quote.js';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback,adminRoute} from '../src/admin-controls.js';

function fixture(){
 const c=new DatabaseSync(':memory:');
 c.exec('PRAGMA foreign_keys=ON');
 for(const name of readdirSync(new URL('../migrations/',import.meta.url))
   .filter(n=>/^00\d\d_.+\.sql$/.test(n)).sort()){
   c.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 }
 const db={prepare(sql){const stmt=c.prepare(sql);let values=[];
   const q={bind(...args){values=args;return q},
     async first(){return stmt.get(...values)??null},
     async all(){return {results:stmt.all(...values)}},
     async run(){const r=stmt.run(...values);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
   };return q;},
   async batch(stmts){c.exec('BEGIN');try{
     const out=[];for(const s of stmts)out.push(await s.run());
     c.exec('COMMIT');return out;
   }catch(e){c.exec('ROLLBACK');throw e}}
 };return {c,db};
}
async function capture(fn){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(_url,opts)=>{
   const p=JSON.parse(opts.body);calls.push(p);
   return new Response(JSON.stringify({ok:true,result:{message_id:765}}),{status:200});
 };
 try{await fn(calls);}finally{globalThis.fetch=old}
}
const env={STORE_NAME:'My Store',TELEGRAM_BOT_TOKEN:'TEST_ONLY',ADMIN_ID:'991'};

test('LYD uses 3 fractional digits and exact fixed-rate conversion without an FX API',()=>{
 assert.equal(parseLydPerUsdMilli('6.43'),6430);
 assert.equal(parseLydPerUsdMilli('6.435'),6435);
 assert.equal(parseLydPerUsdMilli('0'),null);
 assert.equal(parseLydPerUsdMilli('6.4352'),null);
 assert.equal(formatLydMilli(643000),'643.000 د.ل');
 assert.equal(formatPreferredIQD(152000,'LYD',1520,6430),'643.000 د.ل');
 assert.equal(lydQuoteToIQD(643000,1520,6430),152000);
 assert.equal(lydRateFromVisual({}),6430);
 assert.equal(lydRateFromVisual({lyd_rate_per_usd:'6.50'}),6500);
 assert.equal(lydRateFromVisual({lyd_rate_per_usd:'invalid'}),null);
 assert.equal(rateFromVisual({}),5424);
 assert.equal(formatPreferredIQD(152000,'EGP',1520,5424),'5,424.00 ج.م');
 assert.equal(formatPreferredIQD(152000,'USD',1520,null),'$100.00');
 assert.equal(formatPreferredIQD(152000,'IQD',1520,null),'152,000 د.ع');
 assert.equal(parseCustomMinor('643.500','LYD'),643500);
 assert.equal(parseCustomMinor('643.5555','LYD'),null);
 assert.equal(parseCustomMinor('500.50','EGP'),50050);
});

test('LYD selection preserves exact wallet balance and existing EGP accounts',async()=>{
 const {c,db}=fixture();
 try{
   c.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(701,'Libya','USD'),(702,'Egypt','IQD')").run();
   c.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520')").run();
   c.prepare("INSERT INTO user_lyd_display(user_tg_id) VALUES(701)").run();
   c.prepare("INSERT INTO user_egp_display(user_tg_id) VALUES(702)").run();
   c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(701,152000,'topup','libya-example')").run();
   assert.equal((await getUser(db,701)).currency_preference,'LYD');
   assert.equal((await getUser(db,702)).currency_preference,'EGP');
   assert.equal(await lydRate(db),6430);
   assert.equal((await walletSummary(db,701)).shown,'643.000 د.ل');
   assert.equal((await walletSummary(db,702)).shown,'0.00 ج.م');
   assert.equal(validateSetting('lyd_rate_per_usd','6.435').ok,true);
   assert.equal(validateSetting('lyd_rate_per_usd','wrong').ok,false);
   await updateSetting(db,'lyd_rate_per_usd','6.50',991);
   assert.equal(await lydRate(db),6500);
   assert.equal((await walletSummary(db,701)).shown,'650.000 د.ل');
   c.prepare('UPDATE user_lyd_display SET enabled=0 WHERE user_tg_id=701').run();
   assert.equal((await getUser(db,701)).currency_preference,'USD');
   assert.equal(c.prepare('SELECT wallet_balance_iqd n FROM users WHERE tg_id=701').get().n,152000);
   assert.equal(c.prepare('SELECT count(*) n FROM wallet_ledger WHERE user_tg_id=701').get().n,1);
 }finally{c.close()}
});

test('All main customer surfaces and LYD selection display real Libyan amounts',async()=>{
 const {c,db}=fixture();
 try{await capture(async calls=>{
   c.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(703,'User LYD','USD')").run();
   c.prepare("INSERT INTO user_lyd_display(user_tg_id) VALUES(703)").run();
   c.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520')").run();
   c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(703,152000,'topup','lyd-test-703')").run();
   c.prepare("INSERT INTO products(category_id,title,price_stars,stock,active,featured,price_iqd) VALUES(1,'LYD test item',1,1,1,1,152000)").run();
   await home(db,env,703);
   assert.match(calls.at(-1).text,/643\.000 د\.ل/);
   assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.text?.includes('643.000 د.ل')));
   await products(db,env,703);
   assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.text?.includes('643.000 د.ل')));
   const id=c.prepare("SELECT id FROM products WHERE title='LYD test item'").get().id;
   await productView(db,env,703,id);
   assert.match(calls.at(-1).text,/643\.000 د\.ل/);
   await wallet(db,env,703);
   assert.match(calls.at(-1).text,/643\.000 د\.ل/);
   await currencyMenu(db,env,703);
   const buttons=calls.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
   for(const currency of ['USD','IQD','EGP','LYD'])assert.ok(buttons.includes('currency_set:'+currency),currency);
   await topupPresets(db,env,703);
   assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.text?.includes('64.300 د.ل')));
   assert.equal(c.prepare('SELECT wallet_balance_iqd n FROM users WHERE tg_id=703').get().n,152000);
 });}finally{c.close()}
});

test('Libyan topups are display-only: existing IQD payment rails, original amount and rate persist',()=>{
 const quote=lydTopupQuote(643000,1520,6430);
 assert.equal(quote.currency,'IQD');
 assert.equal(quote.amountIqd,152000);
 assert.equal(quote.displayCurrency,'LYD');
 assert.equal(formatQuote(quote),'643.000 د.ل');
 const transfer=paymentQuote({pay_currency:'USD',quote_enabled:1,fee_mode:'none',fee_value:0},quote);
 assert.equal(transfer.currency,'USD');
 assert.equal(transfer.totalMinor,10000);
 const request={
   id:51,amount_iqd:152000,requested_currency:'IQD',requested_amount_minor:152000,
   quoted_rate_iqd:1520,display_lyd_amount_milli:643000,
   display_lyd_per_usd_milli:6430,credited_amount_iqd:76000,
   method:'binance',status:'approved',created_at:'2026-11-09 10:00:00'
 };
 assert.match(topupStatusMessage(request,'LYD',1520,6430),/643\.000 د\.ل/);
 assert.match(topupStatusMessage(request,'LYD',1520,6430),/321\.500 د\.ل/);
 assert.equal(formatQuote({...request,displayCurrency:'LYD'}),'643.000 د.ل');
 assert.equal(formatQuote(quoteOfRecord(request)),'643.000 د.ل');
 assert.equal(quoteFromUSD(100,1520,'IQD').amountIqd,152000);
});


test('Customer can switch LYD, EGP, USD and IQD without changing wallet ledger',async()=>{
 const {c,db}=fixture();
 try{await capture(async calls=>{
   c.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(704,'Switcher','USD')").run();
   c.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520')").run();
   c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(704,152000,'topup','currency-switch-test')").run();
   const jobs=[];
   const send=async(data,id)=>processUpdate(db,env,{waitUntil(p){jobs.push(p)}},{
     update_id:id,callback_query:{id:'lyd'+id,from:{id:704,first_name:'Switcher'},message:{message_id:900,chat:{id:704,type:'private'}},data}
   });
   await send('currency_set:LYD',940001);
   assert.equal((await getUser(db,704)).currency_preference,'LYD');
   assert.equal((await walletSummary(db,704)).shown,'643.000 د.ل');
   await send('currency_set:EGP',940002);
   assert.equal((await getUser(db,704)).currency_preference,'EGP');
   assert.equal(c.prepare('SELECT COUNT(*) n FROM user_lyd_display WHERE user_tg_id=704').get().n,0);
   await send('currency_set:USD',940003);
   assert.equal((await getUser(db,704)).currency_preference,'USD');
   await send('currency_set:IQD',940004);
   assert.equal((await getUser(db,704)).currency_preference,'IQD');
   assert.equal(c.prepare('SELECT wallet_balance_iqd n FROM users WHERE tg_id=704').get().n,152000);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE user_tg_id=704').get().n,1);
   assert.ok(calls.some(x=>x.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='currency_set:LYD')));
 });}finally{c.close()}
});

test('Owner manages LYD rate and visibility, preserving the Egyptian exchange setting',async()=>{
 const {c,db}=fixture();
 try{await capture(async calls=>{
   c.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(991,'Owner','USD'),(705,'Customer','USD')").run();
   c.prepare('INSERT INTO user_lyd_display(user_tg_id) VALUES(705)').run();
   assert.equal(adminRoute('admin_lyd'),true);
   assert.equal(adminRoute('admin_lyd_toggle'),true);
   assert.equal(await handleAdminCallback(db,env,991,'admin_lyd'),true);
   assert.ok(calls.at(-1).text.includes('6.43'));
   assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='admin_setting_edit:lyd_rate_per_usd'));
   await handleAdminCallback(db,env,991,'admin_lyd_toggle');
   assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='lyd_display_enabled'").get().value,'false');
   assert.equal((await getUser(db,705)).currency_preference,'USD');
   assert.equal(c.prepare('SELECT enabled FROM user_lyd_display WHERE user_tg_id=705').get().enabled,0);
   await handleAdminCallback(db,env,991,'admin_lyd_toggle');
   assert.equal((await getUser(db,705)).currency_preference,'LYD');
   assert.equal(c.prepare('SELECT enabled FROM user_lyd_display WHERE user_tg_id=705').get().enabled,1);
   assert.equal((await egpRate(db)),5424);
 });}finally{c.close()}
});
