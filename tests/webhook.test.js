import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('health endpoint responds',async()=>{
  const resp=await worker.fetch(new Request('https://example.workers.dev/health'),{},{});
  assert.equal(resp.status,200);
  assert.equal((await resp.json()).ok,true);
});
test('forbidden and missing webhook secret are rejected',async()=>{
  const req=()=>new Request('https://example.workers.dev/webhook',{method:'POST',body:'{}'});
  assert.equal((await worker.fetch(req(),{},{})).status,503);
  assert.equal((await worker.fetch(req(),{DB:{},TELEGRAM_BOT_TOKEN:'demo',WEBHOOK_SECRET:'safe'},{})).status,403);
});
test('only webhook can receive POST updates',async()=>{
  const resp=await worker.fetch(new Request('https://example.workers.dev/',{method:'POST',body:'{}'}),{},{});
  assert.equal(resp.status,404);
});
