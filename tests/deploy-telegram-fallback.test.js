import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/index.js';

test('Telegram deploy endpoint rejects unauthenticated requests before sending anything',async()=>{
 const secret='f'.repeat(64),env={WEBHOOK_SECRET:secret,TELEGRAM_BOT_TOKEN:'TEST',ADMIN_ID:'991'};
 const url='https://example.workers.dev/internal/deploy-telegram';
 let outgoing=0;
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>{outgoing++;throw new Error('should not call Telegram')};
 try{
   for(const headers of [{},{'X-My-Store-Deploy-Auth':'a'.repeat(64)}]){
     const res=await worker.fetch(new Request(url,{method:'POST',headers}),env,{});
     assert.equal(res.status,403);
   }
   assert.equal(outgoing,0);
 }finally{globalThis.fetch=previous}
});

test('Authenticated Worker fallback registers and verifies Webhook and commands from Cloudflare',async()=>{
 const secret='a'.repeat(64);
 const token=createHash('sha256').update('my-store-telegram-deploy-v1:'+secret).digest('hex');
 const url='https://example.workers.dev/internal/deploy-telegram';
 const previous=globalThis.fetch;
 const calls=[];
 globalThis.fetch=async(input,init)=>{
   const method=String(input).split('/').at(-1);
   const params=JSON.parse(init.body);
   calls.push({method,params});
   return new Response(JSON.stringify({ok:true,result:method==='getWebhookInfo'?{url:'https://example.workers.dev/webhook'}:true}),{
     status:200,headers:{'Content-Type':'application/json'}
   });
 };
 try{
   const res=await worker.fetch(new Request(url,{method:'POST',
      headers:{'X-My-Store-Deploy-Auth':token}}),{
      WEBHOOK_SECRET:secret,TELEGRAM_BOT_TOKEN:'TEST',ADMIN_ID:'991'}, {});
   assert.equal(res.status,200);
   assert.equal((await res.json()).webhook_verified,true);
   assert.deepEqual(calls.map(x=>x.method),[
     'setWebhook','getWebhookInfo','setMyCommands','setMyCommands',
     'setMyCommands','setMyCommands','setChatMenuButton'
   ]);
   assert.equal(calls[0].params.url,'https://example.workers.dev/webhook');
   assert.equal(calls[0].params.drop_pending_updates,false);
   assert.equal(calls[0].params.secret_token,secret);
   assert.equal(calls[4].params.scope.chat_id,991);
 }finally{globalThis.fetch=previous}
});
