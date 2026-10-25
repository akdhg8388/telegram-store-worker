import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInventoryLines} from '../src/inventory-import.js';
test('unique inventory accepts lines, links and optional CSV header',()=>{
 assert.deepEqual(parseInventoryLines('code\nabc\nhttps://example.com/a\nabc').unique,['abc','https://example.com/a']);
 assert.deepEqual(parseInventoryLines('url\n"https://example.com/a,b"').unique,['https://example.com/a,b']);
 assert.throws(()=>parseInventoryLines('a\n'.repeat(51),50));
 assert.throws(()=>parseInventoryLines('bad\u0000code'));
 assert.throws(()=>parseInventoryLines('=SUM(1,1)'));
});
