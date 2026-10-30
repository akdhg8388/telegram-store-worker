import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {quantityPricing,bulkConfirm,commitBulkPurchase,quantityPicker} from '../src/bulk-purchase.js';
import {showReceipt,purchaseAvailability} from '../src/wallet-purchase.js';
import {adminRoute,handleAdminCallback,handleAdminText} from '../src/admin-controls.js';

function fixture(stock=25){
 const c=new DatabaseSync(':memory:');
 const paths=readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort();
 for(const n of paths)c.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 c.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Buyer'),(102,'Other'),(991,'Owner')").run();
 c.prepare("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,fulfillment_mode,max_purchase_qty,discount_5_percent,discount_20_percent) VALUES(1,'Codes',1,1000,?,'unique',25,10,20)").run(stock);
 for(let n=1;n<=stock;n++)c.prepare('INSERT INTO product_delivery_items(product_id,payload) VALUES(1,?)').run('CODE-'+n);
 c.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,50000,'topup','test-credit')").run();
 const db={prepare(sql){const st=c.prepare(sql);let v=[];const q={
   bind(...args){v=args;return q},async first(){return st.get(...v)||null},
   async all(){return {results:st.all(...v)}},async run(){const r=st.run(...v);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
 };return q},async batch(items){c.exec('BEGIN');try{const out=[];for(const it of items)out.push(await it.run());c.exec('COMMIT');return out}catch(e){c.exec('ROLLBACK');throw e}}};
 return {c,db};
}
async function mocked(fn){
 const prev=globalThis.fetch,calls=[];let id=100;
 globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),params:JSON.parse(init.body)});
   return new Response(JSON.stringify({ok:true,result:{message_id:++id}}),{status:200});};
 try{await fn(calls)}finally{globalThis.fetch=prev}
}
const env={TELEGRAM_BOT_TOKEN:'FAKE',ADMIN_ID:'991'};
test('1 / 5 / 20 quotes use tier percentages and reject invalid quantities',()=>{
 const p={price_iqd:1000,max_purchase_qty:25,discount_5_percent:10,discount_20_percent:20};
 assert.deepEqual(quantityPricing(p,1),{qty:1,unit:1000,discount:0,original:1000,total:1000,saved:0});
 assert.equal(quantityPricing(p,5).total,4500);
 assert.equal(quantityPricing(p,20).total,16000);
 assert.equal(quantityPricing(p,21).total,16800);
 for(const v of [0,-1,1.5,26,101,NaN])assert.equal(quantityPricing(p,v),null);
 assert.equal(adminRoute('admin_product_discounts:1'),true);
});
test('five plus twenty unique codes are reserved once and the wallet is charged exactly once per batch',async()=>{
 const {c,db}=fixture();
 try{await mocked(async calls=>{
  let p=c.prepare('SELECT * FROM products WHERE id=1').get();
  await quantityPicker(db,env,101,p);
  const menu=calls.at(-1).params.reply_markup.inline_keyboard;
  assert.deepEqual(menu[0].map(x=>x.text),['1','5','20']);
  assert.equal(menu[0].every(b=>b.style==='success'),true);
  await bulkConfirm(db,env,101,p,5);
  const session=c.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get();
  assert.ok(session);
  const nonce=JSON.parse(session.payload).nonce;
  const first=await commitBulkPurchase(db,101,nonce);
  assert.equal(first.id,1);
  assert.deepEqual(await commitBulkPurchase(db,101,nonce),{id:1,repeated:true});
  assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,20);
  assert.equal(c.prepare('SELECT price_iqd FROM wallet_purchases WHERE id=1').get().price_iqd,4500);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM product_delivery_items WHERE used_by_purchase_id=1 OR bulk_purchase_id=1').get().n,5);
  p=c.prepare('SELECT * FROM products WHERE id=1').get();
  await bulkConfirm(db,env,101,p,20);
  const nonce2=JSON.parse(c.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).nonce;
  const second=await commitBulkPurchase(db,101,nonce2);
  assert.equal(second.id,2);
  assert.equal(c.prepare('SELECT stock FROM products WHERE id=1').get().stock,0);
  assert.equal(c.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,29500);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM product_delivery_items WHERE used_by_purchase_id IS NOT NULL OR bulk_purchase_id IS NOT NULL').get().n,25);
  assert.equal(c.prepare('SELECT COUNT(*) n FROM wallet_ledger WHERE kind=\'permitted_purchase\'').get().n,2);
  await showReceipt(db,env,101,2);
  const full=calls.filter(x=>x.method==='sendMessage').map(x=>x.params.text||'').join('\n');
  assert.match(full,/CODE-25/);
  assert.match(full,/CODE-6/);
  assert.equal(calls.some(x=>x.params.text?.includes('CODE-1')&&x.params.text.includes('CODE-25')),false);
 });}finally{c.close()}
});
test('quantity greater than real stock is rejected before any debit; discount editor is owner-only',async()=>{
 const {c,db}=fixture(6);
 try{await mocked(async calls=>{
   const p=c.prepare('SELECT * FROM products WHERE id=1').get();
   await bulkConfirm(db,env,101,p,20);
   assert.match(calls.at(-1).params.text,/المخزون غير كاف/);
   assert.equal(c.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,50000);
   await handleAdminCallback(db,env,101,'admin_product_discounts:1');
   assert.equal(c.prepare('SELECT discount_5_percent FROM products WHERE id=1').get().discount_5_percent,10);
   await handleAdminCallback(db,env,991,'admin_product_discounts:1');
   assert.ok(calls.some(x=>x.params.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='admin_product_field:1:discount_5_percent')));
   await handleAdminText(db,env,991,{action:'owner_product_field',payload:{id:1,field:'discount_5_percent'}},{text:'15'});
   assert.equal(c.prepare('SELECT discount_5_percent FROM products WHERE id=1').get().discount_5_percent,15);
 });}finally{c.close()}
});
