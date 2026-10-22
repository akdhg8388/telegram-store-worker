import {warrantyLine} from './warranty.js';
import {button,keyboard,backRow,formatIQD,formatStars,orderNames,short,moneyMethods,urlButton,isAdmin} from './common.js';
import {getUser,listCategories,listProducts,getProduct,listOrders,ledger} from './database.js';
import {sendOrEditText} from './telegram.js';
import {getSetting,storeAcceptsOrders} from './settings.js';
import {DEFAULT_HOME_TEMPLATE,DEFAULT_HOME_TEMPLATE_EN,renderHomeTemplate,decimalMoney,decoratedMessage,decoratedHome,decorateProductText} from './presentation.js';
import {loadVisualSettings,homeActionButton,homeUrlButton,isHomeButtonVisible,withButtonIcon,emojiId} from './home-buttons.js';
import {languageOf,choice,translateUi} from './i18n.js';
import {USD_PRESETS,formatUSD,formatQuote,usdRate,isTopupEnabled,receiverFor,PAY_METHODS,quoteFromUSD,topupStatus,topupStatusMessage,validRate} from './wallet.js';
import {purchaseAvailability,priceDisplay} from './wallet-purchase.js';
import {sendPhotoCard,cardEntities} from './product-card.js';
import {isMaintenanceButtonEnabled} from './maintenance.js';

