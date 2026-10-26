import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home,profile,products,productView} from '../src/ui.js';
import {CUSTOMER_COMMANDS,OWNER_COMMANDS} from '../src/commands.js';
import {processUpdate} from '../src/bot.js';

const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_ONLY',STORE_NAME:'My Store',BOT_USERNAME:'MyStoreIQBot',ENABLE_MANUAL_TOPUPS:'false'};
function fixture(){
  const conn=new DatabaseSync(':memory:');
  for(const n of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql','0011_product_visuals.sql','0012_product_warranty.sql'])
    conn.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
  conn.prepare("INSERT INTO users(tg_id,first_name,username) VALUES(991,'Admin','owner'),(101,'Customer','client')").run();
  conn.prepare("INSERT INTO products(category_id,title,price_stars,stock,active) VALUES(1,'متاح الآن',30,8,1),(1,'نفد المخزون',30,0,1),(1,'حسب الطلب',30,NULL,1)").run();
  const db={prepare(sql){const stmt=conn.prepare(sql); let args=[];const o={bind(...values){args=values;return o},async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};return o;}};
  return {conn,db};
}
async function mock(action){const prev=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{
  const method=String(url).split('/').at(-1),body=JSON.parse(init.body);
  calls.push({method,body});
  return new Response(JSON.stringify({ok:true,result:{message_id:123}}),{status:200});
};try {await action(calls)} finally{globalThis.fetch=prev}}

const flatten=(call)=>call.body.reply_markup.inline_keyboard.flat();
test('first four home action buttons are green, remaining blue; admin never appears for customers',async()=>{
 const {conn,db}=fixture();try{await mock(async calls=>{
    await home(db,env,991);await home(db,env,101);
    const owner=flatten(calls[0]);
    for(const data of ['categories','featured','wallet','profile'])assert.equal(owner.find(b=>b.callback_data===data).style,'success',data);
    for(const data of ['currency','orders','transactions','referrals','messages','support','news','admin'])assert.equal(owner.find(b=>b.callback_data===data).style,'primary',data);
    assert.ok(owner.every(b=>b.style==='success'||b.style==='primary'||b.style==='danger'));
    assert.ok(!flatten(calls[1]).some(b=>b.callback_data==='admin'));
 });}finally{conn.close()}
});
test('real personal profile uses stored ledger balance, actual orders and referrals with full-width colored actions',async()=>{
 const {conn,db}=fixture();try{
    conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (991,15000,'topup','v7test1')").run();
    conn.prepare("INSERT INTO orders(user_tg_id,product_id,unit_price_stars,total_stars,status) VALUES(991,1,30,30,'delivered')").run();
    conn.prepare('INSERT INTO referrals(user_tg_id,referrer_tg_id) VALUES (101,991)').run();
    await mock(async calls=>{
      await profile(db,env,991);
      assert.match(calls[0].body.text,/15,000/);
      assert.match(calls[0].body.text,/الإحالات — 1/);
      assert.match(calls[0].body.text,/المشتراة — 1/);
      assert.match(calls[0].body.text,/◀المسؤول▶/);
      const rows=calls[0].body.reply_markup.inline_keyboard;
      assert.deepEqual(rows.map(row=>row.length),[1,1,1,1,1]);
      assert.deepEqual(rows.map(row=>row[0].callback_data),['topup','orders','transactions','favorites','home']);
      assert.deepEqual(rows.map(row=>row[0].style),['success','primary','primary','primary','danger']);
    });
 }finally{conn.close()}
});
test('catalog and product page show real ready inventory rather than misleading stock alone',async()=>{
 const {conn,db}=fixture();try{await mock(async calls=>{
    // Legacy stock on its own must not be marketed as instantly deliverable.
    await products(db,env,101);
    let list=flatten(calls[0]);
    assert.equal(list.find(b=>b.callback_data==='product:1').style,'danger');
    assert.equal(list.find(b=>b.callback_data==='product:2').style,'danger');
    conn.prepare("UPDATE products SET price_iqd=5000,fulfillment_mode='shared',delivery_shared_text='demo instructions' WHERE id=1").run();
    await products(db,env,101);
    list=flatten(calls[1]);
    assert.equal(list.find(b=>b.callback_data==='product:1').style,'success');
    await productView(db,env,101,1);
    const available=flatten(calls[2]);
    assert.equal(available.find(b=>b.callback_data==='buy:1').style,'success');
    assert.equal(available.find(b=>b.text.includes('تحديث المخزون')).callback_data,'product:1');
    await productView(db,env,101,2);
    assert.ok(!flatten(calls[3]).some(b=>b.callback_data==='buy:2'));
 });}finally{conn.close()}
});
test('native three-line Telegram commands menu has customer commands only; admin scope is distinct',()=>{
  const names=CUSTOMER_COMMANDS.map(c=>c.command);
  assert.deepEqual(names,['start','menu','shop','topup','wallet','profile','orders','history','favorites','currency','support']);
  assert.ok(!names.includes('admin'));
  assert.ok(OWNER_COMMANDS.some(c=>c.command==='admin'));
  assert.equal(new Set(OWNER_COMMANDS.map(c=>c.command)).size,OWNER_COMMANDS.length);
  assert.ok(OWNER_COMMANDS.every(c=>c.command.length<=32&&c.description.length<=256));
});
test('menu commands actually open current DB-backed screens in private chat',async()=>{
  const {conn,db}=fixture();try{await mock(async calls=>{
    const pending=[];
    for(const [i,text] of ['/menu','/shop','/profile','/history','/favorites','/orders'].entries()){
      await processUpdate(db,env,{waitUntil(p){pending.push(p)}},{update_id:700+i,message:{chat:{id:101,type:'private'},from:{id:101,first_name:'Customer'},text}});
    }
    await Promise.all(pending);
    const output=calls.filter(x=>x.method==='sendMessage').map(x=>x.body.text);
    assert.ok(output.some(x=>x.includes('My Store')));
    assert.ok(output.some(x=>x.includes('أقسام المتجر')));
    assert.ok(output.some(x=>x.includes('الملف الشخصي')));
    assert.ok(output.some(x=>x.includes('سجل المحفظة')));
    assert.ok(output.some(x=>x.includes('المفضلة')));
    assert.ok(output.some(x=>x.includes('طلباتي')));
  });}finally{conn.close()}
});
