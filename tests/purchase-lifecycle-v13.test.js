import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {beginPurchase,commitPurchase,showReceipt,purchaseAvailability} from '../src/wallet-purchase.js';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {cleanupPurchaseViews,readPurchaseViewIds,trackPurchaseView} from '../src/purchase-views.js';

const migration=['0001_init','0002_admin_controls','0003_reliability','0004_reference_catalog','0005_persistent_navigation','0006_wallet_checkout','0007_support_moderation_topup','0008_custom_ui_customer_inbox_cleanup','0009_wallet_auto_delivery','0010_purchase_views_and_unique_codes','0011_product_visuals'];
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',STORE_NAME:'My Store'};
function setup(){
  const c=new DatabaseSync(':memory:');
  for(const n of migration)c.exec(readFileSync(new URL(`../migrations/${n}.sql`,import.meta.url),'utf8'));
  c.prepare("INSERT INTO users(tg_id,first_name,username) VALUES(101,'Client','auser'),(102,'Visitor','vis'),(991,'Owner','admin')").run();
  c.prepare("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,fulfillment_mode,delivery_shared_text,usage_instructions,photo_file_id) VALUES(1,'ChatGPT Demo',1,10000,1,'shared','shared-content','Steps','P123')").run();
  c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,200000,'topup','approved-credit')").run();
  const db={prepare(sql){const stmt=c.prepare(sql);let args=[];const q={bind(...x){args=x;return q},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const r=stmt.run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}};return q},async batch(items){c.exec('BEGIN');try{const values=[];for(const item of items)values.push(await item.run());c.exec('COMMIT');return values}catch(e){c.exec('ROLLBACK');throw e}}};
  return {c,db};
}
async function mocked(callback){
  const old=globalThis.fetch,calls=[];let id=1000;
  globalThis.fetch=async(u,o)=>{const method=String(u).split('/').at(-1),body=JSON.parse(o.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:++id}}),{status:200})};
  try{return await callback(calls)}finally{globalThis.fetch=old}
}
async function callback(db,uid,data,message_id=500,update_id=100){
  const tasks=[];
  await processUpdate(db,env,{waitUntil(p){tasks.push(p)}},{update_id,callback_query:{id:'cb'+update_id,from:{id:uid,first_name:uid===991?'Owner':'Client',username:uid===991?'admin':'auser'},message:{message_id,chat:{id:uid,type:'private'}},data}});
  await Promise.all(tasks);
}
const bal=c=>c.prepare('SELECT wallet_balance_iqd as n FROM users WHERE tg_id=101').get().n;

test('10 admin-added codes are unique, 10 repeat purchases deliver distinct codes and eleventh does not debit',async()=>{
 const {c,db}=setup();try{await mocked(async calls=>{
   const vals=Array.from({length:10},(_,i)=>`ACCESS-${String(i+1).padStart(3,'0')}`);
   await handleAdminCallback(db,env,991,'admin_product_code:1');
   await handleAdminText(db,env,991,{action:'owner_product_code',payload:{id:1}},{text:vals.join('\n')});
   assert.equal(c.prepare('SELECT COUNT(*) n FROM product_delivery_items').get().n,10);
   await handleAdminCallback(db,env,991,'admin_product_mode:1:unique');
   assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,10);
   assert.equal((await purchaseAvailability(db,c.prepare('SELECT * FROM products WHERE id=1').get())).count,10);
   for(let k=1;k<=10;k++){
     const p=c.prepare('SELECT * FROM products WHERE id=1').get();
     const nonce=`${String(k).padStart(8,'0')}-0000-4000-8000-000000000001`;
     await beginPurchase(db,env,101,p,()=>nonce);
     const result=await commitPurchase(db,env,101,nonce);
     assert.equal(result.id,k);
     assert.equal(bal(c),200000-10000*k);
     if(k===1){const replay=await commitPurchase(db,env,101,nonce);assert.equal(replay.repeated,true);assert.equal(bal(c),190000)}
   }
   const delivered=c.prepare('SELECT delivery_payload FROM wallet_purchases ORDER BY id').all().map(x=>x.delivery_payload);
   assert.deepEqual(new Set(delivered),new Set(vals));
   assert.equal(c.prepare('SELECT COUNT(*) n FROM product_delivery_items WHERE used_by_purchase_id IS NULL').get().n,0);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,10);
   assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,0);
   const before=bal(c);
   await beginPurchase(db,env,101,c.prepare('SELECT * FROM products WHERE id=1').get());
   assert.equal(bal(c),before);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE kind=\'permitted_purchase\'').get().n,10);
 });}finally{c.close()}
});

