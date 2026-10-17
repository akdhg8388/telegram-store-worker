import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';

function setup(){
  const conn=new DatabaseSync(':memory:');
  for(const file of ['0001_init.sql','0002_admin_controls.sql'])
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
