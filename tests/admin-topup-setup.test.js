import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {getSetting} from '../src/settings.js';
import {isTopupEnabled} from '../src/wallet.js';

const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'FAKE_TEST_BOT_TOKEN',ENABLE_MANUAL_TOPUPS:'false',STORE_NAME:'My Store'};
function fixture(){
  const conn=new DatabaseSync(':memory:');
  for(const n of ['0001_init.sql','0002_admin_controls.sql','0003_reliability.sql','0004_reference_catalog.sql','0005_persistent_navigation.sql','0006_wallet_checkout.sql','0007_support_moderation_topup.sql','0008_custom_ui_customer_inbox_cleanup.sql','0009_wallet_auto_delivery.sql','0010_purchase_views_and_unique_codes.sql','0011_product_visuals.sql'])
    conn.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
  conn.prepare("INSERT INTO users(tg_id,first_name) VALUES(991,'Owner'),(101,'Client')").run();
  const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];const wrapper={
    bind(...values){args=values;return wrapper},
    async first(){return stmt.get(...args)??null},
    async all(){return {results:stmt.all(...args)}},
    async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
  };return wrapper;}};
  return {conn,db};
}
async function recordTelegram(action){
  const prev=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1);
    const body=JSON.parse(init.body);
    calls.push({method,body});
    return new Response(JSON.stringify({ok:true,result:{message_id:888}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try{await action(calls)}finally{globalThis.fetch=prev}
}
async function update(db,update_id,uid,data,messageId=234){
  const pending=[];
  await processUpdate(db,env,{waitUntil(p){pending.push(p)}},
    {update_id,callback_query:{id:'callback-'+update_id,from:{id:uid,first_name:'Test'},data,message:{message_id:messageId,chat:{id:uid,type:'private'}}}});
  await Promise.all(pending);
}
function buttons(call){return call.body.reply_markup?.inline_keyboard?.flat()||[];}

test('owner admin panel has verified owner notice and a direct wallet setup; customers never see it',async()=>{
  const {conn,db}=fixture();try{await recordTelegram(async calls=>{
    await processUpdate(db,env,{waitUntil(){}},{update_id:20,message:{from:{id:991,first_name:'Owner'},chat:{id:991,type:'private'},text:'/admin'}});
    const m=calls.find(c=>c.method==='sendMessage');
    assert.match(m.body.text,/تم التحقق من حساب المدير/);
    assert.doesNotMatch(m.body.text,/الصلاحية محصورة/);
    assert.match(m.body.text,/غير مفعّلة/);
    assert.ok(buttons(m).some(b=>b.callback_data==='admin_topup_setup'));
    await processUpdate(db,env,{waitUntil(){}},{update_id:21,message:{from:{id:101,first_name:'Client'},chat:{id:101,type:'private'},text:'/admin'}});
    assert.match(calls.at(-1).body.text,/خاص بمدير/);
  });}finally{conn.close()}
});

test('owner sees a clear empty topup requests page instead of ambiguous permissions text',async()=>{
  const {conn,db}=fixture();try{await recordTelegram(async calls=>{
    await update(db,22,991,'admin_topups',333);
    const screen=calls.find(c=>c.method==='editMessageText');
    assert.equal(screen.body.message_id,333);
    assert.match(screen.body.text,/لا توجد طلبات شحن معلّقة/);
    assert.ok(buttons(screen).some(b=>b.callback_data==='admin_topups_done'));
  });}finally{conn.close()}
});

test('rate recommendation is explicit, remains admin-only and never changes wallet balances',async()=>{
  const {conn,db}=fixture();try{await recordTelegram(async calls=>{
    await update(db,23,991,'admin_topup_setup');
    const screen=calls.find(c=>c.method==='editMessageText');
    assert.ok(buttons(screen).some(b=>b.callback_data==='admin_rate_1520'));
    assert.match(screen.body.text,/غير مفعّلة|متوقفة/);
    await update(db,24,101,'admin_rate_1520');
    assert.equal(await getSetting(db,'usd_rate_iqd',''), '');
    await update(db,25,991,'admin_rate_1520');
    assert.equal(await getSetting(db,'usd_rate_iqd',''), '1520');
    assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
    assert.equal(await isTopupEnabled(db,env),false);
    assert.equal(conn.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n,0);
    await update(db,26,991,'admin_rate_1520');
    assert.equal(await getSetting(db,'usd_rate_iqd',''), '1520');
    assert.ok(calls.some(c=>c.body.text?.includes('سعر الصرف محدد بالفعل')));
  });}finally{conn.close()}
});

test('topup cannot be enabled without configured receiver; owner can configure and customer sees real presets',async()=>{
  const {conn,db}=fixture();try{await recordTelegram(async calls=>{
    await update(db,27,991,'admin_rate_1520');
    await update(db,28,991,'admin_toggle_topups');
    assert.equal(await isTopupEnabled(db,env),false);
    assert.ok(calls.some(c=>c.body.text?.includes('حساب استلام')));
    await update(db,29,991,'admin_setting_edit:zain_balance_receiver');
    const userSession=conn.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=991').get();
    assert.equal(userSession.action,'owner_setting');
    assert.equal(await handleAdminText(db,env,991,{action:userSession.action,payload:JSON.parse(userSession.payload)},{text:'0770 000 0000'}),true);
    assert.equal(await getSetting(db,'zain_balance_receiver'), '0770 000 0000');
    await update(db,30,991,'admin_toggle_topups');
    assert.equal(await isTopupEnabled(db,env),true);
    await processUpdate(db,env,{waitUntil(){}},{update_id:31,message:{from:{id:101,first_name:'Client'},chat:{id:101,type:'private'},text:'/topup'}});
    const preset=calls.filter(c=>c.method==='sendMessage').at(-1);
    assert.match(preset.body.text,/1 USD = 1,520 د\.ع/);
    assert.ok(buttons(preset).some(b=>b.callback_data==='topup_preset:10:IQD'&&b.text.includes('15,200')));
  });}finally{conn.close()}
});

test('pending receipt becomes reviewable by owner; no unauthorized acceptance',async()=>{
  const {conn,db}=fixture();try{
    conn.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES (101,'zain_balance',15200,'evidence-101')").run();
    await recordTelegram(async calls=>{
      await update(db,32,991,'admin_topups',404);
      assert.ok(calls.some(c=>c.method==='editMessageText'&&c.body.text.includes('معالجة طلبات الشحن')));
      const review=calls.find(c=>c.method==='editMessageText'&&c.body.text?.includes('معالجة طلبات الشحن'));
      assert.ok(review);
      assert.ok(buttons(review).some(b=>b.callback_data==='topup_detail:1'));
      await update(db,34,991,'topup_detail:1');
      const detail=calls.find(c=>c.method==='sendMessage'&&c.body.text?.includes('طلب شحن #1'));
      assert.ok(detail);
      assert.ok(buttons(detail).some(b=>b.callback_data==='topup_approve:1'));
      assert.ok(buttons(detail).some(b=>b.callback_data==='topup_reject:1'));
      await update(db,33,101,'topup_approve:1');
      assert.equal(conn.prepare('SELECT status FROM topup_requests WHERE id=1').get().status,'pending');
      assert.equal(conn.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,0);
    });
  }finally{conn.close()}
});
