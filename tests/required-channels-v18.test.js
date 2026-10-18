import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {gateState,showGate,handleChannelAdminText} from '../src/required-channels.js';
import {wallet} from '../src/ui.js';
import {customerInbox,customerThread,handleCustomerSupportCallback} from '../src/support.js';
function fixture(){
 const conn=new DatabaseSync(':memory:');
 for(const file of ['0001_init','0002_admin_controls','0003_reliability','0004_reference_catalog','0005_persistent_navigation','0006_wallet_checkout','0007_support_moderation_topup','0008_custom_ui_customer_inbox_cleanup','0009_wallet_auto_delivery','0010_purchase_views_and_unique_codes','0011_product_visuals','0012_product_warranty','0013_required_channels'])
  conn.exec(readFileSync(new URL('../migrations/'+file+'.sql',import.meta.url),'utf8'));
 conn.exec("INSERT INTO users(tg_id,first_name,language) VALUES (991,'Admin','ar'),(101,'Client','ar')");
 const db={prepare(sql){let args=[];const stmt=conn.prepare(sql);const o={bind(...items){args=items;return o},async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){const v=stmt.run(...args);return {meta:{changes:v.changes,last_row_id:Number(v.lastInsertRowid)}}}};return o},async batch(items){return Promise.all(items.map(x=>x.run()))}};
 return {conn,db};
}
async function capture(fn,members={}){
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{
  const method=String(url).split('/').at(-1),body=JSON.parse(init.body);requests.push({method,body});
  if(method==='getChatMember')return new Response(JSON.stringify({ok:true,result:{status:members[body.chat_id]||'left'}}));
  if(method==='getChat')return new Response(JSON.stringify({ok:true,result:{type:'channel'}}));
  if(method==='getMe')return new Response(JSON.stringify({ok:true,result:{id:999}}));
  return new Response(JSON.stringify({ok:true,result:{message_id:100}}));
 };
 try{await fn(requests)}finally{globalThis.fetch=original;}
}
const env={TELEGRAM_BOT_TOKEN:'TEST',ADMIN_ID:'991'};
const save=(conn,key,value)=>conn.prepare('INSERT INTO bot_settings(key,value) VALUES(?,?)').run(key,value);
test('mandatory channel gate defaults off and enforces every active channel when on',async()=>{
 const {conn,db}=fixture();try{
  conn.prepare("INSERT INTO required_channels(chat_id,title_ar,title_en,join_url) VALUES ('@Achannel','قناة أ','Channel A','https://t.me/Achannel'),('@Bchannel','قناة ب','Channel B','https://t.me/Bchannel')").run();
  await capture(async()=>{
   assert.equal((await gateState(db,env,101)).allowed,true);
   save(conn,'required_channels_enabled','true');
   assert.equal((await gateState(db,env,991)).allowed,true);
   const missing=await gateState(db,env,101);assert.equal(missing.missing.length,2);
   const partial=await gateState(db,env,101);assert.equal(partial.allowed,false);
  });
  await capture(async req=>{
   const gate=await gateState(db,env,101);
   assert.equal(gate.missing.length,1);
   await showGate(db,{...env,__locale:'en'},101,gate);
   const msg=req.at(-1).body;
   assert.match(msg.text,/Required Subscription/);
   assert.equal(msg.reply_markup.inline_keyboard[0][0].text,'📢 Channel B');
   assert.equal(msg.reply_markup.inline_keyboard[0][0].url,'https://t.me/Bchannel');
   assert.equal(msg.reply_markup.inline_keyboard.at(-1)[0].callback_data,'required_verify');
  },{'@Achannel':'member'});
  await capture(async()=>assert.equal((await gateState(db,env,101)).allowed,true),{'@Achannel':'member','@Bchannel':'administrator'});
 }finally{conn.close();}
});
test('customer Messages has no new-message action and reply requires previous conversation',async()=>{
 const {conn,db}=fixture();try{await capture(async requests=>{
  await customerInbox(db,env,101);
  let buttons=requests.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(!buttons.some(x=>x.callback_data==='my_support_new'));
  await handleCustomerSupportCallback(db,env,101,'my_support_new');
  assert.ok(!conn.prepare("SELECT * FROM user_sessions WHERE user_tg_id=101").get());
  conn.prepare("INSERT INTO support_messages(user_tg_id,direction,kind,body) VALUES(101,'outgoing','text','Hello')").run();
  await customerThread(db,env,101);
  buttons=requests.at(-1).body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(x=>x.callback_data==='my_support_reply'));
 });}finally{conn.close();}
});
test('wallet labels are bold and values remain normal in both languages',async()=>{
 const {conn,db}=fixture();try{await capture(async requests=>{
  await wallet(db,env,101);
  let x=requests.at(-1).body;
  assert.equal(x.entities.filter(e=>e.type==='bold').length,3);
  assert.ok(x.text.includes('بعد مراجعة الإدارة'));
  await wallet(db,{...env,__locale:'en'},101);
  x=requests.at(-1).body;
  assert.ok(x.text.includes('Your balance:'));
  assert.ok(x.text.includes('Approved rate:')||x.text.includes('exchange rate'));
  assert.ok(x.entities.some(e=>x.text.slice(e.offset,e.offset+e.length)==='💰 Your balance:'));
 });}finally{conn.close();}
});
