import test from 'node:test';
import assert from 'node:assert/strict';
import {sendOrEditText} from '../src/telegram.js';
import {sendPhotoCard} from '../src/product-card.js';
const env={TELEGRAM_BOT_TOKEN:'MOCK'};
async function fake(fn){const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{const method=url.split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});return new Response(JSON.stringify({ok:true,result:{message_id:123}}));};try{await fn(calls)}finally{globalThis.fetch=old;}}
test('V20 navigating photo menu to text sends directly without invalid edit',async()=>{
 await fake(async calls=>{
  await sendOrEditText({...env,__callback_media:true,__callback_message_id:88},100,'🛡️ Admin', {inline_keyboard:[[{text:'Products',callback_data:'admin_products:0'}]]},88);
  assert.deepEqual(calls.map(x=>x.method),['sendMessage']);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data,'admin_products:0');
 });
});
test('V20 navigating text to product photo skips invalid editMessageCaption',async()=>{
 await fake(async calls=>{
  await sendPhotoCard({...env,__callback_media:false,__callback_message_id:88},100,'PIC','🛍️ Product',{inline_keyboard:[[{text:'Buy',callback_data:'buy:1'}]]},{messageId:88});
  assert.deepEqual(calls.map(x=>x.method),['sendPhoto']);
 });
});
test('V20 media to media edits caption while preserving old buttons',async()=>{
 await fake(async calls=>{
  await sendPhotoCard({...env,__callback_media:true,__callback_message_id:88},100,'PIC','🛍️ Product',{inline_keyboard:[[{text:'Refresh',callback_data:'product:1'}]]},{messageId:88});
  assert.deepEqual(calls.map(x=>x.method),['editMessageCaption']);
 });
});
