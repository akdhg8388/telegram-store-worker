import {formatIQD} from './common.js';
import {formatUSD} from './wallet.js';

// Quotes use the original IQD wallet amount and its saved FX rate.
// Fees can only change the requested TRANSFER, never wallet balances.
export function paymentQuote(method,quote){
 if(!method || method.quote_enabled===0 || method.quote_enabled===false)return null;
 if(!Number.isSafeInteger(quote?.amountIqd)||quote.amountIqd<=0)return null;
 const currency=method.pay_currency==='USD'?'USD':'IQD';
 const rate=Number(quote.rate);
 if(currency==='USD' && (!Number.isSafeInteger(rate)||rate<=0))return null;
 const base=currency==='USD'
   ?(quote.currency==='USD'&&Number.isSafeInteger(quote.requestedMinor)
     ?quote.requestedMinor:Math.round(quote.amountIqd*100/rate))
   :quote.amountIqd;
 const mode=['none','fixed','percent'].includes(method.fee_mode)?method.fee_mode:'none';
 const value=Number(method.fee_value||0);
 if(!Number.isSafeInteger(base)||base<=0||!Number.isSafeInteger(value)||value<0)return null;
 let total=base;
 if(mode==='fixed')total+=value;
 if(mode==='percent'){
   if(value>=10000)return null;
   // Percentage is deducted from what the customer sends, so gross up.
   total=Math.ceil(base*10000/(10000-value));
 }
 if(!Number.isSafeInteger(total)||total<=0||total>1000000000)return null;
 return {currency,baseMinor:base,feeMinor:total-base,totalMinor:total,mode};
}
export function formatTransferMinor(amount,currency){
 if(!Number.isSafeInteger(amount)||amount<0)throw new Error('Invalid transfer amount');
 return currency==='USD'?formatUSD(amount):formatIQD(amount);
}
export function transferSummary(p){
 if(!p?.transferCurrency||!Number.isSafeInteger(p.transferTotalMinor))return '';
 return '💵 صافي الشحن بعملة الدفع: '+formatTransferMinor(p.transferBaseMinor,p.transferCurrency)+
 '\n🧾 رسوم / استقطاع التحويل: '+formatTransferMinor(p.transferFeeMinor,p.transferCurrency)+
 '\n💸 إجمالي المطلوب تحويله: '+formatTransferMinor(p.transferTotalMinor,p.transferCurrency);
}
export function parseTransferFee(input,mode,currency){
 const s=String(input||'').trim();
 if(mode==='none')return 0;
 if(mode==='fixed'&&currency==='IQD')return /^\d{1,8}$/.test(s)&&Number(s)<=10000000?Number(s):null;
 if((mode==='fixed'&&currency==='USD')||mode==='percent'){
   if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(s))return null;
   const [whole,fraction='']=s.split('.');
   const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
   return mode==='percent'?(n<10000?n:null):(n<=10000000?n:null);
 }
 return null;
}
