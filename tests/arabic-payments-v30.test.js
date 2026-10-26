import test from 'node:test';
import assert from 'node:assert/strict';
import {adminRoute} from '../src/admin-controls.js';
import {HOME_BUTTONS} from '../src/home-buttons.js';
import {languageOf,userLanguage} from '../src/i18n.js';
import {splitPhotoCaption} from '../src/product-card.js';
test('payment methods callbacks are recognized for all editable and image actions',()=>{
 for(const key of ['superqi','zain_balance','binance','custom_abc123']){
  for(const callback of ['admin_pay:'+key,'admin_pay_edit:'+key+':ar','admin_pay_edit:'+key+':receiver','admin_pay_edit:'+key+':photo','admin_pay_photo_delete:'+key,'admin_pay_toggle:'+key+':enabled'])
   assert.equal(adminRoute(callback),true,callback);
 }
 assert.equal(adminRoute('admin_pay_add'),true);
});
test('Arabic-only storefront excludes language and retains Messages action',async()=>{
 assert.equal(languageOf({__locale:'en'}),'ar');
 assert.equal(await userLanguage(), 'ar');
 assert.equal(HOME_BUTTONS.some(x=>x.id==='language'),false);
 assert.equal(HOME_BUTTONS.find(x=>x.id==='messages')?.action,'my_support_inbox');
});
