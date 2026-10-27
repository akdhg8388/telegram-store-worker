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
