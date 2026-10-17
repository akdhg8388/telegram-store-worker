export const formatIQD = value => `${Number(value || 0).toLocaleString('en-US')} د.ع`;
export const formatStars = value => `${Number(value || 0).toLocaleString('en-US')} ⭐`;
export const short = (value, max = 700) => String(value ?? '').slice(0, max);
export const positiveInt = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
export const button = (text, callback_data, style = 'primary') => ({ text, callback_data, style });
export const urlButton = (text, url, style = 'primary') => ({ text, url, style });
export const keyboard = (...rows) => ({ inline_keyboard: rows.filter(x => x?.length) });
export const backRow = () => [button('↩️ الرجوع للرئيسية', 'home', 'danger')];
export const moneyMethods = { asiacell: 'آسيا سيل', zaincash: 'زين كاش', zain_balance: 'رصيد زين', superqi: 'سوبر كي', binance: 'Binance' };
export const orderNames = {
  awaiting_admin: '⏳ بانتظار موافقة المدير',
  awaiting_payment: '💳 بانتظار الدفع بالنجوم',
  paid_pending_delivery: '📦 مدفوع — قيد التجهيز',
  delivered: '✅ مكتمل', rejected: '❌ مرفوض', refunded: '↩️ مسترد'
};
export function adminIds(env) {
  // Exactly one private owner ID, supplied as a Cloudflare secret; fail closed.
  const id=String(env.ADMIN_ID ?? '').trim();
  return /^\d+$/.test(id) && id !== '0' ? [id] : [];
}
export function isAdmin(env, userId) { return adminIds(env).includes(String(userId)); }
export function pagination(page, count, prefix) {
  const rows=[];
  if(page>0) rows.push(button('⬅️ السابق', `${prefix}:${page-1}`));
  if(count===10) rows.push(button('التالي ➡️', `${prefix}:${page+1}`));
  return rows;
}
