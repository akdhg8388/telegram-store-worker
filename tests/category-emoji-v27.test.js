import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {parseCategoryEmoji,categoryButton} from '../src/category-emoji.js';
import {handleAdminText} from '../src/admin-controls.js';
import {categories} from '../src/ui.js';

const id='5400000000000000099';
function fixture(){
 const c=new DatabaseSync(':memory:');
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\\d\\d_.*\\.sql$/.test(n)).sort())
   c.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const db={prepare(sql){const st=c.prepare(sql);let args=[];const q={bind(...a){args=a;return q},async first(){return st.get(...args)||null},async all(){return {results:st.all(...args)}},async run(){const x=st.run(...args);return {meta:{changes:x.changes,last_row_id:Number(x.lastInsertRowid)}}}};return q}};
 return {db,c};
}
async function capture(fn){const prior=globalThis.fetch,calls=[];globalThis.fetch=async(url,opt)=>{const body=JSON.parse(opt.body);calls.push({method:String(url).split('/').at(-1),body});return new Response(JSON.stringify({ok:true,result:{message_id:55}}));};try{await fn(calls)}finally{globalThis.fetch=prior}}
test('category picker parses normal and actual custom emoji only',()=>{
 assert.deepEqual(parseCategoryEmoji({text:'🤖'}),{emoji:'🤖',customEmojiId:null});
 assert.deepEqual(parseCategoryEmoji({text:'🤖',entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:id}]}),{emoji:'🤖',customEmojiId:id});
 assert.equal(parseCategoryEmoji({text:'not emoji'}),null);
 assert.equal(parseCategoryEmoji({text:'🤖🤖'}),null);
 assert.equal(parseCategoryEmoji({text:'🤖',entities:[{type:'custom_emoji',offset:1,length:1,custom_emoji_id:id}]}).customEmojiId,null);
});
test('custom icon preserves Unicode fallback and callback action',()=>{
 const x=categoryButton({emoji:'🤖',custom_emoji_id:id},'ChatGPT','category:1:0');
 assert.equal(x.text,'ChatGPT');assert.equal(x.icon_custom_emoji_id,id);
 assert.equal(x._emoji_fallback_text,'🤖 ChatGPT');assert.equal(x.callback_data,'category:1:0');
 const ordinary=categoryButton({emoji:'💎',custom_emoji_id:null},'Gems','category:2:0');
 assert.equal(ordinary.text,'💎 Gems');assert.equal(ordinary.icon_custom_emoji_id,undefined);
});
test('owner changes animated to ordinary icon and user category list uses it',async()=>{
 const {db,c}=fixture();
 c.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner')").run();
 const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TOKEN'};
 await capture(async calls=>{
  await handleAdminText(db,env,991,{action:'owner_category_field',payload:{id:1,field:'emoji'}},{text:'🤖',entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:id}]});
  assert.equal(c.prepare('SELECT custom_emoji_id FROM categories WHERE id=1').get().custom_emoji_id,id);
  await categories(db,env,991);
  const buttons=calls.at(-1).body.reply_markup.inline_keyboard.flat();
  const custom=buttons.find(x=>x.callback_data==='category:1:0');
  assert.equal(custom.icon_custom_emoji_id,id);
  assert.ok(custom.text.length>1);
  await handleAdminText(db,env,991,{action:'owner_category_field',payload:{id:1,field:'emoji'}},{text:'💎'});
  assert.equal(c.prepare('SELECT custom_emoji_id FROM categories WHERE id=1').get().custom_emoji_id,null);
  await categories(db,env,991);
  assert.ok(calls.at(-1).body.reply_markup.inline_keyboard.flat().find(x=>x.callback_data==='category:1:0').text.startsWith('💎'));
 });
 c.close();
});
