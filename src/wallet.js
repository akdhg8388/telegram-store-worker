import {formatIQD, short, moneyMethods} from './common.js';
import {getSetting} from './settings.js';
import {paymentMethod} from './payment-methods.js';
import {formatEgpMinor,formatPreferredIQD,egpQuoteToIQD} from './display-currency.js';

export const USD_PRESETS = Object.freeze([10,25,100,250,500,1000]);
export const PAY_METHODS = Object.freeze(['zain_balance','superqi','binance']);
const RECEIVER_KEYS = Object.freeze({zain_balance:'zain_balance_receiver',superqi:'superqi_receiver',binance:'binance_receiver'});
const RECEIVER_ENVS = Object.freeze({zain_balance:'ZAIN_BALANCE_RECEIVER',superqi:'SUPERQI_RECEIVER',binance:'BINANCE_RECEIVER'});

// Financial values are stored in IQD integer units. USD display/request values
// use integer cents and an administrator-set rate; no fictional live FX rate.
export function formatUSD(cents){
  if(!Number.isSafeInteger(cents))throw new Error('Invalid USD amount');
  return '$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
export function formatQuote(quote) {
  if(quote?.displayCurrency==='EGP'||quote?.display_currency==='EGP'){
    const minor=Number(quote.displayMinor??quote.display_amount_minor);
    if(Number.isSafeInteger(minor)&&minor>=0)return formatEgpMinor(minor);
  }
  return quote.currency==='USD' ? `${formatUSD(quote.requestedMinor)} ≈ ${formatIQD(quote.amountIqd)}` : formatIQD(quote.amountIqd);
}
export function displayIqd(amount,user,usdIqd,egpPerUsdMinor){
 return formatPreferredIQD(Number(amount||0),user?.currency_preference||'USD',usdIqd,egpPerUsdMinor);
}
export function egpTopupQuote(minor,usdIqd,egpPerUsdMinor){
 const amountIqd=egpQuoteToIQD(minor,usdIqd,egpPerUsdMinor);
 if(amountIqd===null)return null;
 return {currency:'IQD',requestedMinor:amountIqd,amountIqd,rate:usdIqd,
   displayCurrency:'EGP',displayMinor:minor,egpRateMinor:egpPerUsdMinor};
}
export function validRate(raw){
  const v=Number(raw);
  return Number.isSafeInteger(v)&&v>=100&&v<=10000?v:null;
}
export async function usdRate(db){return validRate(await getSetting(db,'usd_rate_iqd',''));}
export async function isTopupEnabled(db,env){
  return (await getSetting(db,'manual_topups_enabled',env.ENABLE_MANUAL_TOPUPS||'false'))==='true';
}
export async function receiverFor(db,env,method){
  const m=await paymentMethod(db,env,method);
  return m?.enabled&&m?.visible?String(m.receiver||'').trim():'';
}
export function quoteFromUSD(usd,rate,currency='USD'){
  if(!Number.isSafeInteger(usd)||!USD_PRESETS.includes(usd))return null;
  return quoteMinor(currency,currency==='USD'?usd*100:usd*rate,rate);
}
export function quoteMinor(currency,minor,rate){
  if(!['IQD','USD'].includes(currency)||!Number.isSafeInteger(minor)||minor<=0||!validRate(rate))return null;
  if(currency==='USD' && (minor<100 || minor>100000))return null;
  const amountIqd=currency==='USD'?Math.round(minor*rate/100):minor;
  if(amountIqd<1000 || amountIqd>10000000)return null;
  return {currency,requestedMinor:minor,amountIqd,rate};
}
export function parseCustomMinor(input,currency){
  const value=String(input).trim().replace(/,/g,'');
  if(currency==='IQD')return /^\d{1,8}$/.test(value) ? Number(value):null;
  if(!new RegExp(currency==='EGP'?'^\\d{1,6}(?:\\.\\d{1,2})?$':'^\\d{1,4}(?:\\.\\d{1,2})?$').test(value))return null;
  const [whole,fraction='']=value.split('.');
  const minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(minor)?minor:null;
}
export function baghdadDate(utcText,locale='ar'){
  if(!utcText)return 'غير متوفر';
  const normalized=String(utcText).replace(' ','T')+(String(utcText).endsWith('Z')?'':'Z');
  const dt=new Date(normalized);
  if(!Number.isFinite(dt.getTime()))return short(utcText,35);
  return new Intl.DateTimeFormat(locale==='en'?'en-US':'ar-IQ',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:true}).format(dt)+(locale==='en'?' (Baghdad time)':' (بتوقيت بغداد)');
}
export function topupStatus(status){return ({pending:'⏳ قيد المراجعة',approved:'✅ تمت الموافقة',rejected:'❌ مرفوض'})[status]||status;}
export function quoteOfRecord(row){return {
  currency:row.requested_currency||'IQD',requestedMinor:row.requested_amount_minor||row.amount_iqd,
  amountIqd:row.amount_iqd,rate:row.quoted_rate_iqd||null,
  displayCurrency:row.display_currency||null,displayMinor:row.display_amount_minor,
  egpRateMinor:row.display_egp_per_usd_minor
};}
export function topupStatusMessage(row,currency=null,usdIqd=null,egpRateMinor=null){
  const preferred=currency==='EGP'&&egpRateMinor&&usdIqd
    ?value=>formatPreferredIQD(value,'EGP',usdIqd,egpRateMinor)
    :currency==='USD'&&usdIqd?value=>formatPreferredIQD(value,'USD',usdIqd,null)
    :currency==='IQD'?formatIQD:null;
  const requested=preferred?preferred(row.amount_iqd):formatQuote(quoteOfRecord(row));
  return `💳 طلب شحن #${row.id}\n\n💰 المطلوب: ${requested}${row.credited_amount_iqd!=null?'\n✅ المضاف فعلياً: '+(preferred?preferred(row.credited_amount_iqd):formatIQD(row.credited_amount_iqd)):''}\n💸 الطريقة: ${moneyMethods[row.method]||row.method}\n📌 الحالة: ${topupStatus(row.status)}\n🗓️ وقت الطلب: ${baghdadDate(row.created_at)}${row.decided_at?'\n🕒 وقت القرار: '+baghdadDate(row.decided_at):''}`;
}
