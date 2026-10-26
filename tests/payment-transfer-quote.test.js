import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentQuote,parseTransferFee,transferSummary} from '../src/payment-quote.js';

test('IQD and USD display preferences preserve the same wallet amount and fee-free payment total',()=>{
 const quoteIQD={currency:'IQD',amountIqd:1520000,requestedMinor:1520000,rate:1520};
 const quoteUSD={currency:'USD',amountIqd:1520000,requestedMinor:100000,rate:1520};
 for(const q of [quoteIQD,quoteUSD]){
  const razer=paymentQuote({pay_currency:'USD',fee_mode:'none',fee_value:0,quote_enabled:1},q);
  assert.equal(razer.totalMinor,100000);
  assert.equal(razer.currency,'USD');
  const zain=paymentQuote({pay_currency:'IQD',fee_mode:'fixed',fee_value:2000,quote_enabled:1},q);
  assert.equal(zain.totalMinor,1522000);
  assert.equal(zain.baseMinor,1520000);
  assert.match(transferSummary({transferCurrency:'IQD',transferBaseMinor:zain.baseMinor,transferFeeMinor:zain.feeMinor,transferTotalMinor:zain.totalMinor}),/1,522,000/);
  const qi=paymentQuote({pay_currency:'IQD',fee_mode:'none',fee_value:0,quote_enabled:1},q);
  assert.equal(qi.totalMinor,1520000);
 }
});
test('percentage is grossed up so the customer pays the deduction',()=>{
 const q={currency:'IQD',amountIqd:100000,requestedMinor:100000,rate:1520};
 const x=paymentQuote({pay_currency:'IQD',fee_mode:'percent',fee_value:1000,quote_enabled:1},q);
 assert.equal(x.totalMinor,111112);
 assert.ok(Math.floor(x.totalMinor*0.9)>=100000);
 assert.equal(parseTransferFee('10.50','percent','IQD'),1050);
 assert.equal(parseTransferFee('2.50','fixed','USD'),250);
 assert.equal(parseTransferFee('100','percent','IQD'),null);
 assert.equal(paymentQuote({quote_enabled:0},q),null);
});
