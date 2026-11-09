import {formatIQD} from './common.js';
// All financial ledgers and payments remain integer IQD. EGP is only a
// presentation / quote input currency at an owner-set fixed exchange rate.
// Store EGP per USD as integer cents to avoid binary float discrepancies.
export const EGP_CURRENCY='EGP';
export const EGP_DEFAULT_RATE='54.24';
export const LYD_DEFAULT_RATE='6.43';
export function parseLydPerUsdMilli(value){
 const raw=String(value??'').trim();
 if(!/^\d{1,4}(?:\.\d{1,3})?$/.test(raw))return null;
 const [whole,fraction='']=raw.split('.');
 const milli=Number(whole)*1000+Number(fraction.padEnd(3,'0'));
 return Number.isSafeInteger(milli)&&milli>=1&&milli<=1000000?milli:null;
}
export function formatLydMilli(milli){
 if(!Number.isSafeInteger(milli))throw new Error('Invalid LYD');
 return (milli/1000).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3})+' د.ل';
}
export function lydQuoteToIQD(milli,usdIqd,lydPerUsdMilli){
 if(!Number.isSafeInteger(milli)||milli<=0||
    !Number.isSafeInteger(usdIqd)||usdIqd<=0||
    !Number.isSafeInteger(lydPerUsdMilli)||lydPerUsdMilli<=0)return null;
 const iqd=Math.round(milli*usdIqd/lydPerUsdMilli);
 return Number.isSafeInteger(iqd)&&iqd>=1000&&iqd<=10000000?iqd:null;
}

export function parseEgpPerUsdMinor(value){
 const s=String(value??'').trim();
 if(!/^\d{1,4}(?:\.\d{1,2})?$/.test(s))return null;
 const [whole,fraction='']=s.split('.');
 const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return Number.isSafeInteger(amount)&&amount>=1&&amount<=100000?amount:null;
}
export function formatEgpMinor(amount){
 if(!Number.isSafeInteger(amount))throw new Error('Invalid EGP amount');
 return (amount/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' ج.م';
}
export function formatPreferredIQD(iqd,currency,usdIqd,egpPerUsdMinor){
 const amount=Number(iqd);
 if(currency==='LYD'){
   if(!Number.isSafeInteger(usdIqd)||usdIqd<=0||!Number.isSafeInteger(egpPerUsdMinor)||egpPerUsdMinor<=0)return 'LYD —';
   return formatLydMilli(Math.round(amount*egpPerUsdMinor/usdIqd));
 }
 if(currency==='EGP'){
   if(!Number.isSafeInteger(usdIqd)||usdIqd<=0||!Number.isSafeInteger(egpPerUsdMinor)||egpPerUsdMinor<=0)
     return 'EGP —';
   return formatEgpMinor(Math.round(amount*egpPerUsdMinor/usdIqd));
 }
 if(currency==='USD'){
   if(!Number.isSafeInteger(usdIqd)||usdIqd<=0)return '$—';
   return '$'+(Math.round(amount*100/usdIqd)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 }
 return formatIQD(amount);
}
export function egpQuoteToIQD(egpMinor,usdIqd,egpPerUsdMinor){
 if(!Number.isSafeInteger(egpMinor)||egpMinor<=0||
    !Number.isSafeInteger(usdIqd)||usdIqd<=0||
    !Number.isSafeInteger(egpPerUsdMinor)||egpPerUsdMinor<=0)return null;
 const iqd=Math.round(egpMinor*usdIqd/egpPerUsdMinor);
 return Number.isSafeInteger(iqd)&&iqd>=1000&&iqd<=10000000?iqd:null;
}
export async function egpRate(db){
 const row=await db.prepare("SELECT value FROM bot_settings WHERE key='egp_rate_per_usd'").first();
 return parseEgpPerUsdMinor(row?.value??EGP_DEFAULT_RATE);
}
export async function lydRate(db){
 const row=await db.prepare("SELECT value FROM bot_settings WHERE key='lyd_rate_per_usd'").first();
 return parseLydPerUsdMilli(row?.value??LYD_DEFAULT_RATE);
}
export async function displayRate(db,currency){return currency==='EGP'?egpRate(db):currency==='LYD'?lydRate(db):null}
// Use the same fixed default as egpRate() and the admin screen when no
// explicit owner override exists. No extra D1 read is needed on storefronts.
export function rateFromVisual(settings){return parseEgpPerUsdMinor(settings?.egp_rate_per_usd??EGP_DEFAULT_RATE)}
export function lydRateFromVisual(settings){return parseLydPerUsdMilli(settings?.lyd_rate_per_usd??LYD_DEFAULT_RATE)}
export function egpDisplayEnabled(settings){return settings?.egp_display_enabled==='true'}
export function formatStoredQuote(row,viewCurrency='',usdIqd=null,egpPerUsdMinor=null){
 const currency=viewCurrency||(row.display_lyd_amount_milli!=null?'LYD':row.display_currency)||row.displayCurrency||row.currency||row.requested_currency;
 if(currency==='LYD'&&row.display_lyd_amount_milli!=null) return formatLydMilli(Number(row.display_lyd_amount_milli));
 if(currency==='LYD'&&row.displayMinor!=null) return formatLydMilli(Number(row.displayMinor));
 if(currency==='EGP'&&row.display_amount_minor!=null)
   return formatEgpMinor(Number(row.display_amount_minor));
 if(currency==='EGP'&&row.displayMinor!=null)
   return formatEgpMinor(Number(row.displayMinor));
 return formatPreferredIQD(Number(row.amountIqd??row.amount_iqd??0),currency,
   Number(usdIqd??row.rate??row.quoted_rate_iqd),
   Number(egpPerUsdMinor??(currency==='LYD'?(row.lydRateMilli??row.display_lyd_per_usd_milli):(row.egpRateMinor??row.display_egp_per_usd_minor))));
}
