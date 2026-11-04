import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {ensureUser,getUser,setSession,getSession} from '../src/database.js';
import {currencyMenu} from '../src/ui.js';
import {thread,handleSupportCallback} from '../src/support.js';
import {maintenanceAdminCallback,maintenanceAdminText} from '../src/maintenance.js';
import {broadcastBody,queueBroadcast,stageBroadcasts,broadcastAdminText,broadcastAdminCallback} from '../src/broadcasts.js';
import {processUpdate} from '../src/bot.js';

function setup(){
 const c=new DatabaseSync(':memory:');
 const files=readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort();
 for(const file of files)c.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const db={prepare(sql){const stmt=c.prepare(sql);let args=[];const q={
   bind(...items){args=items;return q},async first(){return stmt.get(...args)??null},
   async all(){return {results:stmt.all(...args)}},async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
 };return q},async batch(items){c.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());c.exec('COMMIT');return out}catch(error){c.exec('ROLLBACK');throw error}}};
 return {c,db};
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',STORE_NAME:'My Store'};
async function mock(callback){
 const old=globalThis.fetch,calls=[];let msg=700;
 globalThis.fetch=async(url,options)=>{
   const method=String(url).split('/').at(-1),payload=JSON.parse(options.body);
   calls.push({method,payload});
   return new Response(JSON.stringify({ok:true,result:{message_id:method.startsWith('editMessage')?payload.message_id:++msg}}),{status:200});
 };
 try{return await callback(calls)}finally{globalThis.fetch=old}
}
test('new users start in USD; existing explicit IQD choices survive profile synchronization',async()=>{
 const {c,db}=setup();
 try{await mock(async calls=>{
   await ensureUser(db,{id:101,first_name:'Buyer'});
   assert.equal((await getUser(db,101)).currency_preference,'USD');
   await currencyMenu(db,env,101);
   assert.match(calls.at(-1).payload.text,/العملة المحددة: 🇺🇸/);
   assert.equal(calls.at(-1).payload.reply_markup.inline_keyboard[0][0].style,'success');
   c.prepare("UPDATE users SET currency_preference='IQD' WHERE tg_id=101").run();
   await ensureUser(db,{id:101,first_name:'New Name'});
   assert.equal((await getUser(db,101)).currency_preference,'IQD');
   await currencyMenu(db,env,101);
   assert.match(calls.at(-1).payload.text,/العملة المحددة: 🇮🇶/);
   assert.equal(calls.at(-1).payload.reply_markup.inline_keyboard[1][0].style,'success');
 });}finally{c.close()}
});
test('complete long support messages are readable by owner only and preserve UTF-16 emojis',async()=>{
 const {c,db}=setup();try{await mock(async calls=>{
   c.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Buyer'),(991,'Owner')").run();
   const body='شرح طويل 💚✅ '+('جملة عربية مفصّلة.\n'.repeat(125));
   assert.ok(body.length>1000&&body.length<3000);
   c.prepare("INSERT INTO support_messages(user_tg_id,direction,kind,body,is_unread) VALUES(101,'incoming','text',?,1)").run(body);
   await thread(db,env,991,101,55);
   assert.ok(calls.at(-1).payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='support_full:1'));
   await handleSupportCallback(db,env,991,'support_full:1',55);
   assert.ok(calls.at(-1).payload.text.endsWith(body));
   const before=calls.length;
   assert.equal(await handleSupportCallback(db,env,101,'support_full:1',55),true);
   assert.ok(!calls.slice(before).some(x=>String(x.payload.text||'').includes(body)));
 });}finally{c.close()}
});
test('Home cleans both products list and photo detail, never touching incoming messages',async()=>{
 const {c,db}=setup();try{await mock(async calls=>{
   await ensureUser(db,{id:101,first_name:'Buyer'});
   c.prepare("INSERT INTO products(category_id,title,price_stars,price_iqd,stock,fulfillment_mode,delivery_shared_text,photo_file_id) VALUES(1,'Demo',1,1520,3,'shared','CODE','PHOTO')").run();
   const click=async(updateId,data,mid,photo=false)=>{
     const tasks=[];
     await processUpdate(db,env,{waitUntil(p){tasks.push(p)}},{update_id:updateId,callback_query:{
       id:'cb'+updateId,from:{id:101,first_name:'Buyer'},message:{
         message_id:mid,chat:{id:101,type:'private'},...(photo?{photo:[{file_id:'PHOTO'}]}:{})},data}});
     await Promise.all(tasks);
   };
   await click(10101,'products:0',601);
   await click(10102,'product:1',601);
   const ids=c.prepare('SELECT message_id FROM purchase_view_messages WHERE user_tg_id=101').all().map(x=>x.message_id);
   assert.ok(ids.includes(601),'previous product list should be tracked');
   assert.ok(ids.length>=2,'details and list are both tracked');
   const detail=ids.find(id=>id!==601);
   await click(10103,'home',detail,true);
   const deletes=calls.filter(x=>x.method==='deleteMessage').map(x=>x.payload.message_id);
   assert.ok(deletes.includes(601),'old product list must be deleted');
   assert.ok(deletes.includes(detail),'product photo must be deleted');
   assert.equal(c.prepare('SELECT COUNT(*) AS n FROM purchase_view_messages WHERE user_tg_id=101').get().n,0);
   assert.ok(!deletes.includes(999),'customer messages must not be removed');
 });}finally{c.close()}
});
test('broadcast needs explicit confirmation, sends bold emoji in bounded idempotent background batches',async()=>{
 const {c,db}=setup();try{await mock(async calls=>{
   c.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'A'),(102,'B'),(991,'Owner')").run();
   for(let id=200;id<240;id++)c.prepare('INSERT INTO users(tg_id,first_name) VALUES(?,?)').run(id,'Client');
   await broadcastAdminCallback(db,env,991,'broadcast_compose');
   await broadcastAdminText(db,env,991,{action:'owner_broadcast_compose'},{text:'📢 **رسالة** 💙'});
   assert.equal(c.prepare('SELECT COUNT(*) n FROM maintenance_broadcast_jobs').get().n,0);
   await broadcastAdminCallback(db,env,991,'broadcast_confirm',700);
   const one=c.prepare('SELECT * FROM maintenance_broadcast_jobs').get();
   assert.ok(one&&one.kind==='manual');
   assert.equal(await stageBroadcasts(db),20);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE broadcast_job_id=?').get(one.id).n,20);
   assert.equal(await stageBroadcasts(db),20);
   await stageBroadcasts(db);
   await stageBroadcasts(db);
   const rows=c.prepare('SELECT payload FROM notification_outbox WHERE broadcast_job_id=?').all(one.id);
   assert.equal(rows.length,43);
   assert.equal(new Set(rows.map(r=>JSON.parse(r.payload).chat_id)).size,43);
   assert.ok(rows.every(r=>{
     const p=JSON.parse(r.payload);
     return p.text==='📢 **رسالة** 💙' && p.entities[0].type==='bold' &&
       p.entities[0].length===p.text.length && p._preserve_text===true;
   }));
   assert.equal(c.prepare('SELECT status FROM maintenance_broadcast_jobs WHERE id=?').get(one.id).status,'completed');
 });}finally{c.close()}
});
test('global maintenance stays enabled while composing; disabling queues the saved reopening text',async()=>{
 const {c,db}=setup();try{await mock(async()=>{
   c.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(101,'Buyer')").run();
   await maintenanceAdminCallback(db,env,991,'maintenance_toggle:global',90);
   assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='maintenance_enabled'").get().value,'true');
   await maintenanceAdminCallback(db,env,991,'maintenance_resume_edit');
   const session=await getSession(db,991);
   assert.equal(session.action,'owner_maintenance_resume_text');
   await maintenanceAdminText(db,env,991,session,{text:'✅ عدنا للعمل! 💚'});
   assert.equal(c.prepare('SELECT COUNT(*) n FROM maintenance_broadcast_jobs').get().n,0);
   await maintenanceAdminCallback(db,env,991,'maintenance_toggle:global',90);
   assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='maintenance_enabled'").get().value,'false');
   const job=c.prepare('SELECT kind,body FROM maintenance_broadcast_jobs').get();
   assert.equal(job.kind,'resume');
   assert.equal(job.body,'✅ عدنا للعمل! 💚');
   await stageBroadcasts(db);
   assert.ok(c.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE broadcast_job_id IS NOT NULL').get().n>=2);
 });}finally{c.close()}
});
