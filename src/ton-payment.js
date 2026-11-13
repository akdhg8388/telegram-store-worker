// Fixed public Bybit USDT deposit address on TON, supplied by the store owner.
export const TON_ADDRESS='UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE';
export const TON_QR_URL='https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/ton-usdt-bybit.png';
export function isTonPaymentMethod(method){
  return !!method && method.method_key!=='usdt_trc20' &&
    String(method.receiver||method.receiver_ar||'').includes(TON_ADDRESS);
}
// TON explorers and exchanges may show hexadecimal or base64 transaction hashes.
export function validTonTransactionId(input){
  const value=String(input||'').trim();
  if(value.length>180||/\s/.test(value))return false;
  return /^[a-fA-F0-9]{64}$/.test(value) ||
    /^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value) ||
    /^https:\/\/[a-zA-Z0-9.-]+\/\S{20,140}$/.test(value);
}
