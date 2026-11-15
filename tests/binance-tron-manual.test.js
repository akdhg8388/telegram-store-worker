import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {paymentMethod,methodList} from '../src/payment-methods.js';
import {isTronManualPaymentMethod,TRON_ADDRESS,TRON_QR_URL,validTronTxid} from '../src/tron-payment.js';

function fixture(){
 const conn=new DatabaseSync(':memory:');
 const files=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>/^00\d\d_.*\.sql$/.test(name)).sort();
 for(const name of files)conn.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(101,'Buyer','USD'),(991,'Owner','USD')").run();
 conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520'),('manual_topups_enabled','true')").run();
 const db={
   prepare(sql){
     const stmt=conn.prepare(sql);let args=[];
     const q={bind(...values){args=values;return q},async first(){return stmt.get(...args)??null},
       async all(){return {results:stmt.all(...args)}},
       async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};
     return q;
   },
   async batch(stmts){
     conn.exec('BEGIN');try{const results=[];for(const s of stmts)results.push(await s.run());conn.exec('COMMIT');return results;}
     catch(e){conn.exec('ROLLBACK');throw e;}
   }
 };
 return {db,conn};
}
test('Binance USDT TRON method is separate, enabled, and never resurrects auto TRC20',async()=>{
 const {db,conn}=fixture();
 try{
  const binance=await paymentMethod(db,{},'binance_tron');
  assert.equal(binance.receiver,TRON_ADDRESS);
  assert.equal(binance.photo_file_id,TRON_QR_URL);
  assert.equal(binance.pay_currency,'USD');
  assert.equal(binance.name_ar,'TRON شبكة Binance');
  assert.equal(binance.name_en,'TRON شبكة Binance');
  assert.ok(isTronManualPaymentMethod(binance));
  assert.equal(isTronManualPaymentMethod(await paymentMethod(db,{},'usdt_trc20')),false);
  const list=await methodList(db,{}, {activeOnly:true});
  assert.ok(list.some(m=>m.method_key==='binance_tron'));
  assert.ok(!list.some(m=>m.method_key==='usdt_trc20'));
  assert.ok(list.some(m=>m.method_key==='ton_usdt'));
  assert.equal(conn.prepare("SELECT enabled+visible AS n FROM payment_methods WHERE method_key='usdt_trc20'").get().n,0);
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,0);
 }finally{conn.close();}
});
test('TRON TXID requires 64 hexadecimal digits, not arbitrary text',()=>{
 assert.ok(validTronTxid('ab'.repeat(32)));
 assert.equal(validTronTxid('x'.repeat(64)),false);
 assert.equal(validTronTxid('ab'.repeat(31)),false);
 assert.equal(validTronTxid('a'.repeat(64)+' extra'),false);
});
test('Binance TRON payment displays normal-weight QR and copy button; TXID enters manual approval only',async()=>{
 const {db,conn}=fixture();
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
   const method=String(url).split('/').at(-1);
   let body;
   if(options.body instanceof FormData){
     const image=options.body.get('photo');
     assert.ok(image instanceof Blob);
     assert.equal(image.type,'image/png');
     const bytes=new Uint8Array(await image.arrayBuffer());
     assert.equal(bytes.length,2533);
     assert.deepEqual(Array.from(bytes.slice(0,8)),[137,80,78,71,13,10,26,10]);
     body={...Object.fromEntries(options.body.entries()),
       photo:{filename:image.name,size:image.size}};
     body.reply_markup=JSON.parse(body.reply_markup);
   }else body=JSON.parse(options.body);
   calls.push({body,method});
   for(const row of body.reply_markup?.inline_keyboard||[])
     for(const btn of row)if(btn.callback_data)assert.ok(Buffer.byteLength(btn.callback_data,'utf8')<=64);
   return new Response(JSON.stringify({ok:true,result:{message_id:710+calls.length}}),{status:200});
 };
 const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',ENABLE_MANUAL_TOPUPS:'true'};
 let updateId=6500;
 const callback=(uid,data)=>({update_id:++updateId,callback_query:{
   id:'cb'+updateId,data,from:{id:uid,first_name:'Buyer'},
   message:{message_id:225,chat:{type:'private',id:uid}}
 }});
 const message=(uid,text)=>({update_id:++updateId,message:{
   message_id:300+updateId,from:{id:uid,first_name:'Buyer'},
   chat:{type:'private',id:uid},text
 }});
 async function send(update){
   const tasks=[];await processUpdate(db,env,{waitUntil(p){tasks.push(p)}},update);await Promise.all(tasks);
 }
 try{
   await send(callback(101,'topup_preset:10:USD'));
   const menu=calls.find(c=>String(c.body.text||'').includes('اختيار طريقة الشحن'));
   assert.ok(menu);
   const buttons=menu.body.reply_markup.inline_keyboard.flat();
   const selected=buttons.find(b=>b.callback_data?.startsWith('topup_method:binance_tron:'));
   assert.ok(selected);
   await send(callback(101,selected.callback_data));
   const card=calls.find(c=>c.method==='sendPhoto'&&c.body.caption?.includes('الدفع عبر Binance'));
   assert.ok(card,'Must show Binance QR payment card');
   assert.equal(card.body.photo.filename,'binance-tron-usdt.png');
   assert.equal(card.body.photo.size,2533);
   assert.ok(card.body.caption.includes(TRON_ADDRESS));
   assert.ok(card.body.caption.includes('Tether USDT'));
   assert.ok(card.body.caption.includes('TRON (TRC20)'));
   assert.doesNotMatch(card.body.caption,/صلاحية|25 دقيقة|انتهاء/);
   assert.equal(card.body.caption_entities,undefined,'No bold styling');
   const actions=card.body.reply_markup.inline_keyboard.flat();
   assert.equal(actions.find(b=>b.copy_text)?.copy_text.text,TRON_ADDRESS);
   const paid=actions.find(b=>b.callback_data?.startsWith('topup_tron_paid:'));
   assert.ok(paid);
   await send(callback(101,paid.callback_data));
   assert.ok(calls.some(c=>c.body.text?.includes('رقم المعاملة (TXID)')));
   await send(message(101,'not a transaction'));
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,0);
   await send(message(101,'a'.repeat(64)));
   const req=conn.prepare("SELECT * FROM topup_requests WHERE user_tg_id=101").get();
   assert.ok(req);
   assert.equal(req.status,'pending');
   assert.equal(req.custom_method_key,'binance_tron');
   assert.equal(req.transfer_reference,'a'.repeat(64));
   assert.equal(conn.prepare('SELECT wallet_balance_iqd n FROM users WHERE tg_id=101').get().n,0);
   assert.ok(calls.some(c=>c.body.text?.includes('بانتظار مراجعة الإدارة')&&c.body.text?.includes('قريباً')));
   assert.ok(calls.some(c=>String(c.body.chat_id)==='991' && String(c.body.text||c.body.caption||'').includes('رقم الحوالة')));
   await send(callback(991,'topup_approve:'+req.id));
   await send(callback(991,'topup_commit:'+req.id+':15200'));
   assert.equal(conn.prepare('SELECT wallet_balance_iqd n FROM users WHERE tg_id=101').get().n,15200);
   assert.equal(conn.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='topup'").get().n,1);
 }finally{globalThis.fetch=previous;conn.close();}
});
