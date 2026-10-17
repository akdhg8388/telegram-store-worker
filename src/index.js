import {processUpdate} from './bot.js';
import {flushOutbox} from './telegram.js';

export default {
  async fetch(request, env, ctx) {
    const url=new URL(request.url);
    if(request.method==='GET' && url.pathname==='/health')return Response.json({ok:true,service:'telegram-store-worker'});
    if(request.method!=='POST' || url.pathname!=='/webhook')return new Response('Not found',{status:404});
    if(!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET)return new Response('Service not configured',{status:503});
    const supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if(!supplied || supplied!==env.WEBHOOK_SECRET)return new Response('Forbidden',{status:403});
    let update;
    try {update=await request.json()} catch{return new Response('Invalid JSON',{status:400})}
    if(!update || typeof update!=='object' || Array.isArray(update) ||
       !Number.isSafeInteger(update.update_id) || update.update_id<0)
      return new Response('Invalid Telegram update',{status:400});
    try{
      await processUpdate(env.DB,env,ctx,update);
      ctx.waitUntil(flushOutbox(env.DB,env).catch(e=>console.error('Outbox',String(e))));
      return new Response('OK');
    }catch(error){
      console.error('Telegram webhook handling failed:',String(error));
      return new Response('Temporary error',{status:500});
    }
  },
  async scheduled(_event,env,ctx){
    if(env.DB && env.TELEGRAM_BOT_TOKEN)ctx.waitUntil(flushOutbox(env.DB,env,25));
  }
};
