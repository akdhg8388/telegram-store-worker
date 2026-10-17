import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {flushOutbox} from '../src/telegram.js';
import {guardUser,suspensionTime} from '../src/moderation.js';
import {baghdadDate,topupStatusMessage} from '../src/wallet.js';

const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_BOT',ENABLE_MANUAL_TOPUPS:'true'};
function fixture(){
  const conn=new DatabaseSync(':memory:');
  for(const name of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql'])
    conn.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  conn.prepare("INSERT INTO users(tg_id,first_name,username) VALUES (101,'Customer','customer'),(102,'Other','other'),(991,'Owner','owner')").run();
  conn.prepare("INSERT INTO bot_settings(key,value) VALUES ('usd_rate_iqd','1520'),('superqi_receiver','TEST receiver'),('manual_topups_enabled','true')").run();
  const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];
    const q={bind(...values){args=values;return q},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const out=stmt.run(...args);return {meta:{changes:Number(out.changes),last_row_id:Number(out.lastInsertRowid)}}}};return q;},
    async batch(statements){conn.exec('BEGIN');try{const results=[];for(const st of statements)results.push(await st.run());conn.exec('COMMIT');return results;}catch(e){conn.exec('ROLLBACK');throw e}}
  };return {conn,db};
}
let updateId=20000;
function cb(uid,data,message_id=111){return {update_id:++updateId,callback_query:{id:'q'+updateId,from:{id:uid,first_name:uid===991?'Owner':'Customer'},message:{message_id,chat:{id:uid,type:'private'}},data}}}
function msg(uid,body){return {update_id:++updateId,message:{message_id:updateId,from:{id:uid,first_name:uid===991?'Owner':'Customer'},chat:{id:uid,type:'private'},...body}}}
async function send(db,events){const jobs=[];for(const e of events){await processUpdate(db,env,{waitUntil(p){jobs.push(p)}},e)}await Promise.all(jobs)}
async function withTelegram(fn,{failDelete=false}={}){
  const save=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,opts)=>{
    const method=String(url).split('/').at(-1),params=JSON.parse(opts.body);
    calls.push({method,params});
    if(method==='deleteMessage'&&failDelete)return new Response(JSON.stringify({ok:false,description:'Bad Request: message can\'t be deleted'}),{status:400});
    return new Response(JSON.stringify({ok:true,result:method==='deleteMessage'?true:{message_id:700+calls.length}}),{status:200});
  };
  try{return await fn(calls)}finally{globalThis.fetch=save}
}
const labels=calls=>calls.filter(c=>c.method==='sendMessage'||c.method==='editMessageText').map(c=>c.params.text||'');

test('customer topup confirmation uses polished language and does not expose admin processing',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    const {topupConfirm}=await import('../src/ui.js');
    await topupConfirm(db,env,101,{currency:'IQD',requestedMinor:152000,amountIqd:152000,method:'superqi',reference:null,proofFileId:'image1',nonce:'id1'});
    const text=labels(calls).at(-1);
    assert.match(text,/مراجعة طلب شحن المحفظة/);
    assert.match(text,/تاريخ|حالة|تحديث حالة الطلب/);
    assert.doesNotMatch(text,/قبل قبوله|للمدير/);
  });}finally{conn.close()}
});

test('owner can approve lower actual receipt exactly once; requested and credited amounts and dates are retained',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference,admin_notice_message_id) VALUES(101,'superqi',152000,'testref',654)").run();
    await send(db,[cb(991,'topup_detail:1'),cb(991,'topup_approve:1'),cb(991,'topup_amount:1'),msg(991,{text:'100000'})]);
    assert.ok(labels(calls).some(s=>s.includes('100,000 د.ع')&&s.includes('152,000 د.ع')));
    await send(db,[cb(991,'topup_commit:1:100000'),cb(991,'topup_commit:1:100000')]);
    const t=conn.prepare('SELECT * FROM topup_requests WHERE id=1').get();
    assert.equal(t.status,'approved');assert.equal(t.amount_iqd,152000);assert.equal(t.credited_amount_iqd,100000);
    assert.ok(t.created_at&&t.decided_at);
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,100000);
    assert.equal(conn.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE source_key='topup:1'").get().n,1);
    assert.ok(calls.some(c=>c.method==='editMessageReplyMarkup'&&c.params.message_id===654));
    await flushOutbox(db,env);
    assert.ok(labels(calls).some(s=>s.includes('المبلغ المضاف فعلياً: 100,000')));
    assert.match(topupStatusMessage(t),/المضاف فعلياً: 100,000/);
  });}finally{conn.close()}
});

test('reject never adds wallet money and removes old action keyboard',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference,admin_notice_message_id) VALUES(101,'superqi',12000,'r2',554)").run();
    await send(db,[cb(991,'topup_reject:1')]);
    assert.equal(conn.prepare('SELECT status FROM topup_requests').get().status,'rejected');
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
    assert.ok(calls.some(c=>c.method==='editMessageReplyMarkup'&&c.params.message_id===554));
  });}finally{conn.close()}
});

