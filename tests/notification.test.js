import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {flushOutbox,queueNotification} from '../src/telegram.js';

function setup(){
  const conn=new DatabaseSync(':memory:');
  for(const file of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql'])
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

test('admin support reply is queued and delivered instead of failing',async()=>{
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
    assert.equal(conn.prepare('SELECT count(*) n FROM notification_outbox').get().n,1);
    assert.ok(requests.some(({body})=>String(body.chat_id)==='101' && body.text.includes('تم الرد على طلبك')));
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

test('rapid double-tap with different callback IDs creates only one order',async()=>{
 const {conn,db}=setup();
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Shopper'),(991,'Owner')").run();
 conn.prepare("INSERT INTO products(category_id,title,price_stars,stock) VALUES(1,'Demo',20,5)").run();
 const before=globalThis.fetch;
 globalThis.fetch=async(url,init)=>new Response(JSON.stringify({ok:true,result:{message_id:88}}),{status:200});
 try{
   const background=[];
   for(const [updateId,callbackId] of [[3000,'cbA'],[3001,'cbB']]){
     await processUpdate(db,{ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN'},
       {waitUntil(p){background.push(p)}},
       {update_id:updateId,callback_query:{id:callbackId,from:{id:101,first_name:'Shopper'},
        message:{message_id:555,chat:{id:101,type:'private'}},data:'confirm_buy:1'}});
   }
   await Promise.all(background);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,1);
 } finally {globalThis.fetch=before;conn.close();}
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
     {update_id:9001,callback_query:{id:'cb1',from:{id:101,first_name:'Shopper'},message:{message_id:7,chat:{type:'private',id:101}},data:'topup_amount:asiacell:10000'}});
   await processUpdate(db,{ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN',ENABLE_MANUAL_TOPUPS:'false'},ctx,
     {update_id:9002,message:{from:{id:101,first_name:'Shopper'},chat:{type:'private',id:101},text:'reference999'}});
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,0);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM user_sessions').get().n,0);
   assert.ok(seen.some(x=>x.body.text?.includes('الشحن اليدوي')));
 } finally {globalThis.fetch=previous;conn.close();}
});
