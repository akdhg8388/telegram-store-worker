// Cloudflare fallback when the GitHub runner has no route to api.telegram.org.
// This endpoint is protected by a SHA-256 derivative of the existing webhook
// secret, and it does not accept a user-provided webhook URL or bot token.
import {CUSTOMER_COMMANDS,OWNER_COMMANDS,CUSTOMER_COMMANDS_EN,OWNER_COMMANDS_EN} from './commands.js';

const phrase='my-store-telegram-deploy-v1:';
export async function authorizeDeployRequest(request,secret){
 if(!/^[a-f0-9]{64}$/.test(String(secret||'')))return false;
 const provided=request.headers.get('X-My-Store-Deploy-Auth')||'';
 if(!/^[a-f0-9]{64}$/.test(provided))return false;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(phrase+secret));
 const expected=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
 // Constant-time comparison after validating equal lengths.
 let diff=0;
 for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^provided.charCodeAt(i);
 return diff===0;
}
export async function finishTelegramFromWorker(env,origin){
 const token=env.TELEGRAM_BOT_TOKEN,secret=env.WEBHOOK_SECRET;
 const adminId=Number(env.ADMIN_ID);
 if(!token||!/^[a-f0-9]{64}$/.test(String(secret||''))||!Number.isSafeInteger(adminId)||adminId<1)
   throw new Error('Telegram deployment configuration missing');
 if(!origin.startsWith('https://'))throw new Error('HTTPS origin required');
 const url=origin.replace(/\/$/,'')+'/webhook';
 const call=async(method,body)=>{
   const res=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify(body),
     signal:AbortSignal.timeout(18000)
   });
   const data=await res.json().catch(()=>null);
   if(!res.ok||data?.ok!==true)
     throw new Error('Telegram '+method+' returned HTTP '+res.status+' (ok='+String(data?.ok)+')');
   return data.result;
 };
 await call('setWebhook',{url,secret_token:secret,
   allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false});
 const info=await call('getWebhookInfo',{});
 if(info?.url!==url)throw new Error('Telegram webhook URL verification failed');
 await call('setMyCommands',{scope:{type:'default'},commands:CUSTOMER_COMMANDS});
 await call('setMyCommands',{scope:{type:'default'},language_code:'en',commands:CUSTOMER_COMMANDS_EN});
 await call('setMyCommands',{scope:{type:'chat',chat_id:adminId},commands:OWNER_COMMANDS});
 await call('setMyCommands',{scope:{type:'chat',chat_id:adminId},language_code:'en',commands:OWNER_COMMANDS_EN});
 await call('setChatMenuButton',{menu_button:{type:'commands'}});
 return {ok:true,webhook_verified:true,commands_configured:true};
}
