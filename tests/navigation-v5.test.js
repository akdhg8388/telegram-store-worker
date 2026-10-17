import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { processUpdate } from '../src/bot.js';
import { persistentMenu,button,backRow } from '../src/common.js';
import { home,wallet,profile,products } from '../src/ui.js';

function createTestDb(){
  const conn=new DatabaseSync(':memory:');
  for(const migration of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql'])
    conn.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
  const db={prepare(sql){const stmt=conn.prepare(sql);let values=[];
    const q={bind(...v){values=v;return q},async first(){return stmt.get(...values)??null},
      async all(){return {results:stmt.all(...values)}},async run(){const x=stmt.run(...values);return {meta:{changes:x.changes,last_row_id:Number(x.lastInsertRowid)}}}};
    return q;
  }};
  return {db,conn};
}
async function withTelegram(cb){
  const original=globalThis.fetch,messages=[];
  globalThis.fetch=async(url,opts)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(opts.body);
    messages.push({method,body});
    return new Response(JSON.stringify({ok:true,result:{message_id:400+messages.length}}),{status:200});
  };
  try{await cb(messages)}finally{globalThis.fetch=original}
}
function msg(user,content,updateId){
  return {update_id:updateId,message:{from:{id:user,first_name:'Tester'},chat:{id:user,type:'private'},text:content}};
}
const env={TELEGRAM_BOT_TOKEN:'MOCK_ONLY',ADMIN_ID:'991',STORE_NAME:'My Store',BOT_USERNAME:'MyStoreIQBot',ENABLE_MANUAL_TOPUPS:'false'};

test('all ordinary inline buttons use supported primary style',()=>{
  assert.deepEqual(button('orders','orders'),{text:'orders',callback_data:'orders',style:'primary'});
  assert.deepEqual(backRow().map(x=>x.callback_data),['home','categories','orders']);
  assert.ok(backRow().every(x=>x.style));
});
test('persistent quick navigation is visible to users; admin shortcut reserved for owner',()=>{
  const user=persistentMenu(false),owner=persistentMenu(true);
  assert.equal(user.is_persistent,true);
  assert.equal(user.one_time_keyboard,false);
  assert.ok(user.keyboard.flat().some(x=>x.text==='💳 محفظتي'));
  assert.ok(!user.keyboard.flat().some(x=>x.text.includes('الإدارة')));
  assert.ok(owner.keyboard.flat().some(x=>x.text==='🛡️ الإدارة'));
  assert.ok(owner.keyboard.flat().every(x=>x.style));
});
test('first /start sends persistent menu once, then inline main menu',async()=>{
  const {db,conn}=createTestDb();
  try{await withTelegram(async(messages)=>{
    const ctx={waitUntil(){}};
    await processUpdate(db,env,ctx,msg(991,'/start',100));
    assert.equal(messages.length,2);
    assert.ok(messages[0].body.reply_markup.keyboard);
    assert.ok(messages[0].body.reply_markup.keyboard.flat().some(x=>x.text==='🛡️ الإدارة'));
    assert.ok(messages[1].body.reply_markup.inline_keyboard);
    assert.equal(conn.prepare('SELECT nav_keyboard_sent FROM users WHERE tg_id=991').get().nav_keyboard_sent,1);
    await processUpdate(db,env,ctx,msg(991,'/start',101));
    assert.equal(messages.length,3);
    assert.ok(!messages[2].body.reply_markup.keyboard);
  });}finally{conn.close()}
});
test('user shortcut navigation clears unfinished search state and opens screens',async()=>{
  const {db,conn}=createTestDb();
  try{await withTelegram(async(messages)=>{
    const ctx={waitUntil(){}};
    await processUpdate(db,env,ctx,msg(777,'/start',200));
    assert.ok(!messages[0].body.reply_markup.keyboard.flat().some(x=>x.text==='🛡️ الإدارة'));
    conn.prepare("INSERT INTO user_sessions(user_tg_id,action) VALUES (777,'search')").run();
    await processUpdate(db,env,ctx,msg(777,'📦 طلباتي',201));
    assert.equal(conn.prepare('SELECT action FROM user_sessions WHERE user_tg_id=777').get(),undefined);
    assert.match(messages.at(-1).body.text,/طلباتي/);
    await processUpdate(db,env,ctx,msg(777,'💳 محفظتي',202));
    assert.match(messages.at(-1).body.text,/💳 محفظتي/);
    assert.doesNotMatch(messages.at(-1).body.text,/رصيد المحفظة لا يُستخدم/);
    await processUpdate(db,env,ctx,msg(777,'🏠 الرئيسية',203));
    assert.match(messages.at(-1).body.text,/My Store/);
  });}finally{conn.close()}
});
test('home wallet profile and products controls use styled buttons',async()=>{
  const {db,conn}=createTestDb();
  try{
    conn.prepare("INSERT INTO users(tg_id,first_name) VALUES (777,'Tester')").run();
    await withTelegram(async(messages)=>{
      await home(db,env,777);
      await wallet(db,env,777);
      await profile(db,env,777);
      await products(db,env,777);
      for(const x of messages)
        for(const b of x.body.reply_markup.inline_keyboard.flat())
          assert.ok(['primary','success','danger'].includes(b.style),b.text+' missing style');
      assert.ok(messages[0].body.reply_markup.inline_keyboard.flat().some(b=>b.text==='💳 محفظتي'));
    });
  }finally{conn.close()}
});
