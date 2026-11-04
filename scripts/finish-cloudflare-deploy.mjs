// Configure Telegram webhook and bot commands after a healthy Cloudflare deploy.
// GitHub Actions runners can intermittently time out connecting to Telegram.
// Safely fall back to the authenticated Worker if the runner has network issues.
import {createHash} from 'node:crypto';
import {CUSTOMER_COMMANDS,OWNER_COMMANDS,CUSTOMER_COMMANDS_EN,OWNER_COMMANDS_EN} from '../src/commands.js';

const cfToken=process.env.CLOUDFLARE_API_TOKEN;
const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
const botToken=process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret=process.env.WEBHOOK_SECRET;
if(!cfToken||!accountId||!botToken||!/^[a-f0-9]{64}$/.test(webhookSecret??''))
  throw new Error('Missing required deployment secrets.');

const subRes=await fetch('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/subdomain',{
  headers:{Authorization:'Bearer '+cfToken},signal:AbortSignal.timeout(20000)
});
const subData=await subRes.json().catch(()=>null);
const subdomain=subData?.result?.subdomain;
if(!subRes.ok||!subData?.success||!subdomain||!/^[a-z0-9-]+$/.test(subdomain))
  throw new Error('Could not identify workers.dev subdomain. Enable a workers.dev subdomain in Cloudflare.');
const workerUrl='https://telegram-store-worker.'+subdomain+'.workers.dev';
let healthy=false;
let lastHealthError='';
for(let attempt=1;attempt<=15;attempt++){
  try{
    const check=await fetch(workerUrl+'/health',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    const health=check.ok?await check.json().catch(()=>null):null;
    if(check.ok&&health?.ok===true&&health?.service==='telegram-store-worker'){
      healthy=true;
      break;
    }
    lastHealthError='HTTP '+check.status;
    if(check.ok)throw new Error('Unexpected Worker health response.');
  }catch(error){
    if(String(error).includes('Unexpected Worker health response.'))throw error;
    lastHealthError=String(error?.name||'network');
  }
  if(attempt<15)await new Promise(resolve=>setTimeout(resolve,5000));
}
if(!healthy)throw new Error('Worker health check failed after retries: '+lastHealthError);

class TemporaryTelegramError extends Error {}
async function callTelegram(method,payload){
  for(let attempt=1;attempt<=2;attempt++){
    try{
      const response=await fetch('https://api.telegram.org/bot'+botToken+'/'+method,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)
      });
      const result=await response.json().catch(()=>null);
      if(response.ok&&result?.ok===true)return result.result;
      if(response.status===429||response.status>=500){
        if(attempt===2)throw new TemporaryTelegramError('Telegram temporarily unavailable (HTTP '+response.status+')');
      }else throw new Error('Telegram rejected '+method+' (HTTP '+response.status+'): '+String(result?.description||'').replaceAll(botToken,'[redacted]').slice(0,120));
    }catch(error){
      if(error instanceof TemporaryTelegramError)throw error;
      if(!(error instanceof TypeError) && error?.name!=='TimeoutError' && error?.name!=='AbortError')
        throw error;
      if(attempt===2)throw new TemporaryTelegramError('GitHub runner cannot connect to Telegram ('+String(error?.name||'network')+')');
    }
    await new Promise(resolve=>setTimeout(resolve,1200*attempt));
  }
  throw new TemporaryTelegramError('Telegram network temporarily unavailable');
}
async function setupDirect(){
  await callTelegram('setWebhook',{url:workerUrl+'/webhook',secret_token:webhookSecret,
    allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false});
  const info=await callTelegram('getWebhookInfo',{});
  if(info?.url!==workerUrl+'/webhook')throw new Error('Webhook verification did not match deployed Worker.');
  const adminId=Number(process.env.ADMIN_ID);
  if(!Number.isSafeInteger(adminId)||adminId<1)throw new Error('Invalid ADMIN_ID');
  await callTelegram('setMyCommands',{scope:{type:'default'},commands:CUSTOMER_COMMANDS});
  await callTelegram('setMyCommands',{scope:{type:'default'},language_code:'en',commands:CUSTOMER_COMMANDS_EN});
  await callTelegram('setMyCommands',{scope:{type:'chat',chat_id:adminId},commands:OWNER_COMMANDS});
  await callTelegram('setMyCommands',{scope:{type:'chat',chat_id:adminId},language_code:'en',commands:OWNER_COMMANDS_EN});
  await callTelegram('setChatMenuButton',{menu_button:{type:'commands'}});
}
try{
  await setupDirect();
  console.log('Success: Telegram webhook verified and commands configured from GitHub.');
}catch(error){
  if(!(error instanceof TemporaryTelegramError))throw error;
  console.warn('Telegram network unavailable from GitHub runner; retrying setup through authenticated Cloudflare Worker.');
  const auth=createHash('sha256').update('my-store-telegram-deploy-v1:'+webhookSecret).digest('hex');
  const response=await fetch(workerUrl+'/internal/deploy-telegram',{
    method:'POST',headers:{'X-My-Store-Deploy-Auth':auth},
    signal:AbortSignal.timeout(110000)
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok||result?.webhook_verified!==true||result?.commands_configured!==true)
    throw new Error('Cloudflare Telegram fallback could not complete setup (HTTP '+response.status+'). Worker deployed, but webhook configuration must be checked.');
  console.log('Success: Telegram webhook verified and commands configured through authenticated Cloudflare fallback.');
}
