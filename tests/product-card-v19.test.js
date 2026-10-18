import test from 'node:test';
import assert from 'node:assert/strict';
import {cardEntities,splitPhotoCaption,sendPhotoCard} from '../src/product-card.js';

test('V19 product labels get native Telegram bold entities without altering values',()=>{
 const t='💰 السعر: 1,520 د.ع\n📦 المخزون: 8\n🚚 نوع التسليم: كود فريد';
 const e=cardEntities(t,['💰 السعر:','📦 المخزون:','🚚 نوع التسليم:']);
 assert.equal(e.length,3);
 assert.deepEqual(e.map(x=>t.slice(x.offset,x.offset+x.length)),['💰 السعر:','📦 المخزون:','🚚 نوع التسليم:']);
 assert.ok(e.every(x=>x.type==='bold'));
});
test('V19 photo caption preserves all long sensitive delivery content in a follow-up',()=>{
 const credential='UNIQUE-CREDENTIAL-'+('X'.repeat(300));
 const text='Product\n'+('D'.repeat(1000))+'\n'+credential;
 const parts=splitPhotoCaption(text);
 assert.ok(parts.caption.length<=1024);
 assert.equal(parts.caption+parts.remaining,text);
 assert.ok(parts.remaining.includes(credential));
});
test('V19 photo and buttons share one native Telegram message when caption fits',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
   calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});
   return new Response(JSON.stringify({ok:true,result:{message_id:123}}),{status:200});
 };
 try{
  const env={TELEGRAM_BOT_TOKEN:'TEST'};
  const markup={inline_keyboard:[[{text:'🛒 Buy',callback_data:'buy:1'}]]};
  await sendPhotoCard(env,101,'PHOTO_ID','🛍️ Product\n💰 Price: 100 IQD',markup,{entities:cardEntities('🛍️ Product\n💰 Price: 100 IQD',['💰 Price:'])});
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'sendPhoto');
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data,'buy:1');
  assert.equal(calls[0].body.caption_entities[0].type,'bold');
 }finally{globalThis.fetch=original;}
});
