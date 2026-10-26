import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {maintenanceStatus,maintenanceActionId,maintenanceCommandId,sendMaintenanceNotice,maintenanceAdminCallback,maintenanceAdminText} from '../src/maintenance.js';
import {home} from '../src/ui.js';
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE'};
function fixture(){
 const c=new DatabaseSync(':memory:');
 const names=['init','admin_controls','reliability','reference_catalog','persistent_navigation','wallet_checkout','support_moderation_topup','custom_ui_customer_inbox_cleanup','wallet_auto_delivery','purchase_views_and_unique_codes','product_visuals','product_warranty','required_channels','referral_rewards','topup_chat_cleanup'];
 for(let i=0;i<names.length;i++)c.exec(readFileSync(new URL('../migrations/'+String(i+1).padStart(4,'0')+'_'+names[i]+'.sql',import.meta.url),'utf8'));
 c.exec("INSERT INTO users(tg_id,first_name) VALUES (991,'Owner'),(101,'Customer')");
 const db={prepare(sql){const stmt=c.prepare(sql);let args=[];const q={bind(...x){args=x;return q},async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){const x=stmt.run(...args);return {meta:{changes:x.changes,last_row_id:Number(x.lastInsertRowid)}}}};return q},async batch(xs){return Promise.all(xs.map(x=>x.run()))}};
 return {c,db};
}
async function capture(run){const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{const method=String(url).split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:77}}));};try{await run(calls)}finally{globalThis.fetch=old;}}
test('V24 granular maintenance defaults off and excludes checkout callbacks',async()=>{
 const {c,db}=fixture();try{
  assert.deepEqual(await maintenanceStatus(db,'wallet'),{global:false,button:false});
  assert.equal(maintenanceActionId('wallet'),'wallet');
  assert.equal(maintenanceActionId('buy:1'),null);
  assert.equal(maintenanceActionId('wallet_purchase_commit:10'),null);
  assert.equal(maintenanceCommandId('/wallet'),'wallet');
  assert.equal(maintenanceCommandId('/admin'),null);
  await c.prepare("INSERT INTO bot_settings(key,value) VALUES('maintenance_button_wallet_enabled','true')").run();
  assert.deepEqual(await maintenanceStatus(db,'wallet'),{global:false,button:true});
  assert.deepEqual(await maintenanceStatus(db,'shop'),{global:false,button:false});
 }finally{c.close();}
});
test('V24 owner can enable button maintenance and continue using home/admin',async()=>{
 const {c,db}=fixture();try{await capture(async calls=>{
  assert.equal(await maintenanceAdminCallback(db,env,991,'maintenance_toggle:wallet'),true);
  assert.equal((await maintenanceStatus(db,'wallet')).button,true);
  await home(db,env,991);
  assert.ok(calls.at(-1).body.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='wallet'));
  assert.equal(await maintenanceAdminCallback(db,env,101,'maintenance_toggle:wallet'),true);
  assert.equal((await maintenanceStatus(db,'wallet')).button,true);
  await maintenanceAdminCallback(db,env,991,'maintenance_toggle:wallet');
  assert.equal((await maintenanceStatus(db,'wallet')).button,false);
 });}finally{c.close();}
});
test('V24 bilingual bold maintenance message and animated sticker, fallback text',async()=>{
 const {c,db}=fixture();try{await capture(async calls=>{
  c.prepare("INSERT INTO bot_settings(key,value) VALUES('maintenance_button_wallet_en','Wallet temporarily unavailable'),('maintenance_button_wallet_sticker','ANIMATED_FILE_ID')").run();
  await sendMaintenanceNotice(db,{...env,__locale:'en'},101,'wallet');
  assert.deepEqual(calls.map(x=>x.method),['sendSticker','sendMessage']);
  assert.equal(calls[1].body.entities[0].type,'bold');
  assert.equal(calls[1].body.entities[0].length,calls[1].body.text.length);
  assert.match(calls[1].body.text,/الصيانة/);
  assert.ok(calls[1].body.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='home'));
 });}finally{c.close();}
});
test('V24 animated sticker setting and custom Arabic message save independently',async()=>{
 const {c,db}=fixture();try{await capture(async()=>{
  await maintenanceAdminText(db,env,991,{action:'owner_maintenance_sticker',payload:{scope:'shop'}},{sticker:{file_id:'FILE_ANIMATED',is_animated:true}});
  await maintenanceAdminText(db,env,991,{action:'owner_maintenance_text',payload:{scope:'shop',lang:'ar'}},{text:'المتجر يتحدث'});
  assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='maintenance_button_shop_sticker'").get().value,'FILE_ANIMATED');
  assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='maintenance_button_shop_ar'").get().value,'المتجر يتحدث');
 });}finally{c.close();}
});
test('V24 configured URL news becomes a callback while under button maintenance',async()=>{
 const {c,db}=fixture();try{await capture(async calls=>{
  c.prepare("INSERT INTO bot_settings(key,value) VALUES('news_url','https://t.me/MyStoreNewsIQ'),('maintenance_button_news_enabled','true')").run();
  await home(db,env,101);
  const news=calls.at(-1).body.reply_markup.inline_keyboard.flat().find(x=>x.callback_data==='news');
  assert.ok(news);
  assert.equal(news.url,undefined);
 });}finally{c.close();}
});
