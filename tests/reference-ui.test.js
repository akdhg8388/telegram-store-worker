import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {categories,wallet} from '../src/ui.js';
import {backRow} from '../src/common.js';

function createTestDb(){
  const conn=new DatabaseSync(':memory:');
  for(const file of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql'])
    conn.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  conn.prepare("INSERT INTO users(tg_id,first_name) VALUES (101,'Owner')").run();
  const db={prepare(sql){const stmt=conn.prepare(sql);let values=[];
    const q={bind(...items){values=items;return q},async first(){return stmt.get(...values)??null},
      async all(){return {results:stmt.all(...values)}},async run(){const ret=stmt.run(...values);return {meta:{changes:ret.changes,last_row_id:Number(ret.lastInsertRowid)}}}};
    return q;
  }};
  return {conn,db};
}
async function withMockTelegram(callback){
  const previous=globalThis.fetch;const sent=[];
  globalThis.fetch=async(url,opt)=>{sent.push({url:String(url),method:String(url).split('/').at(-1),payload:JSON.parse(opt.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:12}}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{return await callback(sent)}finally{globalThis.fetch=previous}
}

test('new reference catalog organizes categories into three-column rows and preserves hosting',async()=>{
 const {conn,db}=createTestDb();
 try{
  const cats=conn.prepare('SELECT slug FROM categories WHERE active=1 ORDER BY sort_order,id').all().map(x=>x.slug);
  assert.deepEqual(cats.slice(0,6),['chatgpt','gemini','grok','codex-api','claude','kimi']);
  assert.ok(cats.length>=25);
  assert.ok(cats.includes('hosting-apps')&&cats.includes('hosting-web'));
  assert.equal(conn.prepare('SELECT count(*) AS n FROM products').get().n,0);
  await withMockTelegram(async(sent)=>{
    await categories(db,{TELEGRAM_BOT_TOKEN:'TEST'},101,555);
    assert.equal(sent[0].method,'editMessageText');
    const rows=sent[0].payload.reply_markup.inline_keyboard;
    const cRows=rows.filter(row=>row.some(b=>b.callback_data?.startsWith('category:')));
    assert.equal(cRows[0].length,3);
    assert.equal(cRows[1].length,3);
    assert.ok(cRows.every(row=>row.length<=3));
    assert.ok(cRows.flat().every(b=>b.style==='primary'));
  });
 }finally{conn.close()}
});

test('wallet displays disabled status while retaining the visible topup entry',async()=>{
 const {conn,db}=createTestDb();
 try{
  await withMockTelegram(async(sent)=>{
    await wallet(db,{TELEGRAM_BOT_TOKEN:'TEST',ENABLE_MANUAL_TOPUPS:'false'},101);
    const controls=sent[0].payload.reply_markup.inline_keyboard.flat();
    assert.ok(controls.some(b=>b.callback_data==='topup'));
    assert.ok(sent[0].payload.text.includes('لم يُفعّل'));
    assert.ok(controls.some(b=>b.callback_data==='transactions'));
  });
  await withMockTelegram(async(sent)=>{
    await wallet(db,{TELEGRAM_BOT_TOKEN:'TEST',ENABLE_MANUAL_TOPUPS:'true'},101);
    assert.ok(sent[0].payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='topup'));
  });
 }finally{conn.close()}
});

test('back navigation uses the supported danger button style',()=>{
 assert.deepEqual(backRow(),[{text:'↩️ الرجوع للرئيسية',callback_data:'home',style:'danger'}]);
});
