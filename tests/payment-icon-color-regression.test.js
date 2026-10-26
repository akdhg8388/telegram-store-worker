import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentName,paymentButton,extractPaymentEmoji} from '../src/payment-methods.js';
import {adminRoute,handleAdminCallback,handleAdminText} from '../src/admin-controls.js';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {setSession} from '../src/database.js';
import {homeActionButton,homeSettingKey} from '../src/home-buttons.js';

test('payment icon is displayed once even for old names containing emoji',()=>{
 const m={name_ar:'رايزر جولد عالمي 🪙',icon_custom_emoji_id:'5400000000000000099',icon_fallback:'🪙'};
 assert.equal(paymentName(m),'رايزر جولد عالمي');
 const b=paymentButton(m,'ar','topup_method:custom_test:q');
 assert.equal(b.text,'رايزر جولد عالمي');
 assert.equal(b.icon_custom_emoji_id,m.icon_custom_emoji_id);
 assert.equal(b._emoji_fallback_text,'🪙 رايزر جولد عالمي');
 assert.equal(paymentName({...m,name_ar:'🪙 رايزر جولد عالمي 🪙'}),'رايزر جولد عالمي');
 assert.equal(paymentName({...m,name_ar:'📱 رصيد زين'}),'رصيد زين');
 assert.equal(paymentName({...m,icon_custom_emoji_id:null,name_ar:'🪙 رايزر جولد عالمي'}),'🪙 رايزر جولد عالمي');
});
test('admin routes icon actions and home color picker',()=>{
 const id='5400000000000000099';
 assert.equal(extractPaymentEmoji({text:'🪙',entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:id}]}).id,id);
 assert.equal(adminRoute('admin_pay_edit:custom_test:icon'),true);
 assert.equal(adminRoute('admin_pay_icon_delete:custom_test'),true);
 assert.equal(adminRoute('admin_home_button_color:shop'),true);
 for(const color of ['primary','success','danger','default'])assert.equal(adminRoute('admin_home_button_color:shop:'+color),true);
 assert.equal(homeActionButton({[homeSettingKey('shop','color')]:'success'},'shop').style,'success');
 assert.equal(homeActionButton({[homeSettingKey('shop','color')]:'danger'},'shop').style,'danger');
 assert.equal(homeActionButton({[homeSettingKey('shop','color')]:'default'},'shop').style,undefined);
});

test('ordinary static emoji renders once with an independent fallback',()=>{
 const method={method_key:'custom_static',name_ar:'🪙 رايزر جولد عالمي',icon_fallback:'🪙',icon_custom_emoji_id:null};
 assert.equal(paymentName(method),'رايزر جولد عالمي');
 const button=paymentButton(method,'ar','topup_method:custom_static:q');
 assert.equal(button.text,'🪙 رايزر جولد عالمي');
 assert.equal(button.icon_custom_emoji_id,undefined);
 assert.equal(paymentButton({...method,name_ar:'رايزر جولد عالمي'},'ar','x').text,'🪙 رايزر جولد عالمي');
});

function fixture(){
 const conn=new DatabaseSync(':memory:');
 for(const n of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort())
   conn.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 conn.prepare("INSERT INTO users(tg_id,first_name) VALUES (991,'Owner')").run();
 conn.prepare("INSERT INTO payment_methods(method_key,name_ar,enabled,visible) VALUES ('custom_static','رايزر جولد عالمي',1,1)").run();
 const db={prepare(sql){const stmt=conn.prepare(sql);let args=[];const q={
   bind(...v){args=v;return q},
   async first(){return stmt.get(...args)||null},
   async all(){return {results:stmt.all(...args)}},
   async run(){const r=stmt.run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}
 };return q}};
 return {conn,db};
}
async function fakeTelegram(action,{unchanged=false}={}){
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
   const method=String(url).split('/').pop(),data=JSON.parse(init.body);
   calls.push({method,data});
   if(unchanged&&method==='editMessageText')
     return new Response(JSON.stringify({ok:false,description:'Bad Request: message is not modified'}),{status:400});
   return new Response(JSON.stringify({ok:true,result:{message_id:12}}),{status:200});
 };
 try{await action(calls)}finally{globalThis.fetch=original}
}
const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'TEST'};
test('unchanged home color palette never falls through to unsupported button',async()=>{
 const {conn,db}=fixture();
 try{await fakeTelegram(async calls=>{
   const handled=await handleAdminCallback(db,env,991,'admin_home_button_color:shop:success',22);
   assert.equal(handled,true);
   assert.equal(conn.prepare("SELECT value FROM bot_settings WHERE key='home_button_shop_color'").get().value,'success');
   assert.equal(calls.some(c=>c.data.text?.includes('غير مدعوم')),false);
 },{unchanged:true});}finally{conn.close()}
});
test('payment icon accepts both static Telegram custom emoji and ordinary static emoji',async()=>{
 const {conn,db}=fixture();
 try{await fakeTelegram(async()=>{
   const id='5400000000000000099';
   await setSession(db,991,'owner_pay_edit',{key:'custom_static',field:'icon'});
   assert.equal(await handleAdminText(db,env,991,{action:'owner_pay_edit',payload:{key:'custom_static',field:'icon'}},
     {text:'🪙',entities:[{type:'custom_emoji',offset:0,length:2,custom_emoji_id:id}]}),true);
   let m=conn.prepare("SELECT * FROM payment_methods WHERE method_key='custom_static'").get();
   assert.equal(m.icon_custom_emoji_id,id);
   assert.equal(paymentButton(m,'ar','x').text,'رايزر جولد عالمي');
   await setSession(db,991,'owner_pay_edit',{key:'custom_static',field:'icon'});
   assert.equal(await handleAdminText(db,env,991,{action:'owner_pay_edit',payload:{key:'custom_static',field:'icon'}},{text:'🪙'}),true);
   m=conn.prepare("SELECT * FROM payment_methods WHERE method_key='custom_static'").get();
   assert.equal(m.icon_custom_emoji_id,null);
   assert.equal(m.icon_fallback,'🪙');
   assert.equal(paymentButton(m,'ar','x').text,'🪙 رايزر جولد عالمي');
 });}finally{conn.close()}
});