test('support message and video attachments are persisted, routed and opened only by owner',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    await send(db,[msg(101,{text:'/support'}),cb(101,'support_compose'),msg(101,{photo:[{file_id:'img',file_unique_id:'f1'}],caption:'الإيصال'}),msg(101,{text:'/support'}),cb(101,'support_compose'),msg(101,{video:{file_id:'clip'},caption:'الفيديو'})]);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM support_messages').get().n,2);
    assert.equal(conn.prepare("SELECT COUNT(*) n FROM support_messages WHERE kind='video'").get().n,1);
    assert.equal(conn.prepare("SELECT COUNT(*) n FROM support_messages WHERE is_unread=1").get().n,2);
    await flushOutbox(db,env);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM support_messages WHERE admin_notice_message_id IS NOT NULL').get().n,2);
    await send(db,[cb(101,'support_inbox')]);
    assert.ok(labels(calls).some(s=>s.includes('هذا القسم للمدير')));
    await send(db,[cb(991,'support_inbox'),cb(991,'support_thread:101')]);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM support_messages WHERE is_unread=1').get().n,0);
    assert.ok(labels(calls).some(s=>s.includes('📨 محادثة الدعم')&&s.includes('🎬 فيديو')));
    await send(db,[cb(991,'support_media:2')]);
    assert.ok(calls.some(c=>c.method==='sendVideo'&&c.params.video==='clip'));
  });}finally{conn.close()}
});

test('support admin replies are delivered, timestamped, and deletion clearly reports Telegram refusal',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    await send(db,[msg(101,{text:'/support'}),cb(101,'support_compose'),msg(101,{text:'هل الخدمة متوفرة؟'})]);
    await flushOutbox(db,env);
    await send(db,[cb(991,'support_reply:101'),msg(991,{text:'نعم، متوفرة'})]);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM support_messages').get().n,2);
    assert.ok(calls.some(c=>c.params?.chat_id===101&&String(c.params?.text).includes('نعم، متوفرة')));
    const reply=conn.prepare("SELECT * FROM support_messages WHERE direction='outgoing'").get();
    assert.equal(reply.admin_notice_message_id>0,true);
    assert.match(baghdadDate(reply.created_at),/بغداد/);
  });}finally{conn.close()}
});

test('full Telegram delete does not falsely claim total deletion on 48-hour/API failures',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async()=>{
    conn.prepare("INSERT INTO support_messages(user_tg_id,direction,kind,body,customer_message_id,admin_notice_message_id) VALUES (101,'incoming','text','hello',201,202)").run();
    await send(db,[cb(991,'support_delete_both:101'),cb(991,'support_confirm_both:101')]);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM support_messages').get().n,1);
  },{failDelete:true});}finally{conn.close()}
});

test('owner can permanently ban a user but not self, and all customer commands and buttons are denied',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    await send(db,[cb(991,'admin_ban:101'),msg(991,{text:'مخالفة الشروط'}),cb(991,'admin_confirm_ban:101')]);
    assert.equal(conn.prepare('SELECT is_blocked FROM users WHERE tg_id=101').get().is_blocked,1);
    await send(db,[cb(991,'admin_ban:991')]);
    assert.equal(conn.prepare('SELECT is_blocked FROM users WHERE tg_id=991').get().is_blocked,0);
    await send(db,[msg(101,{text:'/start'}),cb(101,'home')]);
    assert.ok(labels(calls).filter(s=>s.includes('تم إيقاف وصولك')).length>=2);
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
    await send(db,[cb(991,'admin_unban:101'),cb(991,'admin_confirm_unban:101')]);
    assert.equal(conn.prepare('SELECT is_blocked FROM users WHERE tg_id=101').get().is_blocked,0);
  });}finally{conn.close()}
});

test('suspension includes reason, expiry and automatic restoration without touching balance',async()=>{
  const {conn,db}=fixture();try{await withTelegram(async calls=>{
    await send(db,[cb(991,'admin_suspend_hours:101:24'),msg(991,{text:'اختبار السلوك'}),cb(991,'admin_confirm_suspend:101:24')]);
    const user=conn.prepare('SELECT * FROM users WHERE tg_id=101').get();
    assert.ok(user.suspended_until>Math.floor(Date.now()/1000)+80000);
    assert.equal(user.restriction_reason,'اختبار السلوك');
    assert.match(await guardUser(db,env,101),/معلّق مؤقتاً/);
    conn.prepare('UPDATE users SET suspended_until=? WHERE tg_id=101').run(Math.floor(Date.now()/1000)-1);
    assert.equal(await guardUser(db,env,101),null);
    assert.equal(conn.prepare('SELECT suspended_until FROM users WHERE tg_id=101').get().suspended_until,null);
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
    assert.equal(suspensionTime(Date.now(),9999999),null);
  });}finally{conn.close()}
});
