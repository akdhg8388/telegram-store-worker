export const formatIQD = value => `${Number(value || 0).toLocaleString('en-US')} د.ع`;
export const formatStars = value => `${Number(value || 0).toLocaleString('en-US')} ⭐`;
export const short = (value, max = 700) => String(value ?? '').slice(0, max);
export const positiveInt = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
export const button = (text, callback_data, style) => ({ text, callback_data, ...(style ? { style } : {}) });
export const urlButton = (text, url) => ({ text, url });
export const keyboard = (...rows) => ({ inline_keyboard: rows.filter(x => x?.length) });
export const backRow = () => [button('⬅️ الرجوع للرئيسية', 'home')];
export const moneyMethods = { asiacell: 'آسيا سيل', zaincash: 'زين كاش', superqi: 'سوبر كي' };
export const orderNames = {
  awaiting_admin: '⏳ بانتظار موافقة المدير',
  awaiting_payment: '💳 بانتظار الدفع بالنجوم',
  paid_pending_delivery: '📦 مدفوع — قيد التجهيز',
  delivered: '✅ مكتمل', rejected: '❌ مرفوض', refunded: '↩️ مسترد'
};
export function adminIds(env) {
  return String(env.ADMIN_IDS ?? '').split(',').map(x=>x.trim()).filter(x=>/^\d+$/.test(x));
}
export function isAdmin(env, userId) { return adminIds(env).includes(String(userId)); }
export function pagination(page, count, prefix) {
  const rows=[];
  if(page>0) rows.push(button('⬅️ السابق', `${prefix}:${page-1}`));
  if(count===10) rows.push(button('التالي ➡️', `${prefix}:${page+1}`));
  return rows;
}