test('duplicate codes across multiple admin batches are not inserted and sold code cannot be restocked',async()=>{
 const {c,db}=setup();try{await mocked(async()=>{
  await handleAdminCallback(db,env,991,'admin_product_mode:1:unique');
  await handleAdminText(db,env,991,{action:'owner_product_code',payload:{id:1}},{text:'C1\nC2\nC1'});
  assert.equal(c.prepare('SELECT count(*) n FROM product_delivery_items').get().n,2);
  await beginPurchase(db,env,101,c.prepare('SELECT * FROM products WHERE id=1').get(),()=> 'aaaa1111-0000-4000-8000-000000000001');
  await commitPurchase(db,env,101,'aaaa1111-0000-4000-8000-000000000001');
  await handleAdminText(db,env,991,{action:'owner_product_code',payload:{id:1}},{text:'C1\nC2\nC3'});
  assert.equal(c.prepare('SELECT count(*) n FROM product_delivery_items').get().n,3);
  assert.equal((await purchaseAvailability(db,c.prepare('SELECT * FROM products WHERE id=1').get())).count,2);
 });}finally{c.close()}
});

test('Home alone cleans tracked purchase confirmation + receipt + photo and never deletes unrelated messages or customer records',async()=>{
 const {c,db}=setup();try{await mocked(async calls=>{
   await trackPurchaseView(db,101,{message_id:300});
   await showReceipt(db,env,101,999); // an invalid purchase must not track anything
   const nonce='aaaa1111-0000-4000-8000-000000000002';
   await beginPurchase(db,env,101,c.prepare('SELECT * FROM products WHERE id=1').get(),()=>nonce);
   await commitPurchase(db,env,101,nonce);
   await showReceipt(db,env,101,1);
   const listed=await readPurchaseViewIds(db,101);
   assert.equal(listed.length,4); // old + confirm + text + photo
   const deleteCount=()=>calls.filter(x=>x.method==='deleteMessage').length;
   await callback(db,101,'wallet_purchases',500,201);
   assert.equal(deleteCount(),0);
   await callback(db,101,'home',listed[1],202); // edit one tracked message into home
   assert.equal(deleteCount(),3); // delete everything except the Home message
   assert.equal((await readPurchaseViewIds(db,101)).length,0);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,1);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE kind=\'permitted_purchase\'').get().n,1);
   assert.ok(calls.filter(x=>x.method==='deleteMessage').every(x=>listed.includes(x.body.message_id)));
   assert.ok(!calls.some(x=>x.method==='deleteMessage'&&x.body.message_id===500));
   assert.ok(calls.some(x=>x.method==='editMessageText'&&x.body.message_id===listed[1]));
 });}finally{c.close()}
});

test('admin successful-purchase list includes delivered purchases only and customer cannot open it',async()=>{
 const {c,db}=setup();try{await mocked(async calls=>{
   const nonce='bbbb1111-0000-4000-8000-000000000001';
   await beginPurchase(db,env,101,c.prepare('SELECT * FROM products WHERE id=1').get(),()=>nonce);
   await commitPurchase(db,env,101,nonce);
   await callback(db,991,'admin_wallet_sales',501,301);
   assert.ok(calls.some(x=>x.body.text?.includes('مشتريات المستخدمين الناجحة')));
   await callback(db,991,'admin_wallet_sale:1',501,302);
   const detail=calls.findLast(x=>x.body.text?.includes('عملية شراء مكتملة'))?.body.text;
   assert.match(detail,/Client/);assert.match(detail,/@auser/);
   assert.match(detail,/10000|10,000/);assert.match(detail,/ChatGPT Demo/);assert.match(detail,/بغداد/);
   const before=calls.length;
   await callback(db,102,'admin_wallet_sale:1',501,303);
   assert.ok(!calls.slice(before).some(x=>x.body.text?.includes('عملية شراء مكتملة')));
 });}finally{c.close()}
});

test('legacy duplicate payload with a used copy cannot be delivered again',async()=>{
 const {c,db}=setup();try{
  // Pre-existing duplicates are possible from old versions; insert under the old schema behavior.
  c.exec('DROP TRIGGER prevent_duplicate_delivery_payload');
  c.prepare("INSERT INTO product_delivery_items(product_id,payload) VALUES(1,'LEGACY-KEY'),(1,'LEGACY-KEY')").run();
  c.prepare("INSERT INTO product_delivery_items(product_id,payload) VALUES(1,'FRESH-KEY')").run();
  c.prepare("INSERT INTO wallet_purchases(user_tg_id,product_id,price_iqd,submission_key,product_name,delivery_payload) VALUES(101,1,10000,'old-used-key','Demo','LEGACY-KEY')").run();
  c.prepare("UPDATE product_delivery_items SET used_by_purchase_id=1 WHERE id=2").run();
  c.prepare("UPDATE products SET fulfillment_mode='unique',stock=3").run();
  await mocked(async()=>{
   const status=await purchaseAvailability(db,c.prepare('SELECT * FROM products WHERE id=1').get());
   assert.equal(status.count,1);
   const nonce='cccc1111-0000-4000-8000-000000000001';
   await beginPurchase(db,env,101,c.prepare('SELECT * FROM products WHERE id=1').get(),()=>nonce);
   const result=await commitPurchase(db,env,101,nonce);
   assert.ok(result.id);
   assert.equal(c.prepare('SELECT delivery_payload FROM wallet_purchases WHERE id=?').get(result.id).delivery_payload,'FRESH-KEY');
  });
 }finally{c.close()}
});
