import test from 'node:test';
import assert from 'node:assert/strict';
import {homeActionButton} from '../src/home-buttons.js';
import {richHomeNeeded,richHomeButton,richHomeMessage,richHomeText} from '../src/rich-home.js';
import {sendOrEditRichHome} from '../src/telegram.js';
const emojiId='5400000000000000077';
const arabic={
  home_button_shop_label_ar:'💳متجر',
  home_button_shop_icon:emojiId,
  home_button_shop_inline_ar:'💳'
};
const english={
  home_button_shop_label_en:'Shop 💳',
  home_button_shop_icon:emojiId,
  home_button_shop_inline_en:'💳'
};
const env={TELEGRAM_BOT_TOKEN:'MOCK',__locale:'ar'};

test('V16: custom emoji at start stays first RichText element in an RTL home button',()=>{
  const button=homeActionButton(arabic,'shop','ar','success');
  assert.equal(richHomeNeeded([[button]]),true);
  const rich=richHomeMessage('أهلاً بك',[],[[button]]);
  assert.equal(rich.is_rtl,true);
  const row=rich.blocks[1];
  assert.equal(row.type,'buttons');
  assert.equal(row.buttons[0].callback_data,'categories');
  assert.equal(row.buttons[0].style,'success');
  assert.deepEqual(row.buttons[0].text,[
    {type:'custom_emoji',custom_emoji_id:emojiId,alternative_text:'💳'},
    'متجر'
  ]);
  assert.equal(row.buttons[0].icon_custom_emoji_id,undefined);
});
test('V16: rich labels preserve end placement and ordinary buttons stay unchanged',()=>{
  const atEnd=richHomeButton(homeActionButton(english,'shop','en'));
  assert.deepEqual(atEnd.text,['Shop ','',{type:'custom_emoji',custom_emoji_id:emojiId,alternative_text:'💳'}].filter(x=>x!==''));
  const ordinary=richHomeButton({text:'📦 طلباتي',callback_data:'orders',style:'primary'});
  assert.deepEqual(ordinary,{text:'📦 طلباتي',callback_data:'orders',style:'primary'});
  assert.equal(richHomeNeeded([[homeActionButton(english,'shop','en')]]),false);
});
test('V16: message entities preserve greeting bold and embedded custom emojis',()=>{
  const rich=richHomeText('👋 أهلاً بك',[
    {type:'bold',offset:0,length:11},
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:emojiId}
  ]);
  assert.equal(rich[0].type,'bold');
  assert.equal(rich[0].text.type,'custom_emoji');
  assert.equal(rich[0].text.alternative_text,'👋');
  assert.equal(rich[1].type,'bold');
});
async function mock(fn,fail){
  const old=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{
    const method=url.split('/').at(-1),body=JSON.parse(init.body);
    calls.push({method,body});
    if(method===fail)return new Response(JSON.stringify({ok:false,description:'Bad Request: rich message unsupported'}),{status:400});
    return new Response(JSON.stringify({ok:true,result:{message_id:100}}),{status:200});
  };
  try{await fn(calls)}finally{globalThis.fetch=old;}
}
test('V16: sendRichMessage 400 falls back to intact V15 inline keyboard',async()=>{
  const b=homeActionButton(arabic,'shop','ar','success'),markup={inline_keyboard:[[b]]};
  const rich=richHomeMessage('مرحباً',[],[[b]]);
  await mock(async calls=>{
    await sendOrEditRichHome(env,123,rich,'مرحباً',markup,null,{});
    assert.deepEqual(calls.map(x=>x.method),['sendRichMessage','sendMessage']);
    assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data,'categories');
  },'sendRichMessage');
});
test('V16: edit previous home in-place and fall back on a 400 without losing callbacks',async()=>{
  const b=homeActionButton(arabic,'shop','ar','success'),markup={inline_keyboard:[[b]]};
  const rich=richHomeMessage('مرحباً',[],[[b]]);
  await mock(async calls=>{
    await sendOrEditRichHome(env,123,rich,'مرحباً',markup,81,{});
    assert.equal(calls[0].method,'editMessageText');
    assert.equal(calls[0].body.message_id,81);
    assert.ok(calls[0].body.rich_message);
    assert.equal(calls[0].body.text,undefined);
    assert.equal(calls[0].body.reply_markup,undefined);
  });
  await mock(async calls=>{
    await sendOrEditRichHome(env,123,rich,'مرحباً',markup,81,{});
    assert.deepEqual(calls.map(x=>x.method),['editMessageText','editMessageText']);
    assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data,'categories');
    assert.equal(calls[1].body.text,'مرحباً');
  },'editMessageText');
});
