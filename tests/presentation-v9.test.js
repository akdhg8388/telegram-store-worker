import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home,orders} from '../src/ui.js';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {customerThread,handleCustomerSupportCallback} from '../src/support.js';
import {DEFAULT_HOME_TEMPLATE,renderHomeTemplate} from '../src/presentation.js';

function fixture(){
  const conn=new DatabaseSync(':memory:');
  for(let i=1;i<=9;i++){
    const files=['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql'];
    conn.exec(readFileSync(new URL('../migrations/'+files[i-1],import.meta.url),'utf8'));
  }
  conn.prepare("INSERT INTO users(tg_id,first_name,username) VALUES (101,'مهند','mhnd'),(102,'Other','second'),(991,'Owner','admin')").run();
  conn.prepare("INSERT INTO bot_settings(key,value) VALUES ('usd_rate_iqd','1520')").run();
  conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (101,152000,'topup','v9:legitimate')").run();
  const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];
    const q={bind(...values){args=values;return q},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const x=stmt.run(...args);return {meta:{changes:Number(x.changes),last_row_id:Number(x.lastInsertRowid)}}}};return q;},
    async batch(stmts){conn.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());conn.exec('COMMIT');return out}catch(e){conn.exec('ROLLBACK');throw e}}
  };return {conn,db};
}
let sequence=51000;
function msg(uid,text){return {update_id:++sequence,message:{message_id:sequence,from:{id:uid,first_name:'مهند'},chat:{id:uid,type:'private'},text}}}
function cb(uid,data){return {update_id:++sequence,callback_query:{id:'q'+sequence,from:{id:uid,first_name:'مهند'},message:{message_id:900,chat:{id:uid,type:'private'}},data}}}
async function mockTelegram(fn){
  const prev=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,opts)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(opts.body);
    calls.push({method,body});
    let result={message_id:700+calls.length};
    if(method==='deleteMessage'||method==='deleteMessages')result=true;
    if(method==='answerCallbackQuery')result=true;
    return new Response(JSON.stringify({ok:true,result}),{status:200});
  };
  try{return await fn(calls)}finally{globalThis.fetch=prev}
}
const environment={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_TEST',STORE_NAME:'My Store',ENABLE_MANUAL_TOPUPS:'false'};
const texts=calls=>calls.filter(c=>['sendMessage','editMessageText'].includes(c.method)).map(c=>c.body.text);

test('V9 home uses real store, wallet, exchange rate, Telegram identity, user count and keeps buttons',async()=>{
 const {conn,db}=fixture();try{await mockTelegram(async calls=>{
   await home(db,environment,101);
   const [sent]=calls;
   assert.match(sent.body.text,/👋 أهلاً بك في My Store!/);
   assert.match(sent.body.text,/💰 رصيدك: IQD 152,000/);
   assert.doesNotMatch(sent.body.text,/\$100\.00|USD/);
   assert.ok(sent.body.entities.some(e=>e.type==='bold' && sent.body.text.slice(e.offset,e.offset+e.length)==='رصيدك:'));
   assert.ok(sent.body.entities.some(e=>e.type==='bold' && sent.body.text.slice(e.offset,e.offset+e.length)==='الاسم:'));
   assert.match(sent.body.text,/👤 الاسم: مهند/);
   assert.match(sent.body.text,/🆔 المعرّف: 101/);
   assert.match(sent.body.text,/👥 المستخدمون: 3/);
   assert.doesNotMatch(sent.body.text,/Stars|موافقة المدير/);
   const keyboard=sent.body.reply_markup.inline_keyboard.flat();
   assert.ok(keyboard.some(b=>b.callback_data==='wallet'));
   assert.ok(keyboard.some(b=>b.callback_data==='categories'));
   assert.ok(!keyboard.some(b=>b.callback_data==='admin'));
 })}finally{conn.close()}
});

test('V9 template is editable from owner panel without falsifying real placeholders',async()=>{
 const {conn,db}=fixture();try{await mockTelegram(async calls=>{
   assert.equal(await handleAdminCallback(db,environment,991,'admin_visuals'),true);
   assert.ok(texts(calls).some(t=>t.includes('تخصيص واجهة المتجر')));
   assert.equal(await handleAdminCallback(db,environment,991,'admin_setting_edit:home_template'),true);
   const session=conn.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=991').get();
   assert.equal(session.action,'owner_setting');
   const template='👋 {store} | 👤 {name} | 🆔 {id} | 💳 {balance} | 👥 {users}';
   await handleAdminText(db,environment,991,{action:session.action,payload:JSON.parse(session.payload)},{text:template});
   await home(db,environment,101);
   const last=texts(calls).at(-1);
   assert.match(last,/My Store \| 👤 مهند \| 🆔 101/);
   assert.match(last,/IQD 152,000/);
   assert.doesNotMatch(last,/100\.00 USD/);
   assert.match(last,/👥 3/);
 })}finally{conn.close()}
});

test('V9 custom emoji ID is extracted from actual Telegram entity, with UTF16 offset',async()=>{
 const {conn,db}=fixture();try{await mockTelegram(async calls=>{
   await handleAdminCallback(db,environment,991,'admin_setting_edit:home_custom_emoji_id');
   const session=conn.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=991').get();
   const custom='5368324170671202289';
   await handleAdminText(db,environment,991,{action:session.action,payload:JSON.parse(session.payload)},
     {text:'✨',entities:[{type:'custom_emoji',custom_emoji_id:custom,offset:0,length:1}]});
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_custom_emoji_id'").get().value,custom);
   await home(db,environment,101);
   const last=calls.at(-1).body;
   assert.equal(last.entities[0].custom_emoji_id,custom);
   assert.equal(last.entities[0].length,2); // default 👋 is a 2-unit UTF16 symbol
 })}finally{conn.close()}
});

test('V9 orders links to customer private inbox and shows preserved messages, images, videos with Baghdad timestamps',async()=>{
 const {conn,db}=fixture();try{await mockTelegram(async calls=>{
   conn.prepare("INSERT INTO support_messages(user_tg_id,direction,kind,body,telegram_file_id,customer_message_id) VALUES(101,'incoming','text','مرحبا',NULL,1000),(101,'incoming','photo','صورة','FILE-IMG',1001),(101,'outgoing','video','رد فيديو','FILE-VID',1002),(102,'incoming','text','خاص',NULL,1003)").run();
   await orders(db,environment,101);
   const markup=calls.at(-1).body.reply_markup.inline_keyboard.flat();
   assert.ok(markup.some(x=>x.callback_data==='my_support_inbox'));
   await customerThread(db,environment,101,0);
   const txt=texts(calls).at(-1);
   assert.match(txt,/مرحبا/);
   assert.match(txt,/📷 صورة/);
   assert.match(txt,/🎬 فيديو/);
   assert.doesNotMatch(txt,/خاص/);
   assert.match(txt,/بتوقيت بغداد/);
   const otherMediaId=conn.prepare('SELECT id FROM support_messages WHERE user_tg_id=102').get().id;
   await handleCustomerSupportCallback(db,environment,101,'my_support_media:'+otherMediaId);
   assert.ok(texts(calls).at(-1).includes('غير متوفر ضمن رسائلك'));
 })}finally{conn.close()}
});

test('V10 old-style navigation never deletes or tracks chat messages when opening Home',async()=>{
 const {conn,db}=fixture();const env={...environment,DB:db};try{await mockTelegram(async calls=>{
   const pending=[];const ctx={waitUntil(p){pending.push(p)}};
   await processUpdate(db,env,ctx,msg(101,'/orders'));
   await processUpdate(db,env,ctx,msg(101,'/wallet'));
   await processUpdate(db,env,ctx,cb(101,'home'));
   await processUpdate(db,env,ctx,msg(101,'/start'));
   assert.equal(calls.filter(c=>['deleteMessages','deleteMessage'].includes(c.method)).length,0);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM chat_cleanup_messages').get().n,0);
   assert.ok(calls.some(c=>c.method==='editMessageText' && c.body.message_id===900 && c.body.text.includes('أهلاً بك في My Store')));
   assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,152000);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,1);
   await Promise.all(pending);
 })}finally{conn.close()}
});

test('V9 missing FX rate is not fabricated and unknown placeholders are not executed',async()=>{
 const {conn,db}=fixture();try{await mockTelegram(async calls=>{
   conn.prepare("DELETE FROM bot_settings WHERE key='usd_rate_iqd'").run();
   conn.prepare("UPDATE users SET currency_preference='USD' WHERE tg_id=101").run();
   await home(db,environment,101);
   assert.match(texts(calls).at(-1),/💰 رصيدك: \$—/);
   assert.doesNotMatch(texts(calls).at(-1),/IQD/);
   assert.match(renderHomeTemplate('{name} {unknown} {users}',{name:'user',users:'3'}),/user \{unknown\} 3/);
 })}finally{conn.close()}
});
