import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {methodList} from '../src/payment-methods.js';
import {validTonTransactionId,TON_ADDRESS,TON_QR_URL} from '../src/ton-payment.js';

const address='UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE';
function fixture(existing=true){
 const conn=new DatabaseSync(':memory:');
 const files=readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^00\d\d_.*\.sql$/.test(x)).sort();
 for(const file of files.filter(x=>!x.startsWith('0032_')))
   conn.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(101,'Buyer','USD'),(991,'Owner','USD')").run();
 conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520'),('manual_topups_enabled','true')").run();
 if(existing){
  conn.prepare("INSERT INTO payment_methods(method_key,name_ar,receiver_ar,photo_file_id,enabled,visible) VALUES('custom_ton_demo','USDT شبكة TON','old address','USER_QR_IMAGE',1,1)").run();
  conn.prepare("INSERT INTO payment_methods(method_key,name_ar,receiver_ar,enabled,visible) VALUES('custom_razer','Razer Gold','RECEIVER',1,1)").run();
 }
 conn.exec(readFileSync(new URL('../migrations/0032_ton_manual_payment.sql',import.meta.url),'utf8'));
 const db={prepare(sql){
   const stmt=conn.prepare(sql);let args=[];
   const o={bind(...values){args=values;return o},
     async first(){return stmt.get(...args)??null},
     async all(){return {results:stmt.all(...args)}},
     async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};
   return o;
 },async batch(stmts){
   conn.exec('BEGIN');try{const results=[];for(const x of stmts)results.push(await x.run());conn.exec('COMMIT');return results;}
   catch(err){conn.exec('ROLLBACK');throw err}
 }};
 return {conn,db};
}
function testTelegram(fn){
 const prev=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{
   const body=JSON.parse(options.body),method=String(url).split('/').at(-1);
   requests.push({method,body});
   for(const row of body.reply_markup?.inline_keyboard||[])
     for(const btn of row)if(btn.callback_data)
       assert.ok(Buffer.byteLength(btn.callback_data,'utf8')<=64);
   return new Response(JSON.stringify({ok:true,result:{message_id:710+requests.length}}),{status:200});
 };
 return Promise.resolve().then(()=>fn(requests)).finally(()=>{globalThis.fetch=prev});
}
test('owner-provided Bybit TON method retains QR, other providers and old wallet ledger',async()=>{
 const {conn,db}=fixture();
 try {
   const method=conn.prepare("SELECT * FROM payment_methods WHERE method_key='custom_ton_demo'").get();
   assert.equal(method.receiver_ar,address);
   assert.equal(method.photo_file_id,'USER_QR_IMAGE');
   assert.equal(method.pay_currency,'USD');
   assert.equal(method.enabled,1);assert.equal(method.visible,1);
   assert.equal(conn.prepare("SELECT enabled+visible AS n FROM payment_methods WHERE method_key='usdt_trc20'").get().n,0);
   assert.equal(conn.prepare("SELECT COUNT(*) n FROM payment_methods WHERE method_key='ton_usdt'").get().n,0);
   assert.equal(conn.prepare("SELECT enabled+visible AS n FROM payment_methods WHERE method_key='custom_razer'").get().n,2);
   assert.equal((await methodList(db,{}, {activeOnly:true})).some(m=>m.method_key==='usdt_trc20'),false);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
 }finally{conn.close();}
});
test('fresh store gets one TON method and QR asset reference',()=>{
 const {conn}=fixture(false);try{
   const row=conn.prepare("SELECT * FROM payment_methods WHERE method_key='ton_usdt'").get();
   assert.equal(row.receiver_ar,TON_ADDRESS);
   assert.equal(row.photo_file_id,TON_QR_URL);
   assert.equal(row.enabled,1);assert.equal(row.visible,1);
 }finally{conn.close()}
});
test('TON TXID parser accepts valid hex/base64 transaction IDs and rejects arbitrary text',()=>{
 assert.equal(validTonTransactionId('a'.repeat(64)),true);
 assert.equal(validTonTransactionId('a'.repeat(44)),true);
 assert.equal(validTonTransactionId('invalid payment'),false);
});
test('TON UI supports QR and copy button; TXID queues owner review and no automatic wallet credit',async()=>{
 const {conn,db}=fixture();
 let update=9000;
 const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN',ENABLE_MANUAL_TOPUPS:'true'};
 const callback=(uid,data,photo=false)=>({update_id:++update,callback_query:{
   id:'cb'+update,from:{id:uid,first_name:uid===991?'Owner':'Buyer'},
   data,message:{message_id:222,chat:{type:'private',id:uid},...(photo?{photo:[{file_id:'PIC'}]}:{})}
 }});
 const message=(uid,text)=>({update_id:++update,message:{message_id:333+update,from:{id:uid,first_name:'Buyer'},chat:{type:'private',id:uid},text}});
 async function send(update){
   const tasks=[];await processUpdate(db,env,{waitUntil(p){tasks.push(p)}},update);await Promise.all(tasks);
 }
 try{await testTelegram(async calls=>{
   await send(callback(101,'topup_preset:10:USD'));
   const menu=calls.find(c=>c.method==='sendMessage'&&c.body.text?.includes('اختيار طريقة الشحن')) ||
     calls.find(c=>c.method==='editMessageText'&&c.body.text?.includes('اختيار طريقة الشحن'));
   assert.ok(menu);
   const methods=menu.body.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data?.startsWith('topup_method:'));
   assert.ok(methods.some(b=>b.text?.includes('TON')));
   assert.ok(!methods.some(b=>/TRC20/i.test(b.text||'')));
   const tonButton=methods.find(b=>b.text?.includes('TON'));
   await send(callback(101,tonButton.callback_data));
   const card=calls.find(c=>c.method==='sendPhoto'&&c.body.caption?.includes('Tether USDT'));
   assert.ok(card,'TON payment card with QR must be sent');
   assert.equal(card.body.photo,'USER_QR_IMAGE');
   assert.doesNotMatch(card.body.caption,/صلاحية|25 دقيقة|expires|انتهاء/i);
   assert.equal(card.body.caption_entities,undefined,'No bold entities');
   const all=card.body.reply_markup.inline_keyboard.flat();
   assert.equal(all.find(b=>b.copy_text)?.copy_text.text,address);
   const paid=all.find(b=>b.callback_data?.startsWith('topup_ton_paid:'));
   assert.ok(paid);
   await send(callback(101,paid.callback_data,true));
   assert.ok(calls.some(c=>c.body.text?.includes('رقم المعاملة (TXID)')));
   await send(message(101,'b'.repeat(64)));
   const request=conn.prepare('SELECT * FROM topup_requests WHERE user_tg_id=101').get();
   assert.ok(request);
   assert.equal(request.status,'pending');
   assert.equal(request.transfer_reference,'b'.repeat(64));
   assert.equal(request.custom_method_key,'custom_ton_demo');
   assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
   assert.ok(calls.some(c=>c.body.text?.includes('بانتظار مراجعة الإدارة')&&c.body.text?.includes('قريباً')));
   assert.ok(calls.some(c=>String(c.body.chat_id)==='991' && (c.body.text||c.body.caption||'').includes('رقم الحوالة')));
   await send(callback(991,'topup_approve:'+request.id));
   await send(callback(991,'topup_commit:'+request.id+':15200'));
   assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,15200);
   assert.equal(conn.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='topup'").get().n,1);
 });}finally{conn.close();}
});
