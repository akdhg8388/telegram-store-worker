import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {releaseExpiredSuspensions,clearExpiredSuspension,guardUser,SUSPENSION_END_NOTICE} from '../src/moderation.js';
import {baghdadDate} from '../src/wallet.js';
import {telegram,latinDigits,flushOutbox} from '../src/telegram.js';

function fixture(){
  const conn=new DatabaseSync(':memory:');
  const names=readdirSync(new URL('../migrations/',import.meta.url))
    .filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort();
  for(const name of names)conn.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={
    prepare(sql){
      const statement=conn.prepare(sql);
      let args=[];
      const q={
        bind(...values){args=values;return q},
        async first(){return statement.get(...args)??null},
        async all(){return {results:statement.all(...args)}},
        async run(){const r=statement.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
      };return q;
    },
    async batch(statements){
      conn.exec('BEGIN');
      try{const result=[];for(const statement of statements)result.push(await statement.run());conn.exec('COMMIT');return result;}
      catch(error){conn.exec('ROLLBACK');throw error}
    }
  };
  return {conn,db};
}

test('date preserves Baghdad timezone but uses Latin digits and no city suffix',()=>{
  const text=baghdadDate('2026-11-12T20:53:00Z');
  assert.match(text,/2026/);
  assert.match(text,/11:53/);
  assert.doesNotMatch(text,/بغداد|Baghdad|[٠-٩۰-۹]/);
  assert.match(baghdadDate('2026-11-12T20:53:00Z','en'),/11:53/);
  assert.equal(latinDigits('١٢٣٤ ۵۶۷۸ ٩'), '1234 5678 9');
});

test('cron releases expired suspensions once, preserving bans and balance',async()=>{
  const {conn,db}=fixture();
  const now=Math.floor(Date.now()/1000);
  try{
    const add=conn.prepare('INSERT INTO users(tg_id,first_name,is_blocked,suspended_until,restriction_reason) VALUES(?,?,?,?,?)');
    add.run(101,'Expired',0,now-1,'Test');
    add.run(102,'Still suspended',0,now+3600,'Test');
    add.run(103,'Blocked',1,now-1,'Test');
    assert.equal(await releaseExpiredSuspensions(db,now),1);
    assert.equal(await releaseExpiredSuspensions(db,now),0);
    assert.equal(conn.prepare('SELECT suspended_until FROM users WHERE tg_id=101').get().suspended_until,null);
    assert.equal(conn.prepare('SELECT suspended_until FROM users WHERE tg_id=102').get().suspended_until,now+3600);
    assert.equal(conn.prepare('SELECT is_blocked FROM users WHERE tg_id=103').get().is_blocked,1);
    const payloads=conn.prepare('SELECT payload FROM notification_outbox').all().map(x=>JSON.parse(x.payload));
    assert.equal(payloads.length,1);
    assert.equal(payloads[0].chat_id,101);
    assert.equal(payloads[0].text,SUSPENSION_END_NOTICE);
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
  }finally{conn.close();}
});

test('webhook expiry and cron both use idempotent notification transition',async()=>{
  const {conn,db}=fixture();
  const now=Math.floor(Date.now()/1000);
  try{
    conn.prepare('INSERT INTO users(tg_id,first_name,suspended_until) VALUES(101,?,?)').run('Buyer',now-1);
    assert.equal(await guardUser(db,{ADMIN_ID:'991'},101),null);
    assert.equal(await clearExpiredSuspension(db,101,now),0);
    assert.equal(await releaseExpiredSuspensions(db,now),0);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n,1);
  }finally{conn.close();}
});

test('Telegram outbound messages and buttons use Latin digits without touching callback IDs',async()=>{
  const previous=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    requests.push({method:String(url).split('/').at(-1),params:JSON.parse(options.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:77}}),{status:200});
  };
  try{
    await telegram({TELEGRAM_BOT_TOKEN:'TEST'},'sendMessage',{
      chat_id:101,text:'الطلب ١٢٣ وتم الإرسال ۴۵۶',
      reply_markup:{inline_keyboard:[[{text:'صفحة ٩',callback_data:'page:٩'}]]}
    });
    assert.equal(requests[0].params.text,'الطلب 123 وتم الإرسال 456');
    assert.equal(requests[0].params.reply_markup.inline_keyboard[0][0].text,'صفحة 9');
    assert.equal(requests[0].params.reply_markup.inline_keyboard[0][0].callback_data,'page:٩');
  }finally{globalThis.fetch=previous;}
});

test('expiry outbox notice delivers through existing Telegram sender',async()=>{
  const {conn,db}=fixture();
  const previous=globalThis.fetch;
  const sent=[];
  globalThis.fetch=async(url,options)=>{
    sent.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ok:true,result:{message_id:90}}),{status:200});
  };
  try{
    const now=Math.floor(Date.now()/1000);
    conn.prepare('INSERT INTO users(tg_id,first_name,suspended_until) VALUES(101,?,?)').run('Buyer',now-1);
    assert.equal(await releaseExpiredSuspensions(db,now),1);
    await flushOutbox(db,{TELEGRAM_BOT_TOKEN:'TEST'});
    assert.equal(sent.length,1);
    assert.equal(sent[0].chat_id,101);
    assert.match(sent[0].text,/Pixel-Store/);
    assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE state='sent'").get().n,1);
  }finally{globalThis.fetch=previous;conn.close();}
});
