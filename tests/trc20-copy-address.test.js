import test from 'node:test';
import assert from 'node:assert/strict';
import {topupTrc20} from '../src/ui.js';

const address='TMLhhXpUtAPkaG8Lw6XWuTzzJyou5wMvVR';
test('TRC20 user-facing photo copies the exact address with one tap',async()=>{
 const original=globalThis.fetch;
 let sent=null;
 globalThis.fetch=async(_url,opts)=>{
   sent=JSON.parse(opts.body);
   return new Response(JSON.stringify({ok:true,result:{message_id:717}}),{status:200});
 };
 try{
   const env={TELEGRAM_BOT_TOKEN:'MOCK',__locale:'ar'};
   const intent={intentId:'abc-123',receiver:address,expectedUsdtMicro:50370000};
   const quote={currency:'USD',requestedMinor:5000,amountIqd:76000,rate:1520};
   const result=await topupTrc20(null,env,12345,intent,quote);
   assert.equal(result.message_id,717);
   assert.match(sent.caption,/15 دقيقة/);
   assert.equal(sent.reply_markup.inline_keyboard[0][0].copy_text.text,address);
   assert.equal(sent.reply_markup.inline_keyboard[0][0].callback_data,undefined);
   const entity=sent.caption_entities.find(x=>x.type==='code');
   assert.ok(entity);
   assert.equal(sent.caption.slice(entity.offset,entity.offset+entity.length),address);
   assert.ok(sent.reply_markup.inline_keyboard.some(row=>row.some(btn=>btn.callback_data==='topup_trc20_paid:abc-123')));
   assert.ok(sent.reply_markup.inline_keyboard.some(row=>row.some(btn=>btn.callback_data==='topup_cancel')));
 }finally{globalThis.fetch=original}
});
