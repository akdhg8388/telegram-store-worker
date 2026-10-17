import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {flushOutbox,queueNotification} from '../src/telegram.js';

function setup(){
  const conn=new DatabaseSync(':memory:');
  for(const file of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql'])
    conn.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const db={
    prepare(sql){
      const stmt=conn.prepare(sql); let values=[];
      const q={
        bind(...args){values=args;return q},
        async first(){return stmt.get(...values)??null},
        async all(){return {results:stmt.all(...values)}},
        async run(){const r=stmt.run(...values);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
      };
      return q;
    }
  };
  return {conn,db};
}

test('legacy reply command points owner to audited support inbox',async()=>{
  const {conn,db}=setup();
  const previousFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(url,init)=>{
    requests.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:77}}),{status:200});
  };
  try {
    const background=[];
    await processUpdate(db,{ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_TEST_TOKEN'},
      {waitUntil(p){background.push(p)}},
      {update_id:777,message:{from:{id:991,first_name:'Owner'},chat:{id:991,type:'private'},text:'/reply 101 تم الرد على طلبك'}});
    await Promise.all(background);
    assert.equal(conn.prepare('SELECT count(*) n FROM notification_outbox').get().n,0);
    assert.ok(requests.some(({body})=>String(body.chat_id)==='991' && body.text.includes('رسائل الدعم الفني')));
  } finally {globalThis.fetch=previousFetch;conn.close();}
});


test('outbox backs off after Telegram rate limiting and does not retry immediately',async()=>{
  const {conn,db}=setup();
  const original=globalThis.fetch;
  let requests=0;
  globalThis.fetch=async()=>{
    requests++;
    return new Response(JSON.stringify({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:120}}),{status:429});
  };
  try{
    await queueNotification(db,'sendMessage',{chat_id:101,text:'notice'});
    const before=Math.floor(Date.now()/1000);
    await flushOutbox(db,{TELEGRAM_BOT_TOKEN:'TEST_TOKEN'});
    const row=conn.prepare('SELECT state,attempts,next_attempt_at FROM notification_outbox').get();
    assert.equal(row.state,'pending');
    assert.equal(row.attempts,1);
    assert.ok(row.next_attempt_at>=before+120);
    await flushOutbox(db,{TELEGRAM_BOT_TOKEN:'TEST_TOKEN'});
    assert.equal(requests,1);
  } finally {globalThis.fetch=original;conn.close();}
});

test('rapid duplicate wallet purchase confirmation only debits once and reserves one unit',async()=>{
 const {conn,db}=setup();
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Shopper'),(991,'Owner')").run();
 conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,20000,'topup','real-credit')").run();
 conn.prepare("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,fulfillment_mode,delivery_shared_text) VALUES(1,'Demo',1,5000,5,'shared','demo-data')").run();
 const previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>new Response(JSON.stringify({ok:true,result:{message_id:88}}),{status:200});
 try{
   const jobs=[],e={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN'};
   const click=(id,data,num)=>processUpdate(db,e,{waitUntil(x){jobs.push(x)}},
      {update_id:num,callback_query:{id,from:{id:101,first_name:'Shopper'},message:{message_id:555,chat:{id:101,type:'private'}},data}});
   await click('begin','buy:1',2999);
   const pending=conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get();
   const nonce=JSON.parse(pending.payload).nonce;
   await click('cbA','wallet_confirm:'+nonce,3000);
   await click('cbB','wallet_confirm:'+nonce,3001);
   await Promise.all(jobs);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_purchases').get().n,1);
   assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,15000);
   assert.equal(conn.prepare('SELECT stock FROM products WHERE id=1').get().stock,4);
   assert.equal(conn.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE kind='permitted_purchase'").get().n,1);
 } finally {globalThis.fetch=previous;conn.close();}
});

test('disabled manual wallet topup cannot be bypassed with stale inline buttons or sessions',async()=>{
 const {db,conn}=setup();
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Shopper')").run();
 conn.prepare("INSERT INTO user_sessions(user_tg_id,action,payload) VALUES(101,'topup_reference',?)").run(JSON.stringify({method:'asiacell',amount:10000}));
 const previous=globalThis.fetch;
 const seen=[];
 globalThis.fetch=async(url,init)=>{
   seen.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});
   return new Response(JSON.stringify({ok:true,result:{message_id:88}}),{status:200});
 };
 try {
   const ctx={waitUntil() {}};
   await processUpdate(db,{ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN',ENABLE_MANUAL_TOPUPS:'false'},ctx,
     {update_id:9001,callback_query:{id:'cb1',from:{id:101,first_name:'Shopper'},message:{message_id:7,chat:{type:'private',id:101}},data:'topup_preset:10'}});
   await processUpdate(db,{ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN',ENABLE_MANUAL_TOPUPS:'false'},ctx,
     {update_id:9002,message:{from:{id:101,first_name:'Shopper'},chat:{type:'private',id:101},text:'reference999'}});
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,0);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM user_sessions').get().n,0);
   assert.ok(seen.some(x=>x.body.text?.includes('الشحن')));
 } finally {globalThis.fetch=previous;conn.close();}
});
