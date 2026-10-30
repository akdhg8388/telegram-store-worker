import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {adminRoute,handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {SETTING_FIELDS,validateSetting,getSetting,storeAcceptsOrders} from '../src/settings.js';
import {isAdmin} from '../src/common.js';
import {home} from '../src/ui.js';

function sqliteAdapter(){
 const connection=new DatabaseSync(':memory:');
 for(const file of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql','0011_product_visuals.sql','0012_product_warranty.sql','0023_wallet_bulk_discounts.sql'])
   connection.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
 const db={
   prepare(sql){
     let stmt=connection.prepare(sql),args=[];
     const wrapper={
       bind(...values){args=values;return wrapper},
       async first(){return stmt.get(...args)??null},
       async all(){return {results:stmt.all(...args)}},
       async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
     };
     return wrapper;
   }
 };
 return {db,connection};
}

function mockTelegram(run){
 const real=globalThis.fetch, calls=[];
 globalThis.fetch=async(url,init)=>{
   const method=String(url).split('/').at(-1);
   const body=JSON.parse(init.body);
   calls.push({method,body});
   return new Response(JSON.stringify({ok:true,result:{message_id:88}}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 return Promise.resolve().then(()=>run(calls)).finally(()=>globalThis.fetch=real);
}

const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST_TOKEN',STORE_NAME:'متجر الاختبار'};

test('only one private owner ID; other IDs, including old ADMIN_IDS, are ignored',()=>{
 assert.equal(isAdmin(env,991),true);
 assert.equal(isAdmin(env,992),false);
 assert.equal(isAdmin({ADMIN_IDS:'991,992'},991),false);
 assert.equal(isAdmin({ADMIN_ID:'991,992'},991),false);
});

test('admin callbacks allow curated commands, not arbitrary SQL field names',()=>{
 assert.equal(adminRoute('admin_stats'),true);
 assert.equal(adminRoute('admin_product_field:1:price_stars'),true);
 assert.equal(adminRoute('admin_product_move:1:2'),true);
 assert.equal(adminRoute('admin_category_field:4:emoji'),true);
 assert.equal(adminRoute('admin_products:0'),true);
 assert.equal(adminRoute('admin_setting:terms_text'),true);
 assert.equal(adminRoute('admin_product_field:1:price_stars;DROP TABLE users'),false);
 assert.equal(adminRoute('admin_secret_token'),false);
});

test('settings whitelist validates optional fields, URLs and limits',()=>{
 assert.ok(Object.keys(SETTING_FIELDS).length>10);
 assert.equal(validateSetting('admin_id','1234').ok,false);
 assert.equal(validateSetting('webhook_secret','x').ok,false);
 assert.equal(validateSetting('news_url','http://example.com').ok,false);
 assert.equal(validateSetting('news_url','https://example.com/x').ok,true);
 assert.equal(validateSetting('store_enabled','false').ok,true);
 assert.equal(validateSetting('store_enabled','yes').ok,false);
 assert.equal(validateSetting('store_name','').ok,false);
});

test('D1 migration supports settings and product delivery instructions',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(992,'Client')").run();
 assert.equal(await getSetting(db,'store_name','Default'),'Default');
 assert.equal(await storeAcceptsOrders(db),true);
 await db.prepare("INSERT INTO bot_settings(key,value) VALUES('store_enabled','false')").run();
 assert.equal(await storeAcceptsOrders(db),false);
 const info=connection.prepare('PRAGMA table_info(products)').all();
 assert.ok(info.some(c=>c.name==='delivery_instructions'));
 assert.ok(connection.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='is_blocked'));
 connection.close();
});

test('unauthorized customer cannot change store settings or product state',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(992,'Client')").run();
 await mockTelegram(async(calls)=>{
   assert.equal(await handleAdminCallback(db,env,992,'admin_toggle_store'),true);
   assert.equal(await storeAcceptsOrders(db),true);
   assert.ok(calls.some(c=>c.body.chat_id===992&&c.body.text.includes('غير متاح')));
 });
 connection.close();
});

test('owner may edit instructions and pause new orders via inline buttons',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner')").run();
 await mockTelegram(async(calls)=>{
   assert.equal(await handleAdminCallback(db,env,991,'admin_setting_edit:welcome_text'),true);
   const session=connection.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=991').get();
   assert.equal(session.action,'owner_setting');
   assert.equal(await handleAdminText(db,env,991,{action:'owner_setting',payload:JSON.parse(session.payload)},{text:'أهلاً بكم في المتجر'}),true);
   assert.equal(await getSetting(db,'welcome_text'),'أهلاً بكم في المتجر');
   assert.equal(await handleAdminCallback(db,env,991,'admin_toggle_store'),true);
   assert.equal(await storeAcceptsOrders(db),false);
   assert.ok(calls.some(c=>c.body.text?.includes('تم حفظ الإعداد')));
 });
 connection.close();
});

test('shop home only renders private admin button to owner and edits menu in-place',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(992,'Client')").run();
 await mockTelegram(async(calls)=>{
   await home(db,env,991,12);
   await home(db,env,992,23);
   const [owner,user]=calls;
   assert.equal(owner.method,'editMessageText');
   assert.equal(user.method,'editMessageText');
   assert.equal(owner.body.message_id,12);
   const flattened=(call)=>call.body.reply_markup.inline_keyboard.flat().map(x=>x.callback_data);
   assert.ok(flattened(owner).includes('admin'));
   assert.ok(!flattened(user).includes('admin'));
 });
 connection.close();
});

test('owner can block account without blocking themselves',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(992,'Client')").run();
 await mockTelegram(async()=>{
   await handleAdminCallback(db,env,991,'admin_user_toggle:992');
   assert.equal(connection.prepare('SELECT is_blocked FROM users WHERE tg_id=992').get().is_blocked,1);
   await handleAdminCallback(db,env,991,'admin_user_toggle:991');
   assert.equal(connection.prepare('SELECT is_blocked FROM users WHERE tg_id=991').get().is_blocked,0);
 });
 connection.close();
});


test('admin settings and product views update the current inline message',async()=>{
 const {db,connection}=sqliteAdapter();
 connection.prepare("INSERT INTO users(tg_id,first_name) VALUES (991,'Owner')").run();
 connection.prepare("INSERT INTO products(category_id,title,price_stars) VALUES(1,'Demo',15)").run();
 await mockTelegram(async(calls)=>{
   assert.equal(await handleAdminCallback(db,env,991,'admin_settings:0',123),true);
   assert.equal(await handleAdminCallback(db,env,991,'admin_products:0',123),true);
   assert.equal(await handleAdminCallback(db,env,991,'admin_product:1',123),true);
   assert.equal(await handleAdminCallback(db,env,991,'admin_stats',123),true);
   assert.equal(calls.length,4);
   assert.ok(calls.every(c=>c.method==='editMessageText' && c.body.message_id===123));
 });
 connection.close();
});
