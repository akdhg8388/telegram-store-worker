const token=process.env.TELEGRAM_BOT_TOKEN;
const base=process.env.WORKER_URL;
const secret=process.env.WEBHOOK_SECRET;
if(!token || !base || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret) || !/^https:\/\//.test(base)) {
  console.error('Set TELEGRAM_BOT_TOKEN, WORKER_URL (https://...), and WEBHOOK_SECRET.');
  process.exit(1);
}
const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    url:`${base.replace(/\/$/,'')}/webhook`,secret_token:secret,
    allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false
  })
});
const result=await response.json();
if(!result.ok) {console.error('Telegram rejected webhook:',result.description);process.exit(1)}
console.log('Webhook registered successfully.');
