import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {formatTerms,termsPage,DEFAULT_TERMS} from '../src/terms.js';
import {home} from '../src/ui.js';
import {adminRoute,handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {ensureUser,getSession} from '../src/database.js';
import {homeSettingKey,HOME_BUTTONS} from '../src/home-buttons.js';

function fixture(){
 const c=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort())
   c.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const db={prepare(sql){const statement=c.prepare(sql);let args=[];
  const query={bind(...params){args=params;return query},
   async first(){return statement.get(...args)??null},
   async all(){return {results:statement.all(...args)}},
   async run(){const r=statement.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};
  return query;},
  async batch(queries){c.exec('BEGIN');try{const r=[];for(const q of queries)r.push(await q.run());c.exec('COMMIT');return r;}catch(e){c.exec('ROLLBACK');throw e}}};
 return {c,db};
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST',STORE_NAME:'My Store'};
async function mock(action){
 const old=globalThis.fetch,requests=[];let id=200;
 globalThis.fetch=async(url,init)=>{
  const method=String(url).split('/').at(-1),payload=JSON.parse(init.body);requests.push({method,payload});
  if(method==='getCustomEmojiStickers')
    return new Response(JSON.stringify({ok:true,result:[{is_animated:false,is_video:false}]}),{status:200});
  return new Response(JSON.stringify({ok:true,result:{message_id:method.startsWith('edit')?payload.message_id:++id}}),{status:200});
 };
 try{return await action(requests);}finally{globalThis.fetch=old}
}
test('new Terms button appears beside currency in default Telegram color with red Home in policy',async()=>{
 const {c,db}=fixture();try{await mock(async calls=>{
   await ensureUser(db,{id:101,first_name:'Buyer'});
   await home(db,env,101);
   const rows=calls.at(-1).payload.reply_markup.inline_keyboard;
   const pair=rows.find(r=>r.some(b=>b.callback_data==='currency'));
   assert.deepEqual(pair.map(x=>x.callback_data),['currency','terms']);
   assert.equal(pair[1].style,undefined);
   assert.match(pair[1].text,/شروط الاستخدام/);
   const before=calls.length;
   await termsPage(db,env,101,9919);
   assert.equal(calls.length,before+1);
   const screen=calls.at(-1).payload;
   assert.match(screen.text,/سياسة استرداد الأموال/);
   assert.deepEqual(screen.reply_markup.inline_keyboard[0].map(x=>x.callback_data),['home']);
   assert.equal(screen.reply_markup.inline_keyboard[0][0].style,'danger');
   assert.ok(screen.entities.some(e=>e.type==='bold'));
   assert.ok(screen.entities.every(e=>e.type==='bold'));
 });}finally{c.close()}
});
test('custom terms headings are bold and ordinary explanation is NOT bold',()=>{
 const content='📝 شروط المتجر\n\n**1️⃣ سياسة الضمان:**\n• شرح للعميل 💚 بدون تغيير.\n\n2️⃣ سياسة الإرجاع:\n• رجوع حسب الشروط.';
 const {text,entities}=formatTerms(content);
 assert.ok(!text.includes('**'));
 assert.match(text,/شرح للعميل 💚/);
 for(const label of ['📜 شروط الاستخدام','1️⃣ سياسة الضمان:','2️⃣ سياسة الإرجاع:'])
   assert.ok(entities.some(e=>text.slice(e.offset,e.offset+e.length)===label),label);
 assert.ok(!entities.some(e=>text.slice(e.offset,e.offset+e.length).includes('شرح للعميل')));
 assert.ok(DEFAULT_TERMS.length<3500,'default terms must fit alongside Telegram message heading');
});
test('owner can change terms text, button name and static/custom icon; customer cannot access admin',async()=>{
 const {c,db}=fixture();try{await mock(async calls=>{
   await ensureUser(db,{id:991,first_name:'Owner'});
   await ensureUser(db,{id:101,first_name:'Buyer'});
   assert.ok(HOME_BUTTONS.find(x=>x.id==='terms'));
   assert.equal(adminRoute('admin_terms'),true);
   assert.equal(await handleAdminCallback(db,env,101,'admin_terms',300),true);
   assert.equal(c.prepare('SELECT COUNT(*) n FROM bot_settings').get().n,0);
   await handleAdminCallback(db,env,991,'admin_terms',301);
   const menu=calls.at(-1).payload.reply_markup.inline_keyboard.flat();
   for(const key of ['terms_text','home_button_terms_label_ar','home_button_terms_icon'])
     assert.ok(menu.some(x=>x.callback_data==='admin_setting_edit:'+key),key);
   await handleAdminCallback(db,env,991,'admin_setting_edit:terms_text',302);
   const session=await getSession(db,991);
   assert.equal(session.action,'owner_setting');
   const policy='**1️⃣ سياسة بسيطة:**\nشرح لا يتغير 💚';
   await handleAdminText(db,env,991,session,{text:policy,entities:[]});
   assert.equal(c.prepare("SELECT value FROM bot_settings WHERE key='terms_text'").get().value,policy);
   await termsPage(db,env,101);
   const page=calls.at(-1).payload;
   assert.match(page.text,/شرح لا يتغير 💚/);
   assert.ok(page.entities.some(e=>page.text.slice(e.offset,e.offset+e.length)==='1️⃣ سياسة بسيطة:'));
   // A regular Unicode emoji works as part of the label.
   await handleAdminCallback(db,env,991,'admin_setting_edit:home_button_terms_label_ar');
   await handleAdminText(db,env,991,await getSession(db,991),{text:'📃 قواعد المتجر',entities:[]});
   assert.equal(c.prepare('SELECT value FROM bot_settings WHERE key=?').get(homeSettingKey('terms','label_ar')).value,'📃 قواعد المتجر');
   // A static custom Telegram emoji is allowed for Terms, unlike legacy animated-only slots.
   await handleAdminCallback(db,env,991,'admin_setting_edit:home_button_terms_icon');
   await handleAdminText(db,env,991,await getSession(db,991),{text:'5234567890123456789',entities:[]});
   assert.equal(c.prepare('SELECT value FROM bot_settings WHERE key=?').get(homeSettingKey('terms','icon')).value,'5234567890123456789');
 });}finally{c.close()}
});
