import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home,supportMenu} from '../src/ui.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {getSetting,validateSetting} from '../src/settings.js';
import {ensureUser} from '../src/database.js';
import {updateBotProfilePicture} from '../src/bot-profile.js';

const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_TOKEN',STORE_NAME:'My Store'};
const migrations=['0001_init','0002_admin_controls','0003_reliability','0004_reference_catalog','0005_persistent_navigation','0006_wallet_checkout','0007_support_moderation_topup','0008_custom_ui_customer_inbox_cleanup','0009_wallet_auto_delivery','0010_purchase_views_and_unique_codes','0011_product_visuals','0012_product_warranty'];
function fixture(){
 const conn=new DatabaseSync(':memory:');
 for(const name of migrations)conn.exec(readFileSync(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(101,'Customer')").run();
 const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];const q={bind(...v){args=v;return q},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const x=stmt.run(...args);return {meta:{changes:x.changes,last_row_id:Number(x.lastInsertRowid)}}}};return q;}};
 return {db,conn};
}
async function withTelegram(fn,{fail=null}={}){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
   const method=String(url).split('/').at(-1),body=typeof init.body==='string'?JSON.parse(init.body):init.body;
   calls.push({method,body});
   if(fail===method)return new Response(JSON.stringify({ok:false,description:'Refused'}),{status:400});
   return new Response(JSON.stringify({ok:true,result:{message_id:101}}),{status:200});
 };
 try{await fn(calls)}finally{globalThis.fetch=old}
}
const lastUI=calls=>calls.filter(c=>['sendMessage','editMessageText'].includes(c.method)).at(-1)?.body;

test('owner-only intro and editable real Telegram bot description/name; limits are validated',async()=>{
 const {db,conn}=fixture();
 try{await withTelegram(async calls=>{
   assert.equal(await handleAdminCallback(db,env,101,'admin_bot_intro'),true);
   assert.match(lastUI(calls).text,/غير متاح/);
   await handleAdminCallback(db,env,991,'admin_bot_intro');
   assert.match(lastUI(calls).text,/صورة وصف البداية الكبيرة/);
   await handleAdminCallback(db,env,991,'admin_setting_edit:bot_public_description');
   await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:'bot_public_description'}},{text:'متجر رقمي احترافي'});
   assert.ok(calls.some(c=>c.method==='setMyDescription'&&c.body.description==='متجر رقمي احترافي'));
   assert.equal(await getSetting(db,'bot_public_description'),'متجر رقمي احترافي');
   await handleAdminCallback(db,env,991,'admin_setting_edit:bot_public_name');
   await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:'bot_public_name'}},{text:'My Store'});
   assert.ok(calls.some(c=>c.method==='setMyName'&&c.body.name==='My Store'));
   assert.equal(validateSetting('bot_public_description','a'.repeat(513)).ok,false);
   assert.equal(validateSetting('bot_public_short_description','a'.repeat(121)).ok,false);
 })}finally{conn.close()}
});

test('Telegram refusal does not save altered description',async()=>{
 const {db,conn}=fixture();try{await withTelegram(async calls=>{
   await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:'bot_public_description'}},{text:'New value'});
   assert.equal(await getSetting(db,'bot_public_description',''),'');
   assert.match(lastUI(calls).text,/تعذّر تحديث/);
 },{fail:'setMyDescription'})}finally{conn.close()}
});

test('support customer sees both options only after owner enables and configures valid Telegram username',async()=>{
 const {db,conn}=fixture();try{await withTelegram(async calls=>{
   await supportMenu(db,env,101);let rows=lastUI(calls).reply_markup.inline_keyboard;
   assert.ok(rows.flat().some(b=>b.callback_data==='support_compose'));
   assert.ok(!rows.flat().some(b=>b.url));
   assert.equal(validateSetting('support_direct_username','https://t.me/owner').ok,false);
   assert.equal(validateSetting('support_direct_username','@OwnerName').ok,true);
   await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:'support_direct_username'}},{text:'@OwnerName'});
   await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:'support_direct_label'}},{text:'💬 دردشة المسؤول'});
   await handleAdminCallback(db,env,991,'admin_toggle_support_direct');
   await supportMenu(db,env,101);
   rows=lastUI(calls).reply_markup.inline_keyboard;
   assert.deepEqual(rows.flat().filter(b=>b.url).map(b=>[b.text,b.url]),[['💬 دردشة المسؤول','https://t.me/OwnerName']]);
   await handleAdminCallback(db,env,991,'admin_toggle_support_direct');
   await supportMenu(db,env,101);
   assert.ok(!lastUI(calls).reply_markup.inline_keyboard.flat().some(b=>b.url));
 })}finally{conn.close()}
});

test('display total increases exactly once per new unique user and reset restores actual count',async()=>{
 const {db,conn}=fixture();try{await withTelegram(async calls=>{
   await handleAdminCallback(db,env,101,'admin_counter_edit');
   assert.match(lastUI(calls).text,/غير متاح/);
   await handleAdminCallback(db,env,991,'admin_counter_edit');
   await handleAdminText(db,env,991,{action:'owner_users_display_count',payload:{}},{text:'1000'});
   await home(db,env,101);
   assert.match(lastUI(calls).text,/المستخدمون: 1,000/);
   await ensureUser(db,{id:111,first_name:'New'});
   await ensureUser(db,{id:111,first_name:'Updated'});
   await home(db,env,111);
   assert.match(lastUI(calls).text,/المستخدمون: 1,001/);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM users').get().n,3);
   await handleAdminCallback(db,env,991,'admin_counter_reset');
   await home(db,env,101);
   assert.match(lastUI(calls).text,/المستخدمون: 3/);
   assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
 })}finally{conn.close()}
});

test('photo uploader uses multipart, verifies jpeg and avoids changing storage on failure',async()=>{
 let calls=[];
 const jpeg=new Uint8Array([255,216,1,2,255,217]);
 const fakeCall=async(_env,method)=>{assert.equal(method,'getFile');return {file_path:'photos/avatar.jpg',file_size:jpeg.byteLength}};
 const fakeFetch=async(url,options)=>{
   calls.push({url,options});
   if(url.includes('/file/bot'))return new Response(jpeg,{status:200});
   assert.equal(options.method,'POST');
   assert.equal(options.body.get('photo'),JSON.stringify({type:'static',photo:'attach://avatar'}));
   assert.equal(options.body.get('avatar').name,'avatar.jpg');
   return Response.json({ok:true,result:true});
 };
 assert.equal(await updateBotProfilePicture(env,'VALID_JPEG_FILE',{telegramCall:fakeCall,request:fakeFetch}),true);
 assert.equal(calls.length,2);
 await assert.rejects(updateBotProfilePicture(env,'VALID_JPEG_FILE',{telegramCall:fakeCall,request:async()=>new Response('bad',{status:404})}),/Unable to download/);
});
