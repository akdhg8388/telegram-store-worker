import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';

// Telegram rejects the entire keyboard if even one callback_data exceeds 64 bytes.
function fixture(){
  const conn=new DatabaseSync(':memory:');
  const files=readdirSync(new URL('../migrations/',import.meta.url))
    .filter(name=>/^00\d\d_.*\.sql$/.test(name)).sort();
  for(const name of files)conn.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  conn.prepare("INSERT INTO users(tg_id,first_name,currency_preference) VALUES(101,'Customer','USD')").run();
  conn.prepare("INSERT INTO bot_settings(key,value) VALUES('usd_rate_iqd','1520'),('manual_topups_enabled','true')").run();
  const db={
    prepare(sql){
      const stmt=conn.prepare(sql);
      let args=[];
      const statement={
        bind(...values){args=values;return statement},
        async first(){return stmt.get(...args)??null},
        async all(){return {results:stmt.all(...args)}},
        async run(){
          const r=stmt.run(...args);
          return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}};
        }
      };
      return statement;
    },
    async batch(statements){
      conn.exec('BEGIN');
      try{const result=[];for(const statement of statements)result.push(await statement.run());conn.exec('COMMIT');return result;}
      catch(error){conn.exec('ROLLBACK');throw error;}
    }
  };
  return {conn,db};
}

test('newly added custom payment methods have valid callback lengths in preset and custom amount flows',async()=>{
  const {conn,db}=fixture();
  const previous=globalThis.fetch;
  const calls=[];
  const customKey='custom_'+'a'.repeat(20);
  const longestKey='b'.repeat(32);
  try{
    conn.prepare('INSERT INTO payment_methods(method_key,name_ar,receiver_ar,photo_file_id,enabled,visible) VALUES (?,?,?,?,1,1)')
      .run(customKey,'Tether USDT عبر TON','TEST_TON_ADDRESS','TEST_IMAGE_ID');
    conn.prepare('INSERT INTO payment_methods(method_key,name_ar,receiver_ar,enabled,visible) VALUES (?,?,?,1,1)')
      .run(longestKey,'خيار آخر للتجربة','TEST_RECEIVER');
    globalThis.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);
      calls.push({method:String(url).split('/').at(-1),body});
      const buttons=body.reply_markup?.inline_keyboard?.flat()||[];
      const invalid=buttons.some(b=>typeof b.callback_data==='string'&&Buffer.byteLength(b.callback_data,'utf8')>64);
      if(invalid)return new Response(JSON.stringify({ok:false,description:'Bad Request: BUTTON_DATA_INVALID'}),{status:400});
      return new Response(JSON.stringify({ok:true,result:{message_id:630}}),{status:200});
    };
    const env={ADMIN_ID:'991',TELEGRAM_BOT_TOKEN:'MOCK',ENABLE_MANUAL_TOPUPS:'true'};
    let updateId=5000;
    async function step(body){
      const pending=[];
      await processUpdate(db,env,{waitUntil(p){pending.push(p)}},{
        update_id:++updateId,...body
      });
      await Promise.all(pending);
    }
    const callback=callback_data=>({
      callback_query:{
        id:'cb'+(updateId+1),from:{id:101,first_name:'Customer'},
        message:{message_id:211,chat:{id:101,type:'private'}},data:callback_data
      }
    });
    await step(callback('topup_preset:10:USD'));
    const menus=calls.filter(c=>String(c.body.text||'').includes('اختيار طريقة الشحن'));
    assert.equal(menus.length,1);
    const methodButtons=menus[0].body.reply_markup.inline_keyboard.flat().filter(b=>(b.callback_data||'').startsWith('topup_method:'));
    assert.equal(methodButtons.length,2);
    for(const b of methodButtons){
      assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64, 'callback too long: '+b.callback_data);
    }
    assert.ok(methodButtons.some(b=>b.callback_data.startsWith('topup_method:'+customKey+':')));
    assert.ok(methodButtons.some(b=>b.callback_data.startsWith('topup_method:'+longestKey+':')));
    // Previously the $10 click failed here and no method screen was sent.
    const tonButton=methodButtons.find(b=>b.callback_data.startsWith('topup_method:'+customKey+':'));
    await step(callback(tonButton.callback_data));
    assert.ok(calls.some(c=>c.method==='sendPhoto' && String(c.body.caption).includes('Tether USDT')));

    // The custom-amount path must also use a short token.
    await step(callback('topup_custom'));
    await step({message:{from:{id:101,first_name:'Customer'},chat:{id:101,type:'private'},text:'15.50',message_id:322}});
    const customMenus=calls.filter(c=>String(c.body.text||'').includes('اختيار طريقة الشحن'));
    assert.equal(customMenus.length,2);
    for(const b of customMenus.at(-1).body.reply_markup.inline_keyboard.flat()){
      if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
    }
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n,0);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM topup_requests').get().n,0);
  }finally{globalThis.fetch=previous;conn.close();}
});
