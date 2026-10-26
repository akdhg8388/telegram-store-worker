import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleAdminText,handleAdminCallback,adminRoute} from '../src/admin-controls.js';
import {getSetting} from '../src/settings.js';
import {home,productView} from '../src/ui.js';
import {beginPurchase,commitPurchase,showReceipt} from '../src/wallet-purchase.js';
import {warrantyLine} from '../src/warranty.js';
import {homeSettingKey} from '../src/home-buttons.js';
const env={TELEGRAM_BOT_TOKEN:'MOCK',ADMIN_ID:'991',STORE_NAME:'My Store'};
function setup(){
  const conn=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^00\d\d_.*\.sql$/.test(x)).sort())
    conn.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  conn.exec("INSERT INTO users(tg_id,first_name,language,wallet_balance_iqd) VALUES (991,'Owner','ar',0),(101,'Buyer','ar',15000),(102,'English','en',3000)");
  conn.exec("INSERT INTO products(category_id,title,title_en,price_stars,price_iqd,stock,active,fulfillment_mode,delivery_shared_text) VALUES (1,'خدمة تجريبية','Test Service',1,1000,10,1,'shared','TEST-CODE')");
  const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];const o={bind(...a){args=a;return o},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};return o},async batch(items){return Promise.all(items.map(x=>x.run()))}};
  return {conn,db};
}
async function mock(callback,refuseIcons=false){
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=url.split('/').at(-1),body=JSON.parse(init.body);
    calls.push({method,body});
    if(refuseIcons && body.reply_markup?.inline_keyboard?.flat().some(b=>b.icon_custom_emoji_id))
      return new Response(JSON.stringify({ok:false,description:'Bad Request: icon_custom_emoji_id is not allowed'}),{status:400});
    return new Response(JSON.stringify({ok:true,result:{message_id:100+calls.length}}),{status:200});
  };
  try{await callback(calls)}finally{globalThis.fetch=original}
}
const homeBtn=(call,id)=>call.body.reply_markup?.inline_keyboard?.flat().find(b=>b.callback_data===id);
const emoji='💳',emojiId='5400000000000000077';

test('V15 migration defaults to hidden warranty and does not alter stored legacy amounts',()=>{
  const {conn}=setup();try{
    assert.equal(conn.prepare('SELECT warranty_visible,warranty_available FROM products WHERE id=1').get().warranty_visible,0);
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,15000);
    assert.equal(warrantyLine(conn.prepare('SELECT * FROM products WHERE id=1').get()),'');
  }finally{conn.close()}
});

test('custom emoji pasted at beginning OR end of an Arabic button name is saved with real ID and no duplicate glyph',async()=>{
  const {conn,db}=setup();try{await mock(async calls=>{
    for(const title of [`${emoji}متجر`,`متجر ${emoji}`]){
      const offset=title.indexOf(emoji);
      await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:homeSettingKey('shop','label_ar')}},
        {text:title,entities:[{type:'custom_emoji',offset,length:emoji.length,custom_emoji_id:emojiId}]});
      assert.equal(await getSetting(db,homeSettingKey('shop','label_ar')),title);
      assert.equal(await getSetting(db,homeSettingKey('shop','icon')),emojiId);
      assert.equal(await getSetting(db,homeSettingKey('shop','inline_ar')),emoji);
      await home(db,env,991);
      const button=homeBtn(calls.at(-1),'categories');
      assert.equal(button.text,'متجر'); // Telegram shows the custom icon before the text.
      assert.equal(button.icon_custom_emoji_id,emojiId);
      assert.equal(button._emoji_fallback_text,undefined); // Internal data never goes over API.
    }
  })}finally{conn.close()}
});

test('button-icon rejection restores emoji on the requested side, keeping the callback functional',async()=>{
  const {conn,db}=setup();try{await mock(async calls=>{
    const title=`متجر ${emoji}`;
    await handleAdminText(db,env,991,{action:'owner_setting',payload:{key:homeSettingKey('shop','label_ar')}},
      {text:title,entities:[{type:'custom_emoji',offset:title.indexOf(emoji),length:emoji.length,custom_emoji_id:emojiId}]});
    calls.length=0;
    await home(db,env,991);
    assert.equal(homeBtn(calls[0],'categories').icon_custom_emoji_id,emojiId);
    assert.equal(homeBtn(calls[1],'categories').text,title);
    assert.equal(homeBtn(calls[1],'categories').icon_custom_emoji_id,undefined);
    assert.equal(homeBtn(calls[1],'categories').callback_data,'categories');
  },true)}finally{conn.close()}
});

test('manual plain-text rename clears old inline marker but keeps separately configured button icon',async()=>{
  const {conn,db}=setup();try{await mock(async()=>{
    const key=homeSettingKey('shop','label_ar');
    await handleAdminText(db,env,991,{action:'owner_setting',payload:{key}},
      {text:`${emoji} متجر`,entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:emojiId}]});
    await handleAdminText(db,env,991,{action:'owner_setting',payload:{key}},{text:'مركز التسوق'});
    assert.equal(await getSetting(db,key),'مركز التسوق');
    assert.equal(await getSetting(db,homeSettingKey('shop','inline_ar')),'');
    assert.equal(await getSetting(db,homeSettingKey('shop','icon')),emojiId);
  })}finally{conn.close()}
});

