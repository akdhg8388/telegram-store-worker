import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {beginPurchase,commitPurchase,showReceipt,purchaseAvailability} from '../src/wallet-purchase.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {processUpdate} from '../src/bot.js';

const root=new URL('../migrations/',import.meta.url);
const migrations=['0001_init','0002_admin_controls','0003_reliability','0004_reference_catalog','0005_persistent_navigation','0006_wallet_checkout','0007_support_moderation_topup','0008_custom_ui_customer_inbox_cleanup','0009_wallet_auto_delivery','0010_purchase_views_and_unique_codes','0011_product_visuals','0012_product_warranty'];
function setup(){
 const c=new DatabaseSync(':memory:');
 for(const m of migrations)c.exec(readFileSync(new URL(`${m}.sql`,root),'utf8'));
 c.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Client'),(102,'Other'),(991,'Owner')").run();
 c.prepare("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,fulfillment_mode,delivery_shared_text,usage_instructions,photo_file_id) VALUES(1,'Demo',1,12000,2,'shared','download-code-ABC','Instruction steps','PHOTO1')").run();
 const db={prepare(sql){const stmt=c.prepare(sql);let a=[];const q={bind(...x){a=x;return q},async first(){return stmt.get(...a)??null},async all(){return {results:stmt.all(...a)}},async run(){const r=stmt.run(...a);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}};return q},async batch(items){c.exec('BEGIN');try{const r=[];for(const i of items)r.push(await i.run());c.exec('COMMIT');return r}catch(e){c.exec('ROLLBACK');throw e}}};
 return {c,db};
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_ONLY',STORE_NAME:'My Store'};
async function mock(fn){const before=globalThis.fetch,calls=[];globalThis.fetch=async(u,o)=>{const method=String(u).split('/').at(-1);const body=JSON.parse(o.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:222}}),{status:200})};try{return await fn(calls)}finally{globalThis.fetch=before}}
const balance=c=>Number(c.prepare('SELECT wallet_balance_iqd b FROM users WHERE tg_id=101').get().b);
function credit(c,n=50000){c.prepare('INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,?,\'topup\',?)').run(n,'manual-approved-'+n)}

test('insufficient wallet balance blocks checkout and offers topup, without ledger debit',async()=>{
 const {c,db}=setup();try{await mock(async calls=>{
   const p=c.prepare('SELECT * FROM products WHERE id=1').get();
   await beginPurchase(db,env,101,p,()=> 'e4a879e0-0527-4f11-8404-a350bbe35a61');
   assert.match(calls.at(-1).body.text,/رصيد المحفظة غير كافٍ/);
   assert.match(JSON.stringify(calls.at(-1).body.reply_markup),/topup/);
   assert.equal(c.prepare('SELECT count(*) n FROM wallet_purchases').get().n,0);
   assert.equal(balance(c),0);
 });}finally{c.close()}
});

test('atomic debit gives exact delivered content, picture and instructions and repeat never debits twice',async()=>{
 const {c,db}=setup();try{credit(c);await mock(async calls=>{
   const p=c.prepare('SELECT * FROM products WHERE id=1').get();
   const nonce='f1111111-1111-4111-8111-111111111111';
   await beginPurchase(db,env,101,p,()=>nonce);
   const first=await commitPurchase(db,env,101,nonce);
   assert.equal(first.id,1);
   assert.equal(first.repeated,false);
   assert.equal(balance(c),38000);
   assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,1);
   assert.equal(c.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='permitted_purchase'").get().n,1);
   const second=await commitPurchase(db,env,101,nonce);
   assert.deepEqual(second,{id:1,repeated:true});
   assert.equal(balance(c),38000);
   await showReceipt(db,env,101,1);
   assert.ok(calls.some(x=>x.body.text?.includes('download-code-ABC')&&x.body.text.includes('Instruction steps')));
   assert.ok(calls.some(x=>x.method==='sendPhoto'&&x.body.photo==='PHOTO1'));
   // A different Telegram user must not access the receipt.
   const before=calls.length;await showReceipt(db,env,102,1);
   assert.match(calls.slice(before).at(-1).body.text,/لا توجد عملية/);
 });}finally{c.close()}
});

