import test from 'node:test';
import assert from 'node:assert/strict';
import {isTransientWebhookError,registerWebhookWithRetry} from '../scripts/telegram-webhook-retry.mjs';
const fake={botToken:'TEST_ONLY',workerUrl:'https://bot.example.workers.dev',webhookSecret:'TEST_SECRET',sleep:async()=>{},maxAttempts:5};
function response(status,description,ok=false){
  return new Response(JSON.stringify(ok?{ok:true,result:true}:{ok:false,description}),{status,headers:{'Content-Type':'application/json'}});
}
test('DNS transient failure is retried and webhook payload is preserved',async()=>{
  const requests=[];let waits=0;
  const success=await registerWebhookWithRetry({...fake,
    request:async(_url,options)=>{requests.push(JSON.parse(options.body));return requests.length===1?response(400,'bad webhook: Failed to resolve host: Temporary failure in name resolution'):response(200,'',true)},
    sleep:async()=>{waits++}
  });
  assert.equal(success,true);assert.equal(waits,1);assert.equal(requests.length,2);
  assert.equal(requests[0].url,fake.workerUrl+'/webhook');
  assert.equal(requests[0].secret_token,fake.webhookSecret);
  assert.equal(requests[0].drop_pending_updates,false);
  assert.deepEqual(requests[0].allowed_updates,['message','callback_query','pre_checkout_query']);
});
test('permanent errors fail immediately',async()=>{
  let calls=0;
  await assert.rejects(registerWebhookWithRetry({...fake,request:async()=>{calls++;return response(401,'Unauthorized')}}),/permanently/);
  assert.equal(calls,1);
});
test('rate limits, server errors and fetch errors are retried',async()=>{
  let count=0;
  await registerWebhookWithRetry({...fake,request:async()=>{count++;if(count===1)return response(429,'Rate limited');if(count===2)return response(503,'Server busy');if(count===3)throw new TypeError('failed fetch');return response(200,'',true)}});
  assert.equal(count,4);
});
test('retry count is bounded and does not leak bot token',async()=>{
  let count=0;
  await assert.rejects(registerWebhookWithRetry({...fake,maxAttempts:2,request:async()=>{count++;return response(400,'Failed to resolve host')}}),
    err=>{assert.match(err.message,/after 2 attempts/);assert.ok(!err.message.includes(fake.botToken));return true});
  assert.equal(count,2);
});
test('classify transient DNS failures and permanent HTTPS failures',()=>{
  assert.equal(isTransientWebhookError(400,'Failed to resolve host'),true);
  assert.equal(isTransientWebhookError(400,'Bad Request: HTTPS URL must be provided'),false);
  assert.equal(isTransientWebhookError(429,'Too Many Requests'),true);
  assert.equal(isTransientWebhookError(503,'Unavailable'),true);
  assert.equal(isTransientWebhookError(403,'Forbidden'),false);
});
