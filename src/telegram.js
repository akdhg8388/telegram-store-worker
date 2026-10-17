const BASE = 'https://api.telegram.org/bot';
export async function telegram(env, method, params) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
  const response = await fetch(`${BASE}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true) {
    throw new Error(`Telegram ${method}: ${response.status}: ${data?.description || 'unexpected response'}`);
  }
  return data.result;
}
export const sendText = (env, chat_id, text, reply_markup) => telegram(env, 'sendMessage', {
  chat_id, text: String(text).slice(0, 4000), ...(reply_markup ? {reply_markup} : {})
});
export const answerCallback = (env, callback_query_id, text) => telegram(env,'answerCallbackQuery',{
  callback_query_id, ...(text ? {text: String(text).slice(0,190)} : {})
});
export async function queueNotification(db, method, params) {
  await db.prepare('INSERT INTO notification_outbox(method,payload) VALUES (?,?)').bind(method, JSON.stringify(params)).run();
}
export async function flushOutbox(db, env, limit = 10) {
  const now = Math.floor(Date.now()/1000);
  const rows = await db.prepare(`SELECT id,method,payload FROM notification_outbox
    WHERE state='pending' OR (state='sending' AND lease_until < ?) ORDER BY id LIMIT ?`)
    .bind(now, limit).all();
  for(const item of rows.results ?? []) {
    const claim = await db.prepare(`UPDATE notification_outbox SET state='sending',lease_until=?,attempts=attempts+1
      WHERE id=? AND (state='pending' OR (state='sending' AND lease_until < ?))`)
      .bind(now+90,item.id,now).run();
    if(!claim.meta?.changes) continue;
    try {
      await telegram(env, item.method, JSON.parse(item.payload));
      await db.prepare("UPDATE notification_outbox SET state='sent' WHERE id=?").bind(item.id).run();
    } catch(error) {
      console.error('Outbox delivery error', item.id, String(error));
      await db.prepare("UPDATE notification_outbox SET state='pending',lease_until=0 WHERE id=?").bind(item.id).run();
    }
  }
}
