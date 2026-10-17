// Configure Telegram webhook after the Worker is deployed and its secrets are present.
// Never print tokens, webhook secret, or full Telegram API URLs.
const cfToken=process.env.CLOUDFLARE_API_TOKEN;
const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const botToken=process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret=process.env.WEBHOOK_SECRET;
if(!cfToken||!accountId||!botToken||!/^[a-f0-9]{64}$/.test(webhookSecret??''))
  throw new Error('Missing required deployment secrets.');

const subRes=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/subdomain',{
  headers:{Authorization:'Bearer '+cfToken}
});
const subData=await subRes.json().catch(()=>null);
const subdomain=subData?.result?.subdomain;
if(!subRes.ok||!subData?.success||!subdomain||!/^[a-z0-9-]+$/.test(subdomain)){
  throw new Error('Could not identify workers.dev subdomain. Enable a workers.dev subdomain in your Cloudflare account.');
}
const workerUrl='https://telegram-store-worker.'+subdomain+'.workers.dev';
// A newly published workers.dev hostname may briefly return 404 during propagation.
let healthy=false;
let lastHealthError='';
for(let attempt=1;attempt<=15;attempt++){
  try {
    const check=await fetch(workerUrl+'/health',{cache:'no-store'});
    const health=check.ok?await check.json().catch(()=>null):null;
    if(check.ok && health?.ok===true && health?.service==='telegram-store-worker'){
      healthy=true;
      break;
    }
    lastHealthError='HTTP '+check.status;
    // Fail fast on an unexpected 2xx payload; the hostname might point to the wrong application.
    if(check.ok)throw new Error('Unexpected Worker health response.');
  } catch(error) {
    if(String(error).includes('Unexpected Worker health response.'))throw error;
    lastHealthError=String(error).slice(0,180);
  }
  if(attempt<15)await new Promise(resolve=>setTimeout(resolve,5000));
}
if(!healthy)throw new Error('Worker health check failed after retries: '+lastHealthError);

const response=await fetch('https://api.telegram.org/bot'+botToken+'/setWebhook',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    url:workerUrl+'/webhook',
    secret_token:webhookSecret,
    allowed_updates:['message','callback_query','pre_checkout_query'],
    drop_pending_updates:false
  })
});
const result=await response.json().catch(()=>null);
if(!response.ok||!result?.ok)throw new Error('Telegram setWebhook failed: '+(result?.description||response.status));
const checkWebhook=await fetch('https://api.telegram.org/bot'+botToken+'/getWebhookInfo');
const info=await checkWebhook.json().catch(()=>null);
if(!checkWebhook.ok||!info?.ok||info.result?.url!==workerUrl+'/webhook')throw new Error('Webhook verification did not match the deployed Worker.');
console.log('Success. My Store webhook configured at '+workerUrl+'/webhook');
