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
const check=await fetch(workerUrl+'/health');
if(!check.ok)throw new Error('Worker health check failed: '+check.status);
const health=await check.json().catch(()=>null);
if(health?.ok!==true)throw new Error('Worker returned unexpected health response.');

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
