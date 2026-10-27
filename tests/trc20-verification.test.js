import test from 'node:test';
import assert from 'node:assert/strict';
import {trc20AddressIsValid,trc20TxidIsValid,formatUsdtMicro,verifyTrc20Payment} from '../src/trc20-payments.js';

test('TRC20 input validation and six-decimal payment fingerprint',()=>{
 assert.equal(trc20AddressIsValid('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),true);
 assert.equal(trc20AddressIsValid('not-an-address'),false);
 assert.equal(trc20TxidIsValid('a'.repeat(64)),true);
 assert.equal(trc20TxidIsValid('a'.repeat(63)),false);
 assert.equal(formatUsdtMicro(50001000),'50.001000 USDT');
});
test('Verification is fail-closed when owner has not configured TronGrid key',async()=>{
 const result=await verifyTrc20Payment({}, {status:'waiting',receiver:'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',expires_at:Math.floor(Date.now()/1000)+300},'a'.repeat(64));
 assert.equal(result.status,'unconfigured');
});

test('One-shot solidified receipt lookup rejects a syntactically valid but nonexistent TXID',async()=>{
 const {tronAddressHex}=await import('../src/trc20-payments.js');
 const receiver='TMLhhXpUtAPkaG8Lw6XWuTzzJyou5wMvVR';
 assert.ok(await tronAddressHex(receiver));
 const now=Math.floor(Date.now()/1000);
 const intent={status:'waiting',receiver,created_at:now-120,expires_at:now+600,expected_micro:1002100000};
 const key='0123456789abcdef'.repeat(4);
 const original=globalThis.fetch;let called=0;
 globalThis.fetch=async(_url,opts)=>{
   called++;assert.match(String(_url),/walletsolidity\/gettransactioninfobyid/);
   assert.equal(JSON.parse(opts.body).value,key);
   return new Response('{}',{status:200});
 };
 try{
   const checked=await verifyTrc20Payment({TRONGRID_API_KEY:'MOCK',WALLET_ADDRESS:receiver},intent,key);
   assert.equal(checked.status,'pending');
   assert.equal(called,1);
 }finally{globalThis.fetch=original}
});
test('Confirmed TRC20 receipt validates exact token, receiver, transfer amount and time',async()=>{
 const {tronAddressHex,inspectTrc20Receipt}=await import('../src/trc20-payments.js');
 const receiver='TMLhhXpUtAPkaG8Lw6XWuTzzJyou5wMvVR';
 const receiverHex=await tronAddressHex(receiver);
 const id='f'.repeat(64);
 const now=Math.floor(Date.now()/1000),micro=1002100000;
 const intent={receiver,expected_micro:micro,created_at:now-90,expires_at:now+600};
 const amount=micro.toString(16).padStart(64,'0');
 const event={address:'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
   topics:['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
     '0'.repeat(64),'0'.repeat(24)+receiverHex],
   data:amount};
 const receipt={id,receipt:{result:'SUCCESS'},blockTimeStamp:now*1000,log:[event]};
 const ok=inspectTrc20Receipt(receipt,intent,id,receiverHex);
 assert.equal(ok.status,'confirmed');
 assert.equal(ok.txid,id);
 assert.equal(inspectTrc20Receipt({...receipt,log:[{...event,data:'0'.repeat(63)+'1'}]},intent,id,receiverHex).status,'mismatch');
 assert.equal(inspectTrc20Receipt({...receipt,log:[{...event,address:'0'.repeat(40)}]},intent,id,receiverHex).status,'invalid');
 assert.equal(inspectTrc20Receipt({...receipt,log:[{...event,topics:[event.topics[0],event.topics[1],'0'.repeat(64)]}]},intent,id,receiverHex).status,'mismatch');
 assert.equal(inspectTrc20Receipt({...receipt,receipt:{result:'FAILED'}},intent,id,receiverHex).status,'invalid');
 assert.equal(inspectTrc20Receipt({...receipt,blockTimeStamp:(now+700)*1000},intent,id,receiverHex).status,'late');
});
