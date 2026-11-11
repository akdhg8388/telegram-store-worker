import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {guardUser,releaseExpiredSuspensions,restrictionLabel,suspensionDate} from '../src/moderation.js';

function fixture(){
 const conn=new DatabaseSync(':memory:');
 const files=['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql',
  '0004_reference_catalog.sql','0005_persistent_navigation.sql',
  '0006_wallet_checkout.sql','0007_support_moderation_topup.sql'];
 for(const filename of files)conn.exec(readFileSync(new URL('../migrations/'+filename,import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(101,'Buyer'),(102,'Other'),(103,'Banned')").run();
 const db={
  prepare(sql){
   const stmt=conn.prepare(sql);let args=[];
   const q={bind(...v){args=v;return q},async first(){return stmt.get(...args)||null},
    async all(){return {results:stmt.all(...args)}},
    async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}};
   return q;
  },
  async batch(items){
   conn.exec('BEGIN IMMEDIATE');
   try{
    const results=[];
    for(const item of items)results.push(await item.run());
    conn.exec('COMMIT');return results;
   }catch(error){conn.exec('ROLLBACK');throw error}
  }
 };
 return {conn,db};
}
test('suspension ends at exact timestamp and never blocks the customer afterwards',async()=>{
 const {conn,db}=fixture();
 try{
  const now=Math.floor(Date.now()/1000);
  conn.prepare("UPDATE users SET suspended_until=?,restriction_reason='temporary' WHERE tg_id=101").run(now+3600);
  assert.match(await guardUser(db,{ADMIN_ID:'991'},101),/معلّق مؤقتاً/);
  conn.prepare("UPDATE users SET suspended_until=? WHERE tg_id=101").run(now-1);
  assert.equal(await guardUser(db,{ADMIN_ID:'991'},101),null);
  // Expiry is processed by cron, not per-customer request.
  assert.equal(conn.prepare("SELECT suspended_until FROM users WHERE tg_id=101").get().suspended_until,now-1);
  assert.doesNotMatch(restrictionLabel({suspended_until:now+60},now),/بتوقيت بغداد/);
  assert.doesNotMatch(suspensionDate(now),/بتوقيت بغداد/);
 }finally{conn.close()}
});
test('one cron pass releases expired users and queues one professional notice each',async()=>{
 const {conn,db}=fixture();
 try{
  const now=Math.floor(Date.now()/1000);
  conn.prepare("UPDATE users SET suspended_until=?,restriction_reason='reason' WHERE tg_id=101").run(now-2);
  conn.prepare("UPDATE users SET suspended_until=? WHERE tg_id=102").run(now+300);
  conn.prepare("UPDATE users SET is_blocked=1,suspended_until=? WHERE tg_id=103").run(now-2);
  await releaseExpiredSuspensions(db,now);
  await releaseExpiredSuspensions(db,now);
  const notices=conn.prepare("SELECT payload FROM notification_outbox ORDER BY id").all();
  assert.equal(notices.length,1);
  const payload=JSON.parse(notices[0].payload);
  assert.equal(payload.chat_id,101);
  assert.match(payload.text,/Pixel Store/);
  assert.match(payload.text,/انتهاء فترة التعليق المؤقت/);
  assert.equal(conn.prepare("SELECT suspended_until FROM users WHERE tg_id=101").get().suspended_until,null);
  assert.notEqual(conn.prepare("SELECT suspended_until FROM users WHERE tg_id=102").get().suspended_until,null);
  assert.equal(conn.prepare("SELECT is_blocked FROM users WHERE tg_id=103").get().is_blocked,1);
  assert.equal(conn.prepare("SELECT restriction_reason FROM users WHERE tg_id=101").get().restriction_reason,'');
 }finally{conn.close()}
});
test('failed insert rolls back expiry cleanup, preventing lost notifications',async()=>{
 const {conn,db}=fixture();
 try{
  const now=Math.floor(Date.now()/1000);
  conn.prepare("UPDATE users SET suspended_until=? WHERE tg_id=101").run(now-1);
  conn.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await assert.rejects(()=>releaseExpiredSuspensions(db,now),/test failure/);
  assert.equal(conn.prepare("SELECT suspended_until FROM users WHERE tg_id=101").get().suspended_until,now-1);
  conn.exec('DROP TRIGGER reject_notice');
  await releaseExpiredSuspensions(db,now);
  assert.equal(conn.prepare("SELECT COUNT(*) n FROM notification_outbox").get().n,1);
 }finally{conn.close()}
});
test('permanent ban remains locked and displays the new brand',async()=>{
 const {conn,db}=fixture();
 try{
  conn.prepare("UPDATE users SET is_blocked=1 WHERE tg_id=103").run();
  const message=await guardUser(db,{ADMIN_ID:'991'},103);
  assert.match(message,/Pixel Store/);
  assert.doesNotMatch(message,/My Store/);
 }finally{conn.close()}
});
