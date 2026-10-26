import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentName,paymentButton,extractPaymentEmoji} from '../src/payment-methods.js';
import {adminRoute} from '../src/admin-controls.js';
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
