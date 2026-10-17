// Configure Telegram webhook, public hamburger menu and owner-only command list.
// Never print tokens or secrets. All credentials are GitHub Actions secrets.
import {CUSTOMER_COMMANDS,OWNER_COMMANDS,CUSTOMER_COMMANDS_EN,OWNER_COMMANDS_EN} from '../src/commands.js';
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
if(!subRes.ok||!subData?.success||!subdomain||!/^[a-z0-9-]+$/.test(subdomain))
  throw new Error('Could not identify workers.dev subdomain. Enable a workers.dev subdomain in Cloudflare.');
const workerUrl='https://telegram-store-worker.'+subdomain+'.workers.dev';
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
    if(check.ok)throw new Error('Unexpected Worker health response.');
  } catch(error) {
    if(String(error).includes('Unexpected Worker health response.'))throw error;
    lastHealthError=String(error).slice(0,180);
  }
  if(attempt<15)await new Promise(resolve=>setTimeout(resolve,5000));
}
if(!healthy)throw new Error('Worker health check failed after retries: '+lastHealthError);

async function callTelegram(method,payload){
  const response=await fetch('https://api.telegram.org/bot'+botToken+'/'+method,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok || result?.ok!==true)
    throw new Error('Telegram '+method+' failed: '+(result?.description||response.status));
  return result.result;
}
await callTelegram('setWebhook',{
  url:workerUrl+'/webhook',secret_token:webhookSecret,
  allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false
});
const info=await callTelegram('getWebhookInfo',{});
if(info.url!==workerUrl+'/webhook')throw new Error('Webhook verification did not match deployed Worker.');
// Native three-line commands menu; no persistent ReplyKeyboard clutter.
await callTelegram('setMyCommands',{scope:{type:'default'},commands:CUSTOMER_COMMANDS});
await callTelegram('setMyCommands',{scope:{type:'default'},language_code:'en',commands:CUSTOMER_COMMANDS_EN});
// Telegram's chat-specific scope overrides default for the private owner.
const adminId=Number(process.env.ADMIN_ID);
if(!Number.isSafeInteger(adminId)||adminId<=0)throw new Error('Invalid ADMIN_ID');
await callTelegram('setMyCommands',{scope:{type:'chat',chat_id:adminId},commands:OWNER_COMMANDS});
await callTelegram('setMyCommands',{scope:{type:'chat',chat_id:adminId},language_code:'en',commands:OWNER_COMMANDS_EN});
await callTelegram('setChatMenuButton',{menu_button:{type:'commands'}});
console.log('Success. Worker health, webhook, customer commands menu and owner commands are ready.');
