// Owner-provided Binance TRON USDT deposit details.
// Independent manual-review method: do not enable the legacy TRC20 auto-credit logic.
export const TRON_ADDRESS='TPmyvDW5csXNPTsTswr31SpMkQhDNWj9BK';
export const TRON_QR_URL='https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/binance-tron-usdt.png';
export function isTronManualPaymentMethod(method){
  return !!method && method.method_key==='binance_tron' &&
    String(method.receiver||method.receiver_ar||'').trim()===TRON_ADDRESS;
}
export function validTronTxid(input){
  return /^[a-fA-F0-9]{64}$/.test(String(input||'').trim());
}