test('concurrent unique inventory never reuses a delivery code, even for two different buyers',async()=>{
 const {c,db}=setup();try{
  credit(c);c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(102,50000,'topup','credit-other')").run();
  c.prepare("UPDATE products SET fulfillment_mode='unique',stock=5 WHERE id=1").run();
  c.prepare("INSERT INTO product_delivery_items(product_id,payload) VALUES(1,'LICENSE-ONE')").run();
  await mock(async()=>{
   const p=c.prepare('SELECT * FROM products WHERE id=1').get();
   const a='a1111111-1111-4111-8111-111111111111',b='b1111111-1111-4111-8111-111111111111';
   await beginPurchase(db,env,101,p,()=>a);await beginPurchase(db,env,102,p,()=>b);
   const x=await commitPurchase(db,env,101,a);
   const y=await commitPurchase(db,env,102,b);
   assert.equal(x.id,1);
   assert.ok(y.failed);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,1);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM product_delivery_items WHERE used_by_purchase_id IS NOT NULL').get().n,1);
   assert.equal(c.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=102').get().wallet_balance_iqd,50000);
   assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,4);
  });
 }finally{c.close()}
});

test('database trigger refuses forged price, insufficient wallet and empty inventory with zero changes',()=>{
 const {c}=setup();try{
  credit(c,12000);
  const sql=`INSERT INTO wallet_purchases(user_tg_id,product_id,price_iqd,submission_key,product_name,delivery_payload)
    VALUES (101,1,?,?,?,?)`;
  assert.throws(()=>c.prepare(sql).run(1,'fake-id','Demo','CODE'),/wallet_purchase/);
  assert.equal(balance(c),12000);
  c.prepare("UPDATE products SET fulfillment_mode='unique'").run();
  assert.throws(()=>c.prepare(sql).run(12000,'fake-id-2','Demo','CODE'),/wallet_purchase/);
  assert.equal(balance(c),12000);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,0);
 }finally{c.close()}
});

test('admin can set delivery mode, attach image, insert unique payload and edit price via real callbacks',async()=>{
 const {c,db}=setup();try{await mock(async calls=>{
   await handleAdminCallback(db,env,991,'admin_product_mode:1:unique');
   assert.equal(c.prepare('SELECT fulfillment_mode FROM products WHERE id=1').get().fulfillment_mode,'unique');
   await handleAdminCallback(db,env,991,'admin_product_code:1');
   await handleAdminText(db,env,991,{action:'owner_product_code',payload:{id:1}},{text:'CODE-DATA-123'});
   assert.equal(c.prepare('SELECT payload FROM product_delivery_items WHERE product_id=1').get().payload,'CODE-DATA-123');
   await handleAdminCallback(db,env,991,'admin_product_photo:1');
   await handleAdminText(db,env,991,{action:'owner_product_photo',payload:{id:1}},{photo:[{file_id:'new-photo-telegram'}]});
   assert.equal(c.prepare('SELECT photo_file_id FROM products WHERE id=1').get().photo_file_id,'new-photo-telegram');
   await handleAdminCallback(db,env,991,'admin_product_field:1:price_iqd');
   await handleAdminText(db,env,991,{action:'owner_product_field',payload:{id:1,field:'price_iqd'}},{text:'25000'});
   assert.equal(c.prepare('SELECT price_iqd FROM products WHERE id=1').get().price_iqd,25000);
   const ready=await purchaseAvailability(db,c.prepare('SELECT * FROM products WHERE id=1').get());
   assert.equal(ready.ready,true);
 });}finally{c.close()}
});

test('callback buys from wallet without generating any Stars invoice or admin approval queue',async()=>{
 const {c,db}=setup();try{credit(c);await mock(async calls=>{
   const run=async(update_id,data)=>{
     const promises=[];
     await processUpdate(db,env,{waitUntil(x){promises.push(x)}},
       {update_id,callback_query:{id:'c'+update_id,from:{id:101,first_name:'User'},message:{message_id:405,chat:{id:101,type:'private'}},data}});
     await Promise.all(promises);
   };
   await run(300,'buy:1');
   const nonce=JSON.parse(c.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).nonce;
   await run(301,'wallet_confirm:'+nonce);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,1);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,0);
   assert.equal(calls.some(x=>x.method==='sendInvoice'),false);
 });}finally{c.close()}
});
