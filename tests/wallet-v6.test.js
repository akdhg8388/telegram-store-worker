import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback} from '../src/admin-controls.js';
import {flushOutbox} from '../src/telegram.js';
import {formatUSD,formatQuote,quoteFromUSD,quoteMinor,parseCustomMinor,usdRate,baghdadDate} from '../src/wallet.js';

const migrations=['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql','0011_product_visuals.sql','0012_product_warranty.sql','0015_topup_chat_cleanup.sql','0017_payment_methods.sql','0018_transfer_quotes_and_topup_views.sql'];
function setup(migrate=true){
  const conn=new DatabaseSync(':memory:');
  for(const file of migrate?migrations:migrations.slice(0,5))
    conn.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const db={
    prepare(sql){
      const stmt=conn.prepare(sql);
      let bind=[];
      const q={
        bind(...values){bind=values;return q},
        async first(){return stmt.get(...bind)??null},
        async all(){return {results:stmt.all(...bind)}},
        async run(){const r=stmt.run(...bind);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}
      };
      return q;
    },
    async batch(statements){
      conn.exec('BEGIN');
      try {
        const results=[];
        for(const s of statements)results.push(await s.run());
        conn.exec('COMMIT');
        return results;
      }catch(e){conn.exec('ROLLBACK');throw e}
    }
  };
  return {conn,db};
}
function withTelegram(action){
  const save=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1);
    calls.push({method,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({ok:true,result:{message_id:812}}),{status:200});
  };
  return Promise.resolve().then(()=>action(calls)).finally(()=>{globalThis.fetch=save});
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_FOR_TESTS',ENABLE_MANUAL_TOPUPS:'false'};
function cb(update_id,id,uid,data,message_id=444){return {update_id,callback_query:{id,from:{id:uid,first_name:uid===991?'Owner':'Client'},message:{message_id,chat:{id:uid,type:'private'}},data}}}
function msg(update_id,uid,payload){return {update_id,message:{from:{id:uid,first_name:'Client'},chat:{id:uid,type:'private'},...payload}}}
async function runUpdates(db,items){const jobs=[];for(const item of items){await processUpdate(db,env,{waitUntil(p){jobs.push(p)}},item)} await Promise.all(jobs)}

function settings(conn){
  conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1300'),('zain_balance_receiver','0770 000 0000 — transfer'),('binance_receiver','Binance Pay ID 54321 — verified account')").run();
  conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Client'),(102,'Other'),(991,'Owner')").run();
}

test('new D1 migration preserves prior receipts, identifiers and wallet balances',()=>{
  const {conn}=setup(false);
  try{
    conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Client')").run();
    conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,20000,'topup','topup:legacy')").run();
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES(101,'zaincash',25000,'abc')").run();
    conn.exec(readFileSync(new URL('../migrations/0006_wallet_checkout.sql',import.meta.url),'utf8'));
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,20000);
    const item=conn.prepare('SELECT * FROM topup_requests WHERE id=1').get();
    assert.equal(item.transfer_reference,'abc');
    assert.equal(item.amount_iqd,25000);
    assert.equal(item.requested_currency,'IQD');
    assert.equal(item.requested_amount_minor,25000);
    assert.equal(conn.prepare('SELECT currency_preference FROM users WHERE tg_id=101').get().currency_preference,'IQD');
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES (101,'binance',30000,'binance-123')").run();
    assert.throws(()=>conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES (101,'binance',30000,'binance-123')").run(),/UNIQUE/);
  }finally{conn.close()}
});

test('currency selector uses only configured FX rate and is accurately quoted in D1',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    assert.equal(await usdRate(db),1300);
    assert.equal(formatUSD(2550),'$25.50');
    assert.deepEqual(quoteFromUSD(25,1300,'USD'),{currency:'USD',requestedMinor:2500,amountIqd:32500,rate:1300});
    assert.deepEqual(quoteFromUSD(25,1300,'IQD'),{currency:'IQD',requestedMinor:32500,amountIqd:32500,rate:1300});
    assert.equal(parseCustomMinor('25.50','USD'),2550);
    assert.equal(parseCustomMinor('25.555','USD'),null);
    assert.equal(parseCustomMinor('25000','IQD'),25000);
    assert.equal(quoteMinor('USD',2550,1300).amountIqd,33150);
    assert.equal(quoteMinor('IQD',25000,1300).requestedMinor,25000);
    assert.equal(quoteMinor('USD',120000,1300),null);
    assert.equal(formatQuote(quoteFromUSD(25,1300,'USD')),'$25.00 ≈ 32,500 د.ع');
    assert.match(baghdadDate('2026-10-17 11:00:00'),/14:00|٢:٠٠|2:00|٢:٠٠/);
  }finally{conn.close()}
});

