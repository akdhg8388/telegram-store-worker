const BASE = 'https://api.telegram.org/bot';
export async function telegram(env, method, params) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`${BASE}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) {
    const err=new Error(`Telegram ${method}: ${response.status}: ${data?.description || 'unexpected response'}`);
    err.retryAfter=Number.isSafeInteger(data?.parameters?.retry_after) ? data.parameters.retry_after : null;
    throw err;
  }
  return data.result;
}
export const sendText = (env, chat_id, text, reply_markup) => telegram(env, 'sendMessage', {
  chat_id, text: String(text).slice(0, 4000), ...(reply_markup ? {reply_markup} : {})
});
export async function sendOrEditText(env, chat_id, text, reply_markup, message_id) {
  if (!Number.isSafeInteger(message_id) || message_id <= 0) return sendText(env,chat_id,text,reply_markup);
  try {
    return await telegram(env,'editMessageText',{
      chat_id,message_id,text:String(text).slice(0,4000),...(reply_markup?{reply_markup}:{})
    });
  }catch(error){
    const msg=String(error);
    if(/message is not modified/i.test(msg))return null;
    if(/message to edit not found|message can't be edited|message identifier is not specified/i.test(msg))
      return sendText(env,chat_id,text,reply_markup);
    throw error;
  }
}
export const answerCallback = (env, callback_query_id, text) => telegram(env,'answerCallbackQuery',{
  callback_query_id, ...(text ? {text: String(text).slice(0,190)} : {})
});
export async function queueNotification(db, method, params, metadata={}) {
  await db.prepare('INSERT INTO notification_outbox(method,payload,support_message_id,topup_request_id) VALUES (?,?,?,?)')
    .bind(method,JSON.stringify(params),metadata.supportMessageId||null,metadata.topupRequestId||null).run();
}
export async function flushOutbox(db, env, limit = 10) {
  const now = Math.floor(Date.now()/1000);
  const rows = await db.prepare(`SELECT id,method,payload,attempts,support_message_id,topup_request_id FROM notification_outbox
    WHERE (state='pending' AND next_attempt_at <= ?) OR (state='sending' AND lease_until < ?) ORDER BY id LIMIT ?`)
    .bind(now, now, limit).all();
  for(const item of rows.results ?? []) {
    const claim = await db.prepare(`UPDATE notification_outbox SET state='sending',lease_until=?,attempts=attempts+1
      WHERE id=? AND ((state='pending' AND next_attempt_at <= ?) OR (state='sending' AND lease_until < ?))`)
      .bind(now+90,item.id,now,now).run();
    if(!claim.meta?.changes) continue;
    try {
      const sent=await telegram(env, item.method, JSON.parse(item.payload));
      // Save the concrete Telegram notification message ID so old buttons can be retired
      // and support message copies can be deleted when Telegram permits.
      if(Number.isSafeInteger(sent?.message_id)){
        if(item.topup_request_id)await db.prepare('UPDATE topup_requests SET admin_notice_message_id=? WHERE id=?')
          .bind(sent.message_id,item.topup_request_id).run();
        if(item.support_message_id)await db.prepare('UPDATE support_messages SET admin_notice_message_id=? WHERE id=?')
          .bind(sent.message_id,item.support_message_id).run();
      }
      await db.prepare("UPDATE notification_outbox SET state='sent' WHERE id=?").bind(item.id).run();
    } catch(error) {
      console.error('Outbox delivery error', item.id, String(error));
      const backoff=Math.min(3600, 10 * 2 ** Math.min(8,item.attempts));
      const delay=Math.max(backoff, Number.isSafeInteger(error.retryAfter) ? error.retryAfter : 0);
      await db.prepare("UPDATE notification_outbox SET state='pending',lease_until=0,next_attempt_at=? WHERE id=?")
        .bind(Math.floor(Date.now()/1000)+delay,item.id).run();
    }
  }
}
