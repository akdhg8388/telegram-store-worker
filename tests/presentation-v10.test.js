import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home} from '../src/ui.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {DEFAULT_HOME_TEMPLATE,renderHomeTemplate,preserveCustomEmojiInTemplate,homeTextAndEntities} from '../src/presentation.js';
import {sendText,sendOrEditText} from '../src/telegram.js';

function fixture(){
 const conn=new DatabaseSync(':memory:');
 for(let i=1;i<=8;i++)conn.exec(readFileSync(new URL(`../migrations/000${i}_${['init','admin_controls','reliability','reference_catalog','persistent_navigation','wallet_checkout','support_moderation_topup','custom_ui_customer_inbox_cleanup'][i-1]}.sql`,import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES (101,'مهند','IQD'),(102,'Second','USD'),(991,'Owner','IQD')").run();
 conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520')").run();
 conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (101,912000,'topup','deposit-101'),(102,912000,'topup','deposit-102')").run();
 const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];const q={bind(...values){args=values;return q},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const x=stmt.run(...args);return {meta:{changes:Number(x.changes),last_row_id:Number(x.lastInsertRowid)}}}};return q;},async batch(stmts){conn.exec('BEGIN');try{let result=[];for(const s of stmts)result.push(await s.run());conn.exec('COMMIT');return result}catch(e){conn.exec('ROLLBACK');throw e}}};
 return {conn,db};
}
async function capture(fn){const prev=globalThis.fetch,calls=[];globalThis.fetch=async(url,opts)=>{const method=String(url).split('/').at(-1),body=JSON.parse(opts.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:910}}),{status:200})};try{return await fn(calls)}finally{globalThis.fetch=prev}}
const env={TELEGRAM_BOT_TOKEN:'TEST_ONLY',ADMIN_ID:'991',STORE_NAME:'My Store'};
const lastText=calls=>calls.filter(x=>['sendMessage','editMessageText'].includes(x.method)).at(-1)?.body;

test('single preferred IQD or USD currency, real balances, and bold headings',async()=>{
 const {db,conn}=fixture();try{await capture(async calls=>{
   await home(db,env,101);let x=lastText(calls);
   assert.match(x.text,/💰 رصيدك: IQD 912,000/);
   assert.doesNotMatch(x.text,/USD|\$600/);
   for(const label of ['رصيدك:','الاسم:','المعرّف:','المستخدمون:']){
     assert.ok(x.entities.some(e=>e.type==='bold'&&x.text.slice(e.offset,e.offset+e.length)===label),label);
   }
   assert.match(x.text,/👥 المستخدمون: 3/);
   await home(db,env,102);x=lastText(calls);
   assert.match(x.text,/💰 رصيدك: \$600\.00/);
   assert.doesNotMatch(x.text,/IQD|912,000/);
 })}finally{conn.close()}
});

test('admin reset requires confirmation and restores exact default without touching money or emoji setting',async()=>{
 const {db,conn}=fixture();try{await capture(async calls=>{
   conn.prepare("INSERT INTO bot_settings(key,value) VALUES('home_template','نص مخصص'),('home_custom_emoji_id','5368324170671202289')").run();
   assert.equal(await handleAdminCallback(db,env,101,'admin_visual_reset_confirm'),true);
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_template'").get().value,'نص مخصص');
   assert.equal(await handleAdminCallback(db,env,991,'admin_visual_reset'),true);
   assert.match(lastText(calls).text,/هل تؤكد الاستعادة/);
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_template'").get().value,'نص مخصص');
   assert.equal(await handleAdminCallback(db,env,991,'admin_visual_reset_confirm'),true);
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_template'").get().value,DEFAULT_HOME_TEMPLATE);
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_custom_emoji_id'").get().value,'5368324170671202289');
   assert.equal(conn.prepare("SELECT wallet_balance_iqd FROM users WHERE tg_id=101").get().wallet_balance_iqd,912000);
   assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n,2);
   assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM admin_actions WHERE action='reset_home_template'").get().n,1);
 })}finally{conn.close()}
});

test('owner-edited inline Telegram animated emoji survives changing customer names and bold labels',async()=>{
 const {db,conn}=fixture();try{await capture(async calls=>{
   await handleAdminCallback(db,env,991,'admin_setting_edit:home_template');
   let session=conn.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=991').get();
   const str='👋 أهلاً بك في {store}!\n💰 رصيدك: {balance}\n✨ الاسم: {name}';
   const offset=str.indexOf('✨');
   await handleAdminText(db,env,991,{action:session.action,payload:JSON.parse(session.payload)},
     {text:str,entities:[{type:'custom_emoji',custom_emoji_id:'5368324170671202289',offset,length:1}]});
   const stored=conn.prepare("SELECT value FROM bot_settings WHERE key='home_template'").get().value;
   assert.match(stored,/\[\[emoji:5368324170671202289\|✨\]\]/);
   await home(db,env,101);
   let x=lastText(calls);
   assert.doesNotMatch(x.text,/\[\[emoji/);
   const custom=x.entities.find(e=>e.type==='custom_emoji');
   assert.equal(x.text.slice(custom.offset,custom.offset+custom.length),'✨');
   assert.ok(x.entities.some(e=>e.type==='bold' && x.text.slice(e.offset,e.offset+e.length)==='رصيدك:'));
 })}finally{conn.close()}
});

test('Telegram entity errors retry without animated emoji while retaining bold formatting',async()=>{
 const prev=globalThis.fetch,seen=[];globalThis.fetch=async(url,opts)=>{
   const body=JSON.parse(opts.body);seen.push(body);
   if(seen.length===1)return new Response(JSON.stringify({ok:false,description:"Bad Request: can't parse entities: custom emoji not allowed"}),{status:400});
   return new Response(JSON.stringify({ok:true,result:{message_id:7}}),{status:200});
 };
 try{
   await sendText(env,101,'👋 رصيدك:',null,{entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5368324170671202289'},{type:'bold',offset:3,length:6}]});
   assert.equal(seen.length,2);
   assert.equal(seen[1].entities.length,1);
   assert.equal(seen[1].entities[0].type,'bold');
 }finally{globalThis.fetch=prev}
});

test('V9 legacy home balance line renders one preferred currency after upgrade',()=>{
 const old='👋 أهلاً بك في {store}!\n💰 رصيدك: IQD {balance_iqd} (≡ \${balance_usd} USD)';
 const text=renderHomeTemplate(old,{store:'My Store',balance:'$25.00',balance_iqd:'38,000',balance_usd:'25.00'});
 assert.equal(text,'👋 أهلاً بك في My Store!\n💰 رصيدك: $25.00');
});

test('reset confirmation callback does not operate without a current owner confirmation',async()=>{
 const {db,conn}=fixture();try{await capture(async calls=>{
   conn.prepare("INSERT INTO bot_settings(key,value) VALUES('home_template','خاص')").run();
   await handleAdminCallback(db,env,991,'admin_visual_reset_confirm');
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_template'").get().value,'خاص');
   assert.match(lastText(calls).text,/انتهى طلب الاستعادة/);
 })}finally{conn.close()}
});