test('admin can enable yes/no/hidden policy and edit bilingual notes; customer sees warranty before purchase',async()=>{
  const {conn,db}=setup();try{await mock(async calls=>{
    assert.equal(adminRoute('admin_product_warranty:1'),true);
    await handleAdminCallback(db,env,991,'admin_product_warranty_set:1:yes',24);
    await handleAdminText(db,env,991,{action:'owner_product_field',payload:{id:1,field:'warranty_terms_ar'}},{text:'ضمان 30 يوم'});
    await handleAdminText(db,env,991,{action:'owner_product_field',payload:{id:1,field:'warranty_terms_en'}},{text:'30-day warranty'});
    await productView(db,env,101,1);
    assert.match(calls.at(-1).body.text,/🛡️ الضمان: يوجد ضمان/);
    assert.match(calls.at(-1).body.text,/ضمان 30 يوم/);
    await beginPurchase(db,env,101,conn.prepare('SELECT * FROM products WHERE id=1').get(),()=> 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.match(calls.at(-1).body.text,/يوجد ضمان/);
    await productView(db,{...env,__locale:'en'},102,1);
    assert.match(calls.at(-1).body.text,/يوجد ضمان/);
    assert.match(calls.at(-1).body.text,/ضمان 30 يوم/);
    await beginPurchase(db,{...env,__locale:'en'},102,conn.prepare('SELECT * FROM products WHERE id=1').get(),()=> 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef');
    assert.match(calls.at(-1).body.text,/يوجد ضمان/);
    const record=await commitPurchase(db,env,101,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.ok(record.id);
    const sale=conn.prepare('SELECT * FROM wallet_purchases WHERE id=?').get(record.id);
    assert.equal(sale.warranty_visible,1);
    assert.equal(sale.warranty_available,1);
    assert.equal(sale.warranty_terms_ar,'ضمان 30 يوم');
    await handleAdminCallback(db,env,991,'admin_product_warranty_set:1:no',24);
    await productView(db,env,101,1);
    assert.match(calls.at(-1).body.text,/الضمان: لا يوجد ضمان/);
    assert.doesNotMatch(calls.at(-1).body.text,/ضمان 30 يوم/);
    await handleAdminCallback(db,env,991,'admin_product_warranty_set:1:hidden',24);
    await productView(db,env,101,1);
    assert.doesNotMatch(calls.at(-1).body.text,/🛡️ الضمان/);
    await showReceipt(db,env,101,record.id);
    assert.match(calls.at(-1).body.text,/ضمان 30 يوم/); // Purchased terms are immutable.
    assert.equal(conn.prepare('SELECT warranty_visible,warranty_available FROM wallet_purchases WHERE id=?').get(record.id).warranty_available,1);
  })}finally{conn.close()}
});

test('warranty cannot be toggled by a non-admin callback; English no-warranty is explicit',async()=>{
  const {conn,db}=setup();try{await mock(async calls=>{
    await handleAdminCallback(db,env,101,'admin_product_warranty_set:1:yes',12);
    assert.equal(conn.prepare('SELECT warranty_visible FROM products WHERE id=1').get().warranty_visible,0);
    await handleAdminCallback(db,env,991,'admin_product_warranty_set:1:no',12);
    await beginPurchase(db,{...env,__locale:'en'},102,conn.prepare('SELECT * FROM products WHERE id=1').get());
    assert.match(calls.at(-1).body.text,/لا يوجد ضمان/);
    assert.match(calls.at(-1).body.text,/الضمان: لا يوجد ضمان/);
  })}finally{conn.close()}
});

test('static custom emoji is rejected as an animated icon, preserving previous home title',async()=>{
  const {conn,db}=setup();const old=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=url.split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});
    return new Response(JSON.stringify({ok:true,result:method==='getCustomEmojiStickers'?[{is_animated:false,is_video:false}]:{message_id:999}}),{status:200});
  };
  try{
    const key=homeSettingKey('shop','label_ar');const title=`${emoji} متجر`;
    await handleAdminText(db,env,991,{action:'owner_setting',payload:{key}},
      {text:title,entities:[{type:'custom_emoji',offset:0,length:emoji.length,custom_emoji_id:emojiId}]});
    assert.equal(await getSetting(db,key),'');
    assert.equal(await getSetting(db,homeSettingKey('shop','icon')),'');
    assert.equal(calls.at(-1).method,'sendMessage');
    assert.match(calls.at(-1).body.text,/رمز تيليجرام ثابت/);
  }finally{globalThis.fetch=old;conn.close()}
});

test('English policy without English description stays fully English instead of leaking Arabic terms',()=>{
 assert.equal(warrantyLine({warranty_visible:1,warranty_available:1,warranty_terms_ar:'ضمان شهر',warranty_terms_en:''},'en'),'🛡️ Warranty: Warranty included');
});