test('admin must configure rate and receiver before activating manual topups',async()=>{
  const {conn,db}=setup();
  try{
    conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner')").run();
    await withTelegram(async calls=>{
      assert.equal(await handleAdminCallback(db,env,991,'admin_toggle_topups'),true);
      assert.ok(calls.some(c=>c.body.text?.includes('حدّد سعر الدولار')));
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM bot_settings WHERE key='manual_topups_enabled'").get().n,0);
      conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1300'),('superqi_receiver','QI-1234')").run();
      await handleAdminCallback(db,env,991,'admin_toggle_topups');
      assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='manual_topups_enabled'").get().value,'true');
      assert.equal(await handleAdminCallback(db,env,101,'admin_toggle_topups'),true);
      assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='manual_topups_enabled'").get().value,'true');
    });
  }finally{conn.close()}
});

test('photo and transfer reference request is confirmed, appears in orders, approved only once, and sends success notice',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    conn.prepare("INSERT INTO bot_settings(key,value) VALUES('manual_topups_enabled','true')").run();
    await withTelegram(async calls=>{
      await runUpdates(db,[
        cb(101,'c1',101,'currency_set:USD',431),
        cb(102,'c2',101,'topup_preset:25:USD',432),
      ]);
      const methodNonce=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).quoteKey;
      await runUpdates(db,[
        cb(103,'c3',101,'topup_method:zain_balance:'+methodNonce,433),
        msg(104,101,{text:'ZAIN-REF-001'}),
        msg(105,101,{photo:[{file_id:'telegram-file-1',file_unique_id:'unique-photo-1'}]}),
      ]);
      const payload=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload);
      assert.match(payload.nonce,/^[0-9a-f-]{36}$/);
      await runUpdates(db,[
        cb(106,'c4',101,'topup_submit:'+payload.nonce,777),
        cb(107,'c5',101,'topup_submit:'+payload.nonce,777),
        cb(108,'c6',101,'orders',778),
      ]);
      let row=conn.prepare('SELECT * FROM topup_requests').get();
      assert.equal(row.amount_iqd,32500);
      assert.equal(row.requested_currency,'USD');
      assert.equal(row.requested_amount_minor,2500);
      assert.equal(row.method,'zain_balance');
      assert.equal(row.transfer_reference,'ZAIN-REF-001');
      assert.equal(row.proof_file_id,'telegram-file-1');
      assert.equal(row.status,'pending');
      assert.equal(row.source_message_id,777);
      assert.equal(row.submission_key,payload.nonce);
      assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,1);
      assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
      assert.ok(calls.some(c=>String(c.body.text||'').includes('طلبات شحن المحفظة')));
      assert.ok(calls.some(c=>String(c.body.text||'').includes('سُجل طلبك بالفعل')));
      await runUpdates(db,[cb(109,'c7',991,'topup_approve:1',881),cb(110,'c8',991,'topup_commit:1:32500',882),cb(111,'c9',991,'topup_commit:1:32500',882)]);
      row=conn.prepare('SELECT * FROM topup_requests WHERE id=1').get();
      assert.equal(row.status,'approved');
      assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,32500);
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE source_key='topup:1'").get().n,1);
      await flushOutbox(db,env);
      assert.ok(calls.some(c=>String(c.body.text||'').includes('تم شحن محفظتك بنجاح')));
      assert.equal(conn.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE payload LIKE '%تم شحن محفظتك بنجاح%'").get().n,1);
    });
  }finally{conn.close()}
});

test('rejected receipts do not alter credit; topup status is private',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference,requested_currency,requested_amount_minor,quoted_rate_iqd) VALUES(101,'binance',13000,'bin-ref','USD',1000,1300)").run();
    await withTelegram(async calls=>{
      await runUpdates(db,[cb(555,'deny',102,'topup_status:1',500)]);
      assert.ok(calls.some(c=>String(c.body.text||'').includes('لا يوجد طلب شحن')));
      await runUpdates(db,[cb(556,'reject',991,'topup_reject:1',501)]);
      assert.equal(conn.prepare("SELECT status FROM topup_requests WHERE id=1").get().status,'rejected');
      assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
      assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
    });
  }finally{conn.close()}
});

