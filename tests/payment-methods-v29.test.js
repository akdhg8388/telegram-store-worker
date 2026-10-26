import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {methodList,paymentMethod,paymentButton,paymentEntities} from '../src/payment-methods.js';
const names=readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^00\d\d_.*\.sql$/.test(x)).sort();
function setup(){
 const conn=new DatabaseSync(':memory:');conn.exec('PRAGMA foreign_keys=ON;');
 for(const n of names)conn.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 const db={prepare(sql){const stmt=conn.prepare(sql);let bind=[];const q={bind(...a){bind=a;return q},async first(){return stmt.get(...bind)||null},async all(){return {results:stmt.all(...bind)}},async run(){const x=stmt.run(...bind);return {meta:{changes:x.changes}}}};return q}};
 return {conn,db};
}
test('V29 methods are gated and editable without changing historical IDs',async()=>{
 const {conn,db}=setup();
 try{
 conn.prepare("INSERT INTO bot_settings(key,value) VALUES('zain_balance_receiver','07700000000')").run();
 let m=await methodList(db,{},{activeOnly:true});
 assert.ok(m.some(x=>x.method_key==='zain_balance'&&x.receiver==='07700000000'));
 assert.equal(m.some(x=>x.method_key==='asiacell'),false);
 conn.prepare("INSERT INTO payment_methods(method_key,name_ar,receiver_ar,enabled,visible) VALUES('custom_test','وسيلة أخرى','123',1,1)").run();
 const x=await paymentMethod(db,{},'custom_test'); assert.equal(x.receiver,'123');
 assert.ok((await methodList(db,{},{activeOnly:true})).some(x=>x.method_key==='custom_test'));
 const btn=paymentButton({...x,icon_custom_emoji_id:'5400000000000000099',icon_fallback:'💎'},'ar','topup_method:custom_test:nonce');
 assert.equal(btn.icon_custom_emoji_id,'5400000000000000099');
 assert.equal(btn._emoji_fallback_text,'💎 وسيلة أخرى');
 assert.equal(JSON.parse(paymentEntities('💎 حساب',{entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5400000000000000099'}]})).length,1);
 assert.equal(conn.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get().n,0);
 }finally{conn.close()}
});
test('V29 migration preserves settled and pending wallet topups and admin references',()=>{
 const c=new DatabaseSync(':memory:');c.exec('PRAGMA foreign_keys=ON;');
 try{
 for(const n of names.filter(x=>!x.startsWith('0017_')))c.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 c.exec("INSERT INTO users(tg_id,first_name) VALUES(101,'Customer'),(991,'Owner')");
 c.exec("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES(101,25000,'topup','prior-credit')");
 c.exec("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference,status) VALUES(101,'superqi',12000,'ref-1','pending')");
 c.exec("INSERT INTO topup_admin_messages(admin_tg_id,topup_id,message_id) VALUES(991,1,558)");
 c.exec(readFileSync(new URL('../migrations/0017_payment_methods.sql',import.meta.url),'utf8'));
 assert.equal(c.prepare("SELECT wallet_balance_iqd AS n FROM users WHERE tg_id=101").get().n,25000);
 assert.equal(c.prepare('SELECT method FROM topup_requests WHERE id=1').get().method,'superqi');
 assert.equal(c.prepare('SELECT topup_id FROM topup_admin_messages WHERE message_id=558').get().topup_id,1);
 assert.equal(c.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get().n,0);
 c.exec("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES(101,'custom_new',1000,'ref-2')");
 assert.equal(c.prepare("SELECT method FROM topup_requests WHERE id=2").get().method,'custom_new');
 }finally{c.close()}
});
