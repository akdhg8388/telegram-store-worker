import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home,profile,products,productView} from '../src/ui.js';
import {CUSTOMER_COMMANDS,OWNER_COMMANDS} from '../src/commands.js';
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',STORE_NAME:'My Store'};
function setup(){
 const con=new DatabaseSync(':memory:');
 for(const n of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql'])
 con.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 con.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(101,'Client')").run();
 con.prepare("INSERT INTO products(category_id,title,price_stars,stock) VALUES(1,'Present',30,8),(1,'Gone',30,0)").run();
 const db={prepare(sql){const st=con.prepare(sql);let p=[];const q={bind(...a){p=a;return q},async first(){return st.get(...p)||null},async all(){return {results:st.all(...p)}},async run(){const r=st.run(...p);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};return q;}};
 return {db,con};
}
async function mock(work){const real=globalThis.fetch,arr=[];globalThis.fetch=async(url,init)=>{arr.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});};try{await work(arr)}finally{globalThis.fetch=real}}
test('V7 home colors are 4 green then blue; no admin for customers',async()=>{
 const {db,con}=setup();try{await mock(async arr=>{
 await home(db,env,991);await home(db,env,101);
 const a=arr[0].reply_markup.inline_keyboard.flat();
 for(const k of ['categories','featured','wallet','profile'])assert.equal(a.find(x=>x.callback_data===k).style,'success');
 for(const k of ['currency','orders','transactions','referrals','language','support','news','admin'])assert.equal(a.find(x=>x.callback_data===k).style,'primary');
 assert.ok(!arr[1].reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='admin'));
 });}finally{con.close()}
});
test('V7 profile real values and button order',async()=>{
 const {db,con}=setup();try{
 con.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(991,15000,'topup','test:991')").run();
 await mock(async arr=>{await profile(db,env,991);
 assert.match(arr[0].text,/15,000/);
 assert.deepEqual(arr[0].reply_markup.inline_keyboard.map(r=>r[0].callback_data),['topup','orders','transactions','favorites','home']);
 assert.deepEqual(arr[0].reply_markup.inline_keyboard.map(r=>r[0].style),['success','primary','primary','primary','danger']);
 });}finally{con.close()}
});
test('V7 stock red for zero, green for positive, refresh and no buy at zero',async()=>{
 const {db,con}=setup();try{await mock(async arr=>{
 await products(db,env,101); await productView(db,env,101,2);await productView(db,env,101,1);
 const list=arr[0].reply_markup.inline_keyboard.flat();
 assert.equal(list.find(x=>x.callback_data==='product:2').style,'danger');
 assert.equal(list.find(x=>x.callback_data==='product:1').style,'success');
 const no=arr[1].reply_markup.inline_keyboard.flat();
 assert.ok(no.some(x=>x.style==='danger'&&x.text.includes('المخزون: 0')));
 assert.ok(!no.some(x=>x.callback_data==='buy:2'));
 assert.ok(no.some(x=>x.callback_data==='product:2'&&x.text.includes('تحديث')));
 const yes=arr[2].reply_markup.inline_keyboard.flat();
 assert.ok(yes.some(x=>x.callback_data==='buy:1'&&x.style==='success'));
 });}finally{con.close()}
});
test('V7 Telegram commands separate public from private admin',()=>{
 assert.ok(CUSTOMER_COMMANDS.some(c=>c.command==='menu'));
 assert.ok(CUSTOMER_COMMANDS.some(c=>c.command==='shop'));
 assert.ok(CUSTOMER_COMMANDS.some(c=>c.command==='profile'));
 assert.ok(!CUSTOMER_COMMANDS.some(c=>c.command==='admin'));
 assert.ok(OWNER_COMMANDS.some(c=>c.command==='admin'));
});