test('stale currency preset, stale method button and stale confirm cannot hijack an active topup',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    conn.prepare("INSERT INTO bot_settings(key,value) VALUES('manual_topups_enabled','true')").run();
    await withTelegram(async calls=>{
      await runUpdates(db,[cb(901,'c1',101,'currency_set:USD'),cb(902,'c2',101,'topup_preset:10:USD')]);
      const old=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).quoteKey;
      await runUpdates(db,[cb(903,'c3',101,'topup_preset:25:USD')]);
      const newer=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).quoteKey;
      assert.notEqual(old,newer);
      await runUpdates(db,[cb(904,'c4',101,'topup_method:zain_balance:'+old)]);
      assert.equal(conn.prepare('SELECT action FROM user_sessions WHERE user_tg_id=101').get().action,'topup_choose_method');
      await runUpdates(db,[cb(905,'c5',101,'topup_method:zain_balance:'+newer),msg(906,101,{text:'ref-a'})]);
      const confirm=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).nonce;
      await runUpdates(db,[cb(907,'c6',101,'topup_preset:10:USD'),cb(908,'c7',101,'topup_submit:'+confirm)]);
      assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,0);
      assert.ok(calls.some(c=>String(c.body.text||'').includes('تأكيد قديمة')));
      await runUpdates(db,[cb(909,'c8',101,'currency_set:IQD'),cb(910,'c9',101,'topup_preset:10:USD')]);
      assert.ok(calls.some(c=>String(c.body.text||'').includes('تغيرت العملة')));
    });
  }finally{conn.close()}
});

test('photo-only Binance proof can be submitted, but pending cap prevents excessive requests',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    conn.prepare("INSERT INTO bot_settings(key,value) VALUES('manual_topups_enabled','true')").run();
    await withTelegram(async()=>{
      await runUpdates(db,[cb(1000,'a1',101,'topup_preset:10:IQD')]);
      const quoteKey=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).quoteKey;
      await runUpdates(db,[cb(1001,'a2',101,'topup_method:binance:'+quoteKey),msg(1002,101,{photo:[{file_id:'bin-file',file_unique_id:'bin-unique'}]})]);
      const nonce=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).nonce;
      await runUpdates(db,[cb(1003,'a3',101,'topup_submit:'+nonce,901)]);
      const row=conn.prepare('SELECT method,transfer_reference,proof_file_id,amount_iqd,status FROM topup_requests').get();
      assert.equal(row.method,'binance');
      assert.equal(row.transfer_reference,null);
      assert.equal(row.proof_file_id,'bin-file');
      assert.equal(row.amount_iqd,13000);
      assert.equal(row.status,'pending');
      conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES (101,'binance',13000,'other-1'),(101,'binance',13000,'other-2')").run();
      await runUpdates(db,[cb(1004,'a4',101,'topup_preset:25:IQD')]);
      const otherKey=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).quoteKey;
      await runUpdates(db,[cb(1005,'a5',101,'topup_method:binance:'+otherKey),msg(1006,101,{text:'other-3'})]);
      const nonce2=JSON.parse(conn.prepare('SELECT payload FROM user_sessions WHERE user_tg_id=101').get().payload).nonce;
      await runUpdates(db,[cb(1007,'a6',101,'topup_submit:'+nonce2,902)]);
      assert.equal(conn.prepare('SELECT COUNT(*) n FROM topup_requests').get().n,3);
    });
  }finally{conn.close()}
});

test('admin may approve an already submitted request even after disabling new topups',async()=>{
  const {conn,db}=setup();
  try{
    settings(conn);
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES(101,'superqi',50000,'old-legit-transfer')").run();
    await withTelegram(async()=>{
      await runUpdates(db,[cb(1200,'admin',991,'topup_approve:1'),cb(1201,'commit',991,'topup_commit:1:50000')]);
      assert.equal(conn.prepare('SELECT status FROM topup_requests WHERE id=1').get().status,'approved');
      assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,50000);
    });
  }finally{conn.close()}
});