export async function home(db,env,uid,messageId=null) {
  const lang=languageOf(env);
  // Fetch button configurations and welcome settings together. This replaces
  // repeated per-button D1 queries and retains the owner's saved overrides.
  const [user,featuredRow,visual,count]=await Promise.all([
    getUser(db,uid),
    db.prepare('SELECT * FROM products WHERE active=1 AND featured=1 AND price_iqd IS NOT NULL ORDER BY id DESC LIMIT 2').all(),
    loadVisualSettings(db),
    db.prepare('SELECT COUNT(*) AS n FROM users').first()
  ]);
  const featured=featuredRow.results??[];
  const rate=validRate(visual.usd_rate_iqd);
  const display=amount=>user?.currency_preference==='USD'&&rate
    ?formatUSD(Math.round(Number(amount)*100/rate)):formatIQD(amount);
  const rows=[];
  const homeButton=(id,style='primary')=>isHomeButtonVisible(visual,id)?homeActionButton(visual,id,lang,style):null;
  for(const p of featured)rows.push([withButtonIcon(button(`🌟 ${short(lang==='en'&&p.title_en||p.title,25)} — ${display(p.price_iqd)}`,`product:${p.id}`,'success'),p.custom_emoji_id||visual.product_custom_emoji_id)]);
  rows.push([homeButton('shop','success'),homeButton('featured','success')]);
  rows.push([homeButton('wallet','success'),homeButton('profile','success')]);
  rows.push([homeButton('currency')]);
  rows.push([homeButton('orders'),homeButton('transactions')]);
  rows.push([homeButton('messages','primary')]); // Telegram accent/blue varies by theme.
  rows.push([homeButton('referrals'),homeButton('language')]);
  // Reuse the existing bulk settings query (no additional D1 call).
  // A configured channel is a native Telegram URL button: one tap opens it,
  // without a news callback round trip or a second tap on a text link.
  const newsUrl=String(Object.hasOwn(visual,'news_url')?visual.news_url:(env.NEWS_URL||'')).trim();
  const directNews=isHomeButtonVisible(visual,'news') && !isMaintenanceButtonEnabled(visual,'news') && /^https:\/\/[^\s]+$/i.test(newsUrl)
    ?homeUrlButton(visual,'news',newsUrl,lang):homeButton('news');
  rows.push([homeButton('support'),directNews]);
  if(isAdmin(env,uid))rows.push([homeButton('admin')]);
  if(env.RESELLER_URL?.startsWith('https://')&&isHomeButtonVisible(visual,'reseller'))rows.push([homeUrlButton(visual,'reseller',env.RESELLER_URL,lang)]);
  const adjustment=/^-?\d+$/.test(visual.users_display_adjustment||'0') ? Number(visual.users_display_adjustment||0):0;
  const shownUsers=Math.max(0,Number(count?.n||0)+adjustment);
  const balance=Number(user?.wallet_balance_iqd||0);
  const values={
    store:short(visual.store_name||env.STORE_NAME||'My Store',80),name:short(user?.first_name||choice(env,'مستخدم','User'),120),
    id:String(uid),users:shownUsers.toLocaleString('en-US'),
    balance:user?.currency_preference==='USD'?(rate?'$'+decimalMoney(balance/rate):'$—'):'IQD '+Number(balance).toLocaleString('en-US'),
    balance_iqd:decimalMoney(balance),balance_usd:rate?decimalMoney(balance/rate):choice(env,'غير محدد','Not configured'),
    instructions:short(visual.storefront_instructions||'',1200)
  };
  const template=lang==='en'?(visual.home_template_en||DEFAULT_HOME_TEMPLATE_EN):(visual.home_template||DEFAULT_HOME_TEMPLATE);
  const decorated=await decoratedHome(db,renderHomeTemplate(template,values),visual.home_custom_emoji_id||'');
  return sendOrEditText(env,uid,decorated.text,keyboard(...rows.map(row=>row.filter(Boolean))),messageId,{...decorated.options,preserveText:lang==='en'});
}
export async function categories(db,env,uid,messageId=null) {
  const cats=await listCategories(db);
  const rows=[];
  for(let i=0;i<cats.length;i+=3) rows.push(cats.slice(i,i+3).map(c=>button(`${c.emoji} ${short(languageOf(env)==='en'&&c.title_en||c.title,16)}`,`category:${c.id}:0`,'primary')));
  rows.push([button('🔎 البحث','search','primary'),button('🛍️ جميع المنتجات','products:0','success')]);
  rows.push(backRow());
  const decorated=await decoratedMessage(db,'shop','🛍️ أقسام المتجر\n\nاختر القسم الذي تريده:');
  return sendOrEditText(env,uid,decorated.text,keyboard(...rows),messageId,decorated.options);
}
export async function products(db,env,uid,page=0,categoryId=null,query=null,featuredOnly=false,messageId=null) {
  let records;
  if(featuredOnly){records=(await db.prepare('SELECT * FROM products WHERE active=1 AND featured=1 ORDER BY id DESC LIMIT 10').all()).results??[];}
  else records=await listProducts(db,page,categoryId,query);
  const rows=[];
  // Read currency/rate once per page; independent inventory checks run concurrently.
  const currency=await getUser(db,uid);
  const rate=currency?.currency_preference==='USD'?await usdRate(db):null;
  const [statuses,visual]=await Promise.all([Promise.all(records.map(p=>purchaseAvailability(db,p))),loadVisualSettings(db)]);
  records.forEach((p,index)=>{
    const available=statuses[index];
    const value=p.price_iqd?(rate?formatUSD(Math.round(p.price_iqd*100/rate)):formatIQD(p.price_iqd)):choice(env,'غير مسعّر','Not priced');
    rows.push([withButtonIcon(button(`${available.ready?'🟢':'🔴'} ${short(languageOf(env)==='en'&&p.title_en||p.title,29)} — ${value} • ${available.ready?(available.count??choice(env,'متوفر','Available')):choice(env,'غير متاح','Unavailable')}`,`product:${p.id}`,available.ready?'success':'danger'),p.custom_emoji_id||visual.product_custom_emoji_id)]);
  });
  if(!featuredOnly && !query){
    const pages=[];
    const prefix=categoryId?`category:${categoryId}`:'products';
    if(page>0)pages.push(button('⬅️ السابق',`${prefix}:${page-1}`));
    if(records.length===10)pages.push(button('التالي ➡️',`${prefix}:${page+1}`));
    if(pages.length)rows.push(pages);
  }
  rows.push([button('🔎 بحث','search'),button('🛍️ الأقسام','categories')]);
  rows.push(backRow());
  return sendOrEditText(env,uid,records.length?'🛍️ المنتجات المتوفرة في المتجر:':'لا توجد منتجات منشورة هنا حالياً.',keyboard(...rows),messageId);
}
export async function productView(db,env,uid,id,messageId=null){
  const p=await getProduct(db,id);
  if(!p)return sendOrEditText(env,uid,choice(env,'هذا المنتج غير متوفر حالياً.','This product is currently unavailable.'),keyboard([button('🛍️ المتجر','categories')],backRow()),messageId);
  const [fav,visual,user,status]=await Promise.all([
    db.prepare('SELECT 1 AS yes FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,id).first(),
    loadVisualSettings(db),getUser(db,uid),purchaseAvailability(db,p)
  ]);
  const desc=short((languageOf(env)==='en'&&p.description_en)||p.description||choice(env,'لا يوجد وصف إضافي.','No additional description.'),1300);
  const icon=p.custom_emoji_id||visual.product_custom_emoji_id;
  const stockText=status.ready?`🟢 ${choice(env,'متوفر • المخزون الجاهز:','Available • Ready stock:')} ${status.count??choice(env,'متاح','Available')}`:`🔴 ${choice(env,'غير متوفر •','Unavailable •')} ${languageOf(env)==='en'?translateUi(status.reason,'en'):status.reason}`;
  const rate=validRate(visual.usd_rate_iqd);
  const shown=p.price_iqd?(user?.currency_preference==='USD'&&rate?formatUSD(Math.round(p.price_iqd*100/rate)):formatIQD(p.price_iqd)):choice(env,'لم يحدد','Not specified');
  const en=languageOf(env)==='en';
  const title=short(en&&p.title_en||p.title,150);
  const how=short(en&&p.usage_instructions_en||p.usage_instructions||choice(env,'لم تُضف تعليمات بعد.','No usage instructions provided.'),1800);
  const mode=p.fulfillment_mode==='unique'
    ?choice(env,'🔑 تسليم كود أو رابط فريد','🔑 Unique code or link')
    :p.fulfillment_mode==='shared'
      ?choice(env,'📦 تسليم محتوى رقمي','📦 Digital content delivery')
      :choice(env,'⏸️ غير مفعّل','⏸️ Disabled');
  const priceLabel=choice(env,'💰 السعر:','💰 Price:');
  const stockLabel=choice(env,'📦 المخزون:','📦 Stock:');
  const deliveryLabel=choice(env,'🚚 نوع التسليم:','🚚 Delivery type:');
  const howLabel=choice(env,'📖 التعليمات:','📖 Instructions:');
  const detailLabel=choice(env,'📝 التفاصيل:','📝 Details:');
  const durationLabel=choice(env,'⏳ المدة:','⏳ Duration:');
  const text=[
    '🛍️ '+title,'',detailLabel+'\n'+desc,'',
    howLabel+'\n'+how,'',deliveryLabel+' '+mode,
    durationLabel+' '+(p.duration_months?p.duration_months+(en?' month(s)':' شهر'):choice(env,'حسب تفاصيل الخدمة','As specified for the service')),
    priceLabel+' '+shown,stockLabel+' '+stockText,'',
    status.ready?choice(env,'✅ يُسلّم المنتج تلقائياً بعد الدفع بالمحفظة.','✅ Delivered automatically after wallet payment.'):
      choice(env,'⛔ المنتج غير جاهز للشراء حالياً.','⛔ This product is not currently available for purchase.'),
    visual.purchase_instructions?'\n'+short(visual.purchase_instructions,700):''
  ].filter(x=>x!==null&&x!==undefined).join('\n');
  const warranty=warrantyLine(p,languageOf(env));
  const decorated=decorateProductText(warranty?text+'\n\n'+warranty:text,{product:emojiId(icon),price:emojiId(visual.price_custom_emoji_id),stock:emojiId(visual.stock_custom_emoji_id)});
  const markup=keyboard(
    [withButtonIcon(button(stockText,`product:${id}`,status.ready?'success':'danger'),visual.stock_custom_emoji_id)],
    status.ready?[withButtonIcon(button('🛒 شراء فوري من المحفظة',`buy:${id}`,'success'),icon)]:[],
    [button(fav?'💔 إزالة من المفضلة':'💗 إضافة للمفضلة',`favorite:${id}`,'primary')],
    [button('🔄 تحديث المخزون',`product:${id}`,'primary'),button('🛍️ الأقسام','categories','primary')],backRow());
  const entities=cardEntities(decorated.text,[priceLabel,stockLabel,deliveryLabel,durationLabel],decorated.options?.entities||[]);
  return sendPhotoCard(env,uid,p.photo_file_id,decorated.text,markup,{messageId,entities,preserveText:en});
}
export async function walletSummary(db,uid){
  const u=await getUser(db,uid);
  const currency=u?.currency_preference||'IQD';
  const rate=await usdRate(db);
  const walletIqd=Number(u?.wallet_balance_iqd||0);
  const shown=currency==='USD' ? (rate ? formatUSD(Math.round(walletIqd*100/rate)) : 'الدولار غير مهيأ بعد') : formatIQD(walletIqd);
  return {currency,rate,walletIqd,shown};
}
export async function currencyMenu(db,env,uid,messageId=null){
  const {currency,rate}=await walletSummary(db,uid);
  const note=rate?`💱 السعر المعتمد من الإدارة: 1 USD = ${formatIQD(rate)}`:'⚠️ سعر الصرف لم يُحدد بعد من الإدارة؛ لن تظهر أرقام تحويل تخمينية.';
  return sendOrEditText(env,uid,`🌐 اختر عملة عرض المحفظة والشحن\n\nالحالية: ${currency}\n${note}\n\nلا يؤدي اختيار العملة إلى تحويل الرصيد أو إنشاء أموال جديدة.`,keyboard(
    [button('🇮🇶 الدينار العراقي IQD','currency_set:IQD','success')],
    [button('🇺🇸 الدولار الأمريكي USD','currency_set:USD','primary')],backRow()),messageId);
}
export async function profile(db,env,uid,messageId=null){
  const u=await getUser(db,uid);
  const [count,referrals,w]=await Promise.all([
    db.prepare("SELECT (SELECT count(*) FROM wallet_purchases WHERE user_tg_id=?) + (SELECT count(*) FROM orders WHERE user_tg_id=? AND status='delivered') AS n").bind(uid,uid).first(),
    db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first(),
    walletSummary(db,uid)
  ]);
  const role=isAdmin(env,uid)?'◀المسؤول▶':short(u?.first_name||'العميل',60);
  const profileText=`👤 الملف الشخصي — ${role}\n\n🪪 المعرّف — ${uid}\n💳 الرصيد — ${w.shown}\n👥 الإحالات — ${referrals?.n||0}\n🛒 المنتجات المشتراة — ${count?.n||0}`;
  const decorated=await decoratedMessage(db,'profile',profileText);
  return sendOrEditText(env,uid,decorated.text,keyboard(
    [button('💳 شحن الرصيد','topup','success')],
    [button('📦 طلباتي','orders','primary')],
    [button('📑 سجل العمليات','transactions','primary')],
    [button('💗 المفضلة','favorites','primary')],backRow()),messageId,decorated.options);
}
export async function wallet(db,env,uid,messageId=null){
  const w=await walletSummary(db,uid);
  const enabled=await isTopupEnabled(db,env);
  const rows=[[button('💳 شحن المحفظة','topup',enabled?'success':'primary')],
    [button('🗂️ طلبات الشحن','orders','primary'),button('📜 سجل المحفظة','transactions','primary')],
    [button('🌐 تغيير العملة','currency','primary')],backRow()];
  const en=languageOf(env)==='en';
  const labels=en?['💰 Your balance:','🏷️ Display currency:','💱 Approved rate:']:['💰 رصيدك:','🏷️ عملة العرض:','💱 السعر المعتمد:'];
  const displayIqd=v=>en?formatIQD(v).replace(' د.ع',' IQD'):formatIQD(v);
  const amount=en?String(w.shown).replace(' د.ع',' IQD').replace('الدولار غير مهيأ بعد','USD exchange rate unavailable'):w.shown;
  const walletText=[
    choice(env,'💳 محفظتي','💳 My Wallet'),
    '',
    labels[0]+' '+amount,
    labels[1]+' '+w.currency,
    labels[2]+' '+(w.rate?'1 USD = '+displayIqd(w.rate):choice(env,'⚠️ لم تحدد الإدارة سعر الصرف بعد.','⚠️ The exchange rate has not yet been configured.')),
    '',
    enabled?choice(env,'✅ يمكنك إرسال طلب شحن لمراجعته من الإدارة.','✅ You can submit a top-up request for review by the support team.'):
      choice(env,'⏳ شحن المحفظة لم يُفعّل من الإدارة بعد.','⏳ Wallet top-ups are currently unavailable.'),
    '',
    choice(env,'🔒 يُعتمد رصيد الشحن بعد مراجعة الإدارة والتحقق من استلام التحويل.','🔒 Top-ups are credited after the administration reviews and verifies the transfer.')
  ].join('\n');
  const decorated=await decoratedMessage(db,'wallet',walletText);
  const boldLabels=labels.map(label=>({type:'bold',offset:decorated.text.indexOf(label),length:label.length}))
    .filter(e=>e.offset>=0);
  const entities=[...(decorated.options?.entities||[]),...boldLabels];
  return sendOrEditText(env,uid,decorated.text,keyboard(...rows),messageId,{entities,preserveText:true});
}
export async function transactions(db,env,uid,messageId=null){
  const entries=await ledger(db,uid);
  const w=await walletSummary(db,uid);
  const text=entries.length?entries.map(e=>`#${e.id} | ${e.delta_iqd>0?'+':''}${formatIQD(e.delta_iqd)}${w.currency==='USD' && w.rate?' (≈ '+formatUSD(Math.round(e.delta_iqd*100/w.rate))+' بسعر اليوم المحدد من الإدارة)':''} | ${e.kind} | ${e.created_at}`).join('\n'):'لا توجد عمليات داخلية مسجلة حتى الآن.';
  return sendOrEditText(env,uid,`📜 سجل المحفظة\n\n${text}`,keyboard(backRow()),messageId);
}
export async function orders(db,env,uid,messageId=null){
  const items=await listOrders(db,uid);
  const txt=items.length?items.map(o=>`#${o.id} | ${short(o.title,36)}\n${orderNames[o.status]||o.status} (طلب بالنظام السابق)`).join('\n\n'):'لا توجد طلبات بالنظام السابق.';
  const rows=[[button('📦 مشترياتي وتسليماتي','wallet_purchases','success')]];
  const topups=(await db.prepare('SELECT id,method,amount_iqd,requested_currency,requested_amount_minor,status,created_at FROM topup_requests WHERE user_tg_id=? ORDER BY id DESC LIMIT 10').bind(uid).all()).results??[];
  const topupText=topups.length?topups.map(t=>`#${t.id} • ${formatQuote({currency:t.requested_currency,requestedMinor:t.requested_amount_minor,amountIqd:t.amount_iqd})} • ${topupStatus(t.status)}`).join('\n'):'لا توجد طلبات شحن.';
  rows.push(...topups.slice(0,8).map(t=>[button(`💳 متابعة شحن #${t.id}`,`topup_status:${t.id}`,'primary')]));
   rows.push(backRow());
  const totalWallet=(await db.prepare('SELECT COUNT(*) AS n FROM wallet_purchases WHERE user_tg_id=?').bind(uid).first())?.n||0;
  const ordersText=`📦 طلباتي\n\n✅ مشتريات المحفظة المسلّمة: ${totalWallet}\nاضغط «مشترياتي وتسليماتي» لعرض المنتجات والصور وتعليمات الاستخدام.\n\n🛍️ الطلبات القديمة\n${txt}\n\n💳 طلبات شحن المحفظة\n${topupText}`;
  const decorated=await decoratedMessage(db,'orders',ordersText);
  return sendOrEditText(env,uid,decorated.text,keyboard(...rows),messageId,decorated.options);
}
export async function favorites(db,env,uid,messageId=null){
  const items=(await db.prepare('SELECT p.id,p.title,p.price_iqd FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.user_tg_id=? AND p.active=1 ORDER BY p.id DESC LIMIT 20').bind(uid).all()).results??[];
  const [user,rate]=await Promise.all([getUser(db,uid),usdRate(db)]);
  const rows=[];for(const item of items){
    const value=item.price_iqd?(user?.currency_preference==='USD'&&rate?formatUSD(Math.round(item.price_iqd*100/rate)):formatIQD(item.price_iqd)):'غير مسعر';
    rows.push([button(`${short(item.title,35)} — ${value}`,`product:${item.id}`)]);
  }
  return sendOrEditText(env,uid,items.length?'💗 المفضلة — منتجاتك المحفوظة:':'💗 المفضلة\n\nليس لديك منتجات مفضلة.',keyboard(...rows,backRow()),messageId);
}
export async function topupPresets(db,env,uid,messageId=null){
  const w=await walletSummary(db,uid);
  if(!w.rate)return sendOrEditText(env,uid,'⚠️ يجب على المدير تحديد سعر صرف الدولار بالدينار من لوحة الإعدادات قبل إنشاء طلبات الشحن.',keyboard([button('💳 محفظتي','wallet','primary')],backRow()),messageId);
  const rows=[];
  for(let i=0;i<USD_PRESETS.length;i+=3){
    rows.push(USD_PRESETS.slice(i,i+3).map(usd=>{
      const q=quoteFromUSD(usd,w.rate,w.currency);
      return button(w.currency==='IQD'?formatIQD(q.amountIqd):`$${usd}`,`topup_preset:${usd}:${w.currency}`,'success');
    }));
  }
  rows.push([button('✏️ أدخل مبلغاً مخصصاً','topup_custom','success')]);
  rows.push([button('💱 تغيير العملة','currency','primary')]);
  rows.push([button('↩️ رجوع','wallet','danger')]);
  return sendOrEditText(env,uid,`💳 شحن المحفظة\n\n💰 الرصيد: ${w.shown}\nاختر المبلغ المطلوب (${w.currency}):\n\n💱 سعر الصرف المعتمد: 1 USD = ${formatIQD(w.rate)}\nسيظهر مبلغ التحويل النهائي قبل التأكيد.`,keyboard(...rows),messageId);
}
export async function topupMethods(db,env,uid,quote,messageId=null){
  const instructions=await getSetting(db,'topup_instructions','');
  const rows=[];
  for(const method of PAY_METHODS){
    if(await receiverFor(db,env,method))rows.push([button('💳 '+moneyMethods[method],`topup_method:${method}:${quote.quoteKey}`,'success')]);
  }
  rows.push([button('↩️ رجوع إلى المبالغ','topup','danger')]);
  const text=`💳 اختيار طريقة الشحن\n\n💰 المبلغ المطلوب: ${formatQuote(quote)}\n\n${rows.length===1?'⚠️ لا توجد طرق شحن مهيأة حالياً. أضف أرقام/حسابات الاستلام من لوحة الإدارة.':'اختر طريقة التحويل من الخيارات المتاحة.'}${instructions?'\n\n'+short(instructions,900):''}`;
  return sendOrEditText(env,uid,text,keyboard(...rows),messageId);
}
export async function topupEvidence(db,env,uid,quote,method,messageId=null){
  const receiver=await receiverFor(db,env,method);
  const instructions=await getSetting(db,'topup_instructions','');
  return sendOrEditText(env,uid,`💳 شحن المحفظة عبر ${moneyMethods[method]}\n\n💰 المبلغ: ${formatQuote(quote)}\n🏦 بيانات الاستلام من الإدارة:\n${short(receiver,700)}\n\n📸 أرسل الآن *رقم التحويل* أو *صورة إثبات الحوالة*.\nستظهر شاشة مراجعة نهائية قبل رفع الطلب للمدير.\n\n⚠️ لا تعتمد على الإيصال وحده؛ المدير يتحقق من وصول المبلغ فعلياً.${instructions?'\n\n'+short(instructions,800):''}`,keyboard([button('↩️ إلغاء الطلب','topup_cancel','danger')]),messageId);
}
export async function topupConfirm(db,env,uid,payload,messageId=null){
  return sendOrEditText(env,uid,`📋 مراجعة طلب شحن المحفظة

💰 المبلغ: ${formatQuote(payload)}
💳 وسيلة الدفع: ${moneyMethods[payload.method]}
🔢 رقم العملية: ${short(payload.reference||'غير متوفر',160)}
📸 إثبات التحويل: ${payload.proofFileId?'✅ مرفق':'غير مرفق'}

يرجى التأكد من صحة البيانات قبل إرسال الطلب.
🔔 ستصلك رسالة عند تحديث حالة الطلب، ويمكنك متابعته من قسم 📦 طلباتي.`,keyboard(
    [button('✅ تأكيد وإرسال الطلب',`topup_submit:${payload.nonce}`,'success')],
    [button('❌ إلغاء','topup_cancel','danger')]),messageId);
}
export async function topupStatusView(db,env,uid,id,messageId=null){
  const record=await db.prepare('SELECT * FROM topup_requests WHERE id=? AND user_tg_id=?').bind(id,uid).first();
  if(!record)return sendOrEditText(env,uid,'لا يوجد طلب شحن بهذا الرقم لحسابك.',keyboard([button('📦 طلباتي','orders','primary')],backRow()),messageId);
  return sendOrEditText(env,uid,topupStatusMessage(record),keyboard(
    [button('🔄 تحديث الحالة',`topup_status:${id}`,'primary')],
    [button('📦 طلباتي','orders','primary')],backRow()),messageId);
}

// The owner contact is an ordinary Telegram URL button. Its visibility and
// destination are editable, but never grants any administrative privileges.
export async function supportMenu(db,env,uid,messageId=null){
  const enabled=await getSetting(db,'support_direct_enabled','false');
  const username=await getSetting(db,'support_direct_username','');
  const label=await getSetting(db,'support_direct_label','👤 تواصل مباشر مع المسؤول');
  const rows=[[button('💬 تواصل مع الدعم الفني','support_compose','primary')]];
  if(enabled==='true' && /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))
    rows.push([urlButton(short(label||'👤 تواصل مباشر مع المسؤول',60),
      'https://t.me/'+username.replace(/^@/,''),'success')]);
  rows.push(backRow());
  return sendOrEditText(env,uid,'🎧 مركز الدعم الفني\n\nاختر طريقة التواصل المناسبة:',keyboard(...rows),messageId);
}
