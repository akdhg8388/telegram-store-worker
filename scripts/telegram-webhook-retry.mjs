// Telegram may temporarily be unable to resolve a healthy workers.dev domain.
// Retry only transient failures without revealing credentials in logs.
export function isTransientWebhookError(status,description=''){
  return status===429 || (status>=500&&status<600) ||
    (status===400 && /failed to resolve host|temporary failure in name resolution|dns lookup|name resolution|could not resolve host|connection timed out|connection refused|ssl handshake timed out/i.test(String(description)));
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function registerWebhookWithRetry({botToken,workerUrl,webhookSecret,request=fetch,sleep=delay,maxAttempts=30,onRetry=()=>{}}){
  if(!botToken||!workerUrl?.startsWith('https://')||!webhookSecret)throw Error('Missing webhook configuration');
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>60)throw Error('Invalid retry count');
  const body=JSON.stringify({
    url:workerUrl+'/webhook',secret_token:webhookSecret,
    allowed_updates:['message','callback_query','pre_checkout_query'],
    drop_pending_updates:false
  });
  let lastError='';
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    let retry=false;
    let retryAfter=0;
    try{
      const response=await request('https://api.telegram.org/bot'+botToken+'/setWebhook',{
        method:'POST',headers:{'Content-Type':'application/json'},body,
        signal:AbortSignal.timeout(25000)
      });
      const result=await response.json().catch(()=>null);
      if(response.ok && result?.ok===true)return true;
      const reason=String(result?.description||'Unknown error').replaceAll(botToken,'[redacted]').slice(0,250);
      lastError='HTTP '+response.status+': '+reason;
      retry=isTransientWebhookError(response.status,reason);
      if(response.status===429)retryAfter=Number(result?.parameters?.retry_after||0);
    }catch(error){
      // Includes DNS, connection resets and request timeouts.
      lastError='Network error ('+String(error?.name||'unknown').slice(0,40)+')';
      retry=true;
    }
    if(!retry)throw Error('Telegram rejected webhook permanently: '+lastError);
    if(attempt>=maxAttempts)throw Error('Telegram webhook failed after '+attempt+' attempts: '+lastError);
    const waitMs=Math.max(Math.min(3000+attempt*1000,12000),Math.min(retryAfter*1000,30000));
    onRetry({attempt,maxAttempts,delayMs:waitMs});
    await sleep(waitMs);
  }
  throw Error('Webhook retry exhausted');
}
