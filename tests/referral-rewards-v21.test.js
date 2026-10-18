import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {referralAdminCallback,referralAdminText,referralPage} from '../src/referral-rewards.js';
import {home} from '../src/ui.js';
function fixture(){
 const c=new DatabaseSync(':memory:');
 for(let i=1;i<=14;i++){
  const names={1:'init',2:'admin_controls',3:'reliability',4:'reference_catalog',5:'persistent_navigation',6:'wallet_checkout',7:'support_moderation_topup',8:'custom_ui_customer_inbox_cleanup',9:'wallet_auto_delivery',10:'purchase_views_and_unique_codes',11:'product_visuals',12:'product_warranty',13:'required_channels',14:'referral_rewards'};
  c.exec(readFileSync(new URL('../migrations/'+String(i).padStart(4,'0')+'_'+names[i]+'.sql',import.meta.url),'utf8'));
 }
 c.exec("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(101,'Buyer'),(102,'Referrer')");
 c.exec("INSERT INTO referrals(user_tg_id,referrer_tg_id) VALUES (101,102)");
 c.exec("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,active,fulfillment_mode,delivery_shared_text) VALUES(1,'Sample',1,10000,100,1,'shared','CODE')");
 c.exec("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,1000000,'topup','seed')");
 const db={prepare(sql){const stmt=c.prepare(sql);let args=[];const q={bind(...x){args=x;return q},async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){const y=stmt.run(...args);return {meta:{changes:y.changes,last_row_id:Number(y.lastInsertRowid)}}}};return q},async batch(xs){return Promise.all(xs.map(x=>x.run()))}};
 return {c,db};
}
function buy(c,i){
 c.prepare("INSERT INTO wallet_purchases(user_tg_id,product_id,price_iqd,submission_key,product_name,delivery_payload) VALUES(101,1,10000,?,'Sample','CODE')").run('unique-'+i);
}
const bal=(c,id)=>c.prepare('SELECT wallet_balance_iqd balance FROM users WHERE tg_id=?').get(id).balance;
const rewards=c=>c.prepare('SELECT purchase_id,reward_iqd FROM referral_rewards ORDER BY id').all();
async function mock(fn){
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{const method=String(url).split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:222}}));};
 try{await fn(calls)}finally{globalThis.fetch=previous}
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',BOT_USERNAME:'MyStoreIQBot'};
test('V21 default off, 5 percent awards once per successful purchase when enabled',()=>{
 const {c}=fixture();try{
  buy(c,1);assert.equal(rewards(c).length,0);
  c.exec("UPDATE referral_policy SET enabled=1");
  buy(c,2);assert.equal(rewards(c).length,1);
  assert.equal(rewards(c)[0].reward_iqd,500);
  assert.equal(bal(c,102),500);
  assert.equal(c.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE source_key='referral_reward:2'").get().n,1);
  assert.throws(()=>buy(c,2),/UNIQUE/);
  assert.equal(bal(c,102),500);
 }finally{c.close();}
});
test('V21 first purchase, N purchases, unlimited, minimum, cap and disable',()=>{
 const {c}=fixture();try{
  c.exec('UPDATE referral_policy SET enabled=1,max_purchases=1');
  buy(c,1);buy(c,2);assert.equal(rewards(c).length,1);
  c.exec('UPDATE referral_policy SET max_purchases=3,max_reward_iqd=100');
  buy(c,3);buy(c,4);buy(c,5);
  assert.equal(rewards(c).length,3);
  assert.deepEqual(rewards(c).map(x=>x.reward_iqd),[500,100,100]);
  c.exec('UPDATE referral_policy SET max_purchases=0,min_purchase_iqd=20000');
  buy(c,6);assert.equal(rewards(c).length,3);
  c.exec('UPDATE referral_policy SET min_purchase_iqd=0');
  buy(c,7);assert.equal(rewards(c).length,4);
  c.exec('UPDATE referral_policy SET enabled=0');
  buy(c,8);assert.equal(rewards(c).length,4);
 }finally{c.close();}
});
test('V21 referral cannot be self-awarded and old purchase balance/stock stay atomic',()=>{
 const {c}=fixture();try{
  c.exec('UPDATE referral_policy SET enabled=1');
  const initial=bal(c,101);
  buy(c,1);
  assert.equal(bal(c,101),initial-10000);
  assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,99);
  assert.equal(c.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='permitted_purchase'").get().n,1);
  assert.equal(rewards(c).length,1);
 }finally{c.close();}
});
test('V21 admin visible toggle hides the real home button, English referral page stays English',async()=>{
 const {c,db}=fixture();try{await mock(async calls=>{
  await referralAdminCallback(db,env,991,'refadmin_visible');
  assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='home_button_referrals_visible'").get().value,'false');
  await home(db,env,991);
  assert.ok(!calls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='referrals'));
  await referralAdminCallback(db,env,991,'refadmin_visible');
  await home(db,env,991);
  assert.ok(calls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='referrals'));
  await referralPage(db,{...env,__locale:'en'},102);
  assert.match(calls.at(-1).body.text,/Referral Program/);
  assert.match(calls.at(-1).body.text,/Reward rate: 5%/);
 });}finally{c.close();}
});
test('V21 owner can set percentage and unlimited purchase count by Telegram controls',async()=>{
 const {c,db}=fixture();try{await mock(async()=>{
  await referralAdminCallback(db,env,991,'refadmin_edit:basis_points');
  await referralAdminText(db,env,991,{action:'owner_referral_policy',payload:{field:'basis_points'}},{text:'7'});
  assert.equal(c.prepare('SELECT basis_points FROM referral_policy').get().basis_points,700);
  await referralAdminText(db,env,991,{action:'owner_referral_policy',payload:{field:'max_purchases'}},{text:'0'});
  assert.equal(c.prepare('SELECT max_purchases FROM referral_policy').get().max_purchases,0);
 });}finally{c.close();}
});
