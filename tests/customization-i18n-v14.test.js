import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {home,products,productView} from '../src/ui.js';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback,handleAdminText,adminRoute} from '../src/admin-controls.js';
import {sendText} from '../src/telegram.js';
import {languageOf,translateUi} from '../src/i18n.js';
import {homeSettingKey} from '../src/home-buttons.js';
import {CUSTOMER_COMMANDS_EN,OWNER_COMMANDS_EN} from '../src/commands.js';

function fixture(){
  const conn=new DatabaseSync(':memory:');
  for(const file of ['0001_init','0002_admin_controls','0003_reliability','0004_reference_catalog','0005_persistent_navigation','0006_wallet_checkout','0007_support_moderation_topup','0008_custom_ui_customer_inbox_cleanup','0009_wallet_auto_delivery','0010_purchase_views_and_unique_codes','0011_product_visuals','0012_product_warranty'])
    conn.exec(readFileSync(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
  conn.exec("INSERT INTO users(tg_id,first_name,language) VALUES (991,'Owner','ar'),(101,'John','en');");
  conn.exec("INSERT INTO products(category_id,title,title_en,description,description_en,usage_instructions,usage_instructions_en,price_stars,price_iqd,stock,active,fulfillment_mode,delivery_shared_text,custom_emoji_id) VALUES (1,'منتج', 'Premium Product','وصف عربي','English description','استخدم','Follow the setup guide',1,1000,3,1,'shared','TEST-SHARED','5400000000000000001')");
  let queries=[];
  const db={prepare(sql){queries.push(sql);const stmt=conn.prepare(sql);let args=[];const o={bind(...a){args=a;return o},async first(){return stmt.get(...args)??null},async all(){return {results:stmt.all(...args)}},async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};return o},async batch(items){return Promise.all(items.map(x=>x.run()))}};
  return {conn,db,queries};
}
async function mock(callback,errorIcon=false){
  const orig=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(init.body);
    calls.push({method,body});
    if(errorIcon && body.reply_markup?.inline_keyboard?.flat().some(x=>x.icon_custom_emoji_id))
      return new Response(JSON.stringify({ok:false,description:'Bad Request: icon_custom_emoji_id is not allowed'}),{status:400});
    return new Response(JSON.stringify({ok:true,result:{message_id:100+calls.length}}),{status:200});
  };
  try{await callback(calls)}finally{globalThis.fetch=orig}
}
const env={TELEGRAM_BOT_TOKEN:'TEST',ADMIN_ID:'991',STORE_NAME:'My Store',BOT_USERNAME:'MyStoreIQBot'};
const persist=(conn,key,value)=>conn.prepare('INSERT INTO bot_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
const flat=c=>c.body.reply_markup.inline_keyboard.flat();

test('V14 applies safely after V13, retaining old purchases and wallet balances',()=>{
  const x=fixture();
  try{
    assert.ok(x.conn.prepare('PRAGMA table_info(products)').all().some(r=>r.name==='custom_emoji_id'));
    assert.ok(x.conn.prepare('PRAGMA table_info(products)').all().some(r=>r.name==='description_en'));
    assert.equal(x.conn.prepare("SELECT title_en FROM categories WHERE slug='ai-tools'").get().title_en,'AI Tools');
    assert.equal(x.conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
  }finally{x.conn.close()}
});

test('owner can rename every action independently in Arabic and English and add an actual Telegram button icon',async()=>{
 const x=fixture();try{
  persist(x.conn,'orders_custom_emoji_id','5400000000000000002');
  persist(x.conn,homeSettingKey('orders','label_ar'),'📦 طلبياتي');
  persist(x.conn,homeSettingKey('orders','label_en'),'📦 My Purchases');
  await mock(async calls=>{
    await home(x.db,env,991);
    await home(x.db,{...env,__locale:'en'},101);
    const old=flat(calls[0]).find(b=>b.callback_data==='orders');
    const english=flat(calls[1]).find(b=>b.callback_data==='orders');
    assert.equal(old.text,'📦 طلبياتي');
    assert.equal(english.text,'📦 طلبياتي');
    assert.equal(english.icon_custom_emoji_id,'5400000000000000002');
    assert.equal(english.callback_data,'orders');
    assert.ok(!flat(calls[1]).some(b=>b.callback_data==='admin'));
    assert.ok(x.queries.filter(q=>q.includes('FROM bot_settings')).length<=2,'one settings query per Home');
  });
 }finally{x.conn.close()}
});

test('owner can reset one home button without resetting other customization, preserving its action',async()=>{
 const x=fixture();try{
  persist(x.conn,homeSettingKey('orders','label_ar'),'طلبات الزبائن');
  persist(x.conn,homeSettingKey('orders','label_en'),'Customer Orders');
  persist(x.conn,homeSettingKey('shop','label_ar'),'تسوق');
  await mock(async calls=>{
    assert.equal(adminRoute('admin_home_button_reset:orders'),true);
    await handleAdminCallback(x.db,env,991,'admin_home_button_reset:orders',12);
    assert.equal(x.conn.prepare('SELECT value FROM bot_settings WHERE key=?').get(homeSettingKey('orders','label_ar')).value,'');
    assert.equal(x.conn.prepare('SELECT value FROM bot_settings WHERE key=?').get(homeSettingKey('orders','label_en')).value,'');
    assert.equal(x.conn.prepare('SELECT value FROM bot_settings WHERE key=?').get(homeSettingKey('shop','label_ar')).value,'تسوق');
    await home(x.db,env,991);
    assert.equal(flat(calls.at(-1)).find(b=>b.callback_data==='orders').text,'📦 طلباتي');
  });
 }finally{x.conn.close()}
});

test('legacy language buttons cannot enable English and Home stays Arabic',async()=>{
 const x=fixture();try{await mock(async calls=>{
  await home(x.db,{...env,__locale:'en'},101);
  const homeButtons=flat(calls.at(-1));
  assert.equal(homeButtons.some(b=>b.callback_data==='language'),false);
  assert.ok(homeButtons.some(b=>b.callback_data==='my_support_inbox'));
  await processUpdate(x.db,env,{waitUntil(){}},{update_id:7501,callback_query:{id:'q7501',from:{id:101,first_name:'John'},message:{chat:{type:'private',id:101},message_id:50},data:'language_en'}});
  assert.equal(x.conn.prepare('SELECT language FROM users WHERE tg_id=101').get().language,'en'); // historical data unchanged
  await home(x.db,{...env,__locale:'en'},101);
  assert.match(calls.at(-1).body.text,/أهلاً بك/);
 })}finally{x.conn.close()}
});

test('product, price and stock emoji are included as separate valid Telegram entities; list has product icon',async()=>{
 const x=fixture();try{
  persist(x.conn,'price_custom_emoji_id','5400000000000000003');
  persist(x.conn,'stock_custom_emoji_id','5400000000000000004');
  persist(x.conn,'product_custom_emoji_id','5400000000000000005');
  await mock(async calls=>{
    await products(x.db,{...env,__locale:'en'},101);
    const productBtn=flat(calls[0]).find(b=>b.callback_data==='product:1');
    assert.equal(productBtn.icon_custom_emoji_id,'5400000000000000001');
    await productView(x.db,{...env,__locale:'en'},101,1);
    const detail=calls[1].body;
    assert.equal(detail.entities.filter(e=>e.type==='custom_emoji').length,3);
    assert.equal(detail.entities.filter(e=>e.type==='bold').length,4);
    for(const e of detail.entities.filter(e=>e.type==='custom_emoji')){
      assert.equal(e.type,'custom_emoji');
      assert.ok(/^\d{10,30}$/.test(e.custom_emoji_id));
      assert.ok(['🛍️','💰','📦'].includes(detail.text.slice(e.offset,e.offset+e.length)));
    }
  });
 }finally{x.conn.close()}
});

test('Telegram emoji icon permission error falls back to ordinary button without changing action',async()=>{
 await mock(async calls=>{
  await sendText({...env,__locale:'en'},101,'Ready',{inline_keyboard:[[{text:'Purchase',callback_data:'buy:1',icon_custom_emoji_id:'5400000000000000003',style:'success'}]]});
  assert.equal(calls.length,2);
  assert.ok(calls[0].body.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id);
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,undefined);
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data,'buy:1');
 },true);
});

test('Arabic store language is enforced independently of legacy locale',()=>{
 assert.equal(languageOf({__locale:'en'}),'ar');
 assert.equal(languageOf({__locale:'ar'}),'ar');
 assert.equal(translateUi('💰 السعر: 50,000 د.ع','ar'),'💰 السعر: 50,000 د.ع');
});

test('credentials and unique delivery data are not altered by the English locale translator',async()=>{
 const x=fixture();try{
  x.conn.prepare("UPDATE products SET delivery_shared_text='المخزون_123 السلام عليكم!!' WHERE id=1").run();
  x.conn.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,5000,'topup','v14-credit')").run();
  const {beginPurchase,commitPurchase,showReceipt}=await import('../src/wallet-purchase.js');
  const {getProduct}=await import('../src/database.js');
  await mock(async calls=>{
    const p=await getProduct(x.db,1);
    await beginPurchase(x.db,{...env,__locale:'en'},101,p,()=> 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const result=await commitPurchase(x.db,{...env,__locale:'en'},101,'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.ok(result?.id);
    await showReceipt(x.db,{...env,__locale:'en'},101,result.id);
    const receipt=calls.filter(c=>c.method==='sendMessage').at(-1).body.text;
    assert.ok(receipt.includes('المخزون_123 السلام عليكم!!'),'delivery data preserved byte for byte');
    assert.match(receipt,/تم الشراء والتسليم بنجاح/);
    assert.equal(x.conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,4000);
  });
 }finally{x.conn.close()}
});


test('V17 moves private messages into Home and can hide or restore any Home entry',async()=>{
 const x=fixture();try{await mock(async calls=>{
  await home(x.db,env,991);
  assert.equal(flat(calls.at(-1)).find(b=>b.callback_data==='my_support_inbox').style,'primary');
  assert.equal(adminRoute('admin_home_button_toggle:messages'),true);
  await handleAdminCallback(x.db,env,991,'admin_home_button_toggle:messages',18);
  await home(x.db,env,991);
  assert.ok(!flat(calls.at(-1)).some(b=>b.callback_data==='my_support_inbox'));
  await handleAdminCallback(x.db,env,991,'admin_home_button_toggle:messages',18);
  await home(x.db,env,991);
  assert.ok(flat(calls.at(-1)).some(b=>b.callback_data==='my_support_inbox'));
  await handleAdminCallback(x.db,env,991,'admin_home_button_toggle:shop',18);
  await home(x.db,env,991);
  assert.ok(!flat(calls.at(-1)).some(b=>b.callback_data==='categories'));
  await handleAdminCallback(x.db,env,991,'admin_home_button_reset:shop',18);
  await home(x.db,env,991);
  assert.ok(flat(calls.at(-1)).some(b=>b.callback_data==='categories'));
 })}finally{x.conn.close()}
});

test('messages description remains Arabic even with legacy English user preference',async()=>{
 const x=fixture();try{await mock(async calls=>{
  const key=homeSettingKey('messages','description_ar');
  await handleAdminCallback(x.db,env,991,'admin_setting_edit:'+key,19);
  await handleAdminText(x.db,env,991,{action:'owner_setting',payload:{key}},{text:'وصف رسائلي الخاص'});
  const {customerInbox}=await import('../src/support.js');
  await customerInbox(x.db,{...env,__locale:'en'},991);
  assert.match(calls.at(-1).body.text,/وصف رسائلي الخاص/);
 })}finally{x.conn.close()}
});

test('V17 maintenance stops customer messages and callbacks while owner keeps control',async()=>{
 const x=fixture();try{await mock(async calls=>{
  assert.ok(adminRoute('admin_maintenance'));
  await handleAdminCallback(x.db,env,991,'admin_maintenance_toggle',20);
  assert.equal(x.conn.prepare("SELECT value FROM bot_settings WHERE key='maintenance_enabled'").get().value,'true');
  let id=90000;const ctx={waitUntil:()=>{}};
  await processUpdate(x.db,env,ctx,{update_id:++id,message:{message_id:130,chat:{id:101,type:'private'},from:{id:101,first_name:'John'},text:'/start'}});
  assert.match(calls.at(-1).body.text,/الصيانة/);
  await processUpdate(x.db,env,ctx,{update_id:++id,callback_query:{id:'v17',from:{id:101,first_name:'John'},message:{chat:{id:101,type:'private'},message_id:99},data:'buy:1'}});
  assert.match(calls.at(-1).body.text,/الصيانة/);
  await handleAdminCallback(x.db,env,991,'admin_maintenance_toggle',20);
  assert.equal(x.conn.prepare("SELECT value FROM bot_settings WHERE key='maintenance_enabled'").get().value,'false');
  await home(x.db,env,101);
  assert.ok(flat(calls.at(-1)).some(b=>b.callback_data==='my_support_inbox'));
 })}finally{x.conn.close()}
});
