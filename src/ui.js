import {button,keyboard,backRow,formatIQD,formatStars,orderNames,short,moneyMethods,urlButton,isAdmin} from './common.js';
import {getUser,listCategories,listProducts,getProduct,listOrders,ledger} from './database.js';
import {sendOrEditText} from './telegram.js';
import {getSetting,storeAcceptsOrders} from './settings.js';
import {USD_PRESETS,formatUSD,formatQuote,usdRate,isTopupEnabled,receiverFor,PAY_METHODS,quoteFromUSD,topupStatus,topupStatusMessage} from './wallet.js';

export async function home(db,env,uid,messageId=null) {
  const user = await getUser(db,uid);
  const featured=(await db.prepare('SELECT id,title,price_stars FROM products WHERE active=1 AND featured=1 ORDER BY id DESC LIMIT 2').all()).results??[];
  const rows = featured.map(p=>[button(`🌟 ${short(p.title,25)} — ${formatStars(p.price_stars)}`,`product:${p.id}`,'success')]);
  rows.push([button('🛍️ المتجر','categories','success'),button('💎 المنتجات المميزة','featured','success')]);
  rows.push([button('💳 محفظتي','wallet','success'),button('👤 ملفي الشخصي','profile','success')]);
  rows.push([button('💱 تغيير العملة 🇮🇶/🇺🇸','currency','primary')]);
  rows.push([button('📦 طلباتي','orders'),button('📜 سجل العمليات','transactions')]);
  rows.push([button('👥 الإحالات','referrals'),button('🌐 اللغة','language')]);
  rows.push([button('🎧 الدعم','support'),button('📢 الأخبار','news')]);
  if(isAdmin(env,uid)) rows.push([button('🛡️ لوحة تحكم المدير','admin','primary')]);
  if (env.RESELLER_URL?.startsWith('https://')) rows.push([urlButton('🔑 API Reseller',env.RESELLER_URL)]);
  const [name,welcome,instructions,open]=await Promise.all([
    getSetting(db,'store_name',env.STORE_NAME||'متجري الرقمي'),
    getSetting(db,'welcome_text',''),getSetting(db,'storefront_instructions',''),storeAcceptsOrders(db)
  ]);
  const text=`🌟 ${short(welcome||`مرحباً بك في ${name}`,1500)}

👤 ${short(user?.first_name||'صديقنا',100)}
اختر الخدمة المطلوبة من القائمة أدناه.${instructions?'\n\n'+short(instructions,1500):''}

${open?'💎 شراء الخدمات الرقمية يتم عبر Telegram Stars بعد موافقة المدير.':'⏸️ استقبال الطلبات الجديدة متوقف مؤقتاً.'}`;
  return sendOrEditText(env,uid,text,keyboard(...rows),messageId);
}
export async function categories(db,env,uid,messageId=null) {
  const cats=await listCategories(db);
  const rows=[];
  for(let i=0;i<cats.length;i+=3) rows.push(cats.slice(i,i+3).map(c=>button(`${c.emoji} ${short(c.title,16)}`,`category:${c.id}:0`,'primary')));
  rows.push([button('🔎 البحث','search','primary'),button('🛍️ جميع المنتجات','products:0','success')]);
  rows.push(backRow());
  return sendOrEditText(env,uid,'🛍️ أقسام المتجر\n\nاختر القسم الذي تريده:',keyboard(...rows),messageId);
}
export async function products(db,env,uid,page=0,categoryId=null,query=null,featuredOnly=false,messageId=null) {
  let records;
  if(featuredOnly){records=(await db.prepare('SELECT * FROM products WHERE active=1 AND featured=1 ORDER BY id DESC LIMIT 10').all()).results??[];}
  else records=await listProducts(db,page,categoryId,query);
  const rows=records.map(p=>[button(`${p.stock===0?'🔴':'🟢'} ${short(p.title,29)} — ${formatStars(p.price_stars)} • ${p.stock===null?'حسب الطلب':p.stock}`,`product:${p.id}`,p.stock===0?'danger':'success')]);
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
  if(!p)return sendOrEditText(env,uid,'هذا المنتج غير متوفر حالياً.',keyboard([button('🛍️ المتجر','categories')],backRow()),messageId);
  const fav=await db.prepare('SELECT 1 AS yes FROM favorites WHERE user_tg_id=? AND product_id=?').bind(uid,id).first();
  const desc=short(p.description||'لا يوجد وصف إضافي.',1300);
  const purchaseInstructions=await getSetting(db,'purchase_instructions','');
  const available=p.stock!==0;
  const stockText=available?`🟢 متوفر • المخزون: ${p.stock===null?'حسب الطلب':p.stock}`:'🔴 غير متوفر • المخزون: 0';
  const text=`🛍️ ${short(p.title,150)}\n\n${desc}\n\n⏳ المدة: ${p.duration_months?p.duration_months+' شهر':'حسب تفاصيل الخدمة'}\n💰 السعر: ${formatStars(p.price_stars)}\n📦 ${stockText}\n\n${available?'✅ الشراء بموافقة المدير ثم الدفع عبر Telegram Stars.':'⛔ نفد المخزون حالياً. يمكنك تحديث حالة المنتج لاحقاً.'}${purchaseInstructions?'\n\n'+short(purchaseInstructions,700):''}`;
  return sendOrEditText(env,uid,text,keyboard(
    [button(stockText,`product:${id}`,available?'success':'danger')],
    available?[button('🛒 طلب الشراء',`buy:${id}`,'success')]:[],
    [button(fav?'💔 إزالة من المفضلة':'💗 إضافة للمفضلة',`favorite:${id}`,'primary')],
    [button('🔄 تحديث المخزون',`product:${id}`,'primary'),button('🛍️ الأقسام','categories','primary')],backRow()),messageId);
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
    db.prepare("SELECT count(*) n FROM orders WHERE user_tg_id=? AND status='delivered'").bind(uid).first(),
    db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first(),
    walletSummary(db,uid)
  ]);
  const role=isAdmin(env,uid)?'◀المسؤول▶':short(u?.first_name||'العميل',60);
  return sendOrEditText(env,uid,`👤 الملف الشخصي — ${role}\n\n🪪 المعرّف — ${uid}\n💳 الرصيد — ${w.shown}\n👥 الإحالات — ${referrals?.n||0}\n🛒 المنتجات المشتراة — ${count?.n||0}`,keyboard(
    [button('💳 شحن الرصيد','topup','success')],
    [button('📦 طلباتي','orders','primary')],
    [button('📑 سجل العمليات','transactions','primary')],
    [button('💗 المفضلة','favorites','primary')],backRow()),messageId);
}
export async function wallet(db,env,uid,messageId=null){
  const w=await walletSummary(db,uid);
  const enabled=await isTopupEnabled(db,env);
  const rows=[[button('💳 شحن المحفظة','topup',enabled?'success':'primary')],
    [button('🗂️ طلبات الشحن','orders','primary'),button('📜 سجل المحفظة','transactions','primary')],
    [button('🌐 تغيير العملة','currency','primary')],backRow()];
  return sendOrEditText(env,uid,`💳 محفظتي\n\n💰 رصيدك: ${w.shown}\n🏷️ عملة العرض: ${w.currency}\n${w.rate?'💱 السعر المعتمد: 1 USD = '+formatIQD(w.rate):'⚠️ يحتاج عرض الدولار إلى تحديد سعر الصرف من المدير.'}\n\n${enabled?'✅ يمكنك إرسال طلب شحن لمراجعته من الإدارة.':'⏳ شحن المحفظة لم يُفعّل من الإدارة بعد.'}\n\n🔒 لا يُضاف أي رصيد حتى يؤكد المدير وصول التحويل.`,keyboard(...rows),messageId);
}
export async function transactions(db,env,uid,messageId=null){
  const entries=await ledger(db,uid);
  const w=await walletSummary(db,uid);
  const text=entries.length?entries.map(e=>`#${e.id} | ${e.delta_iqd>0?'+':''}${formatIQD(e.delta_iqd)}${w.currency==='USD' && w.rate?' (≈ '+formatUSD(Math.round(e.delta_iqd*100/w.rate))+' بسعر اليوم المحدد من الإدارة)':''} | ${e.kind} | ${e.created_at}`).join('\n'):'لا توجد عمليات داخلية مسجلة حتى الآن.';
  return sendOrEditText(env,uid,`📜 سجل المحفظة\n\n${text}`,keyboard(backRow()),messageId);
}
export async function orders(db,env,uid,messageId=null){
  const items=await listOrders(db,uid);
  const txt=items.length?items.map(o=>`#${o.id} | ${short(o.title,36)}\n${formatStars(o.total_stars)} | ${orderNames[o.status]||o.status}`).join('\n\n'):'لم تنشئ أي طلبات بعد.';
  const rows=items.filter(o=>o.status==='awaiting_payment').slice(0,5).map(o=>[button(`💳 ادفع للطلب #${o.id}`,`pay:${o.id}`)]);
  const topups=(await db.prepare('SELECT id,method,amount_iqd,requested_currency,requested_amount_minor,status,created_at FROM topup_requests WHERE user_tg_id=? ORDER BY id DESC LIMIT 10').bind(uid).all()).results??[];
  const topupText=topups.length?topups.map(t=>`#${t.id} • ${formatQuote({currency:t.requested_currency,requestedMinor:t.requested_amount_minor,amountIqd:t.amount_iqd})} • ${topupStatus(t.status)}`).join('\n'):'لا توجد طلبات شحن.';
  rows.push(...topups.slice(0,8).map(t=>[button(`💳 متابعة شحن #${t.id}`,`topup_status:${t.id}`,'primary')]));
  rows.push(backRow());
  return sendOrEditText(env,uid,`📦 طلباتي\n\n🛍️ مشترياتك\n${txt}\n\n💳 طلبات شحن المحفظة\n${topupText}`,keyboard(...rows),messageId);
}
export async function favorites(db,env,uid,messageId=null){
  const items=(await db.prepare('SELECT p.id,p.title,p.price_stars FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.user_tg_id=? AND p.active=1 ORDER BY p.id DESC LIMIT 20').bind(uid).all()).results??[];
  return sendOrEditText(env,uid,items.length?'💗 المفضلة — منتجاتك المحفوظة:':'💗 المفضلة\n\nليس لديك منتجات مفضلة.',keyboard(
    ...items.map(p=>[button(`${short(p.title,35)} — ${formatStars(p.price_stars)}`,`product:${p.id}`)]),backRow()),messageId);
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
