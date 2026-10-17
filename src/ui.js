import {button,keyboard,backRow,formatIQD,formatStars,orderNames,short,moneyMethods,urlButton,isAdmin} from './common.js';
import {getUser,listCategories,listProducts,getProduct,listOrders,ledger} from './database.js';
import {sendOrEditText} from './telegram.js';
import {getSetting,storeAcceptsOrders} from './settings.js';

export async function home(db,env,uid,messageId=null) {
  const user = await getUser(db,uid);
  const featured=(await db.prepare('SELECT id,title,price_stars FROM products WHERE active=1 AND featured=1 ORDER BY id DESC LIMIT 2').all()).results??[];
  const rows = featured.map(p=>[button(`🌟 ${short(p.title,25)} — ${formatStars(p.price_stars)}`,`product:${p.id}`,'success')]);
  rows.push([button('🛍️ المتجر','categories','success'),button('💎 المنتجات المميزة','featured','primary')]);
  rows.push([button('👛 محفظتي','wallet','success'),button('👤 ملفي الشخصي','profile','primary')]);
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
  const rows=records.map(p=>[button(`${short(p.title,33)} — ${formatStars(p.price_stars)}${p.stock===0?' ❌':''}`,`product:${p.id}`)]);
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
  const text=`🛍️ ${short(p.title,150)}\n\n${desc}\n\n⏳ المدة: ${p.duration_months?p.duration_months+' شهر':'حسب تفاصيل الخدمة'}\n💰 السعر: ${formatStars(p.price_stars)}\n📦 المخزون: ${p.stock===null?'متاح حسب التجهيز':p.stock>0?p.stock:'غير متوفر'}\n\n✅ تنفيذ الشراء يحتاج موافقة المدير، ثم الدفع عبر Telegram Stars.${purchaseInstructions?'\n\n'+short(purchaseInstructions,700):''}`;
  return sendOrEditText(env,uid,text,keyboard(
    p.stock!==0?[button('🛒 طلب الشراء',`buy:${id}`,'success')]:[],
    [button(fav?'💔 إزالة من المفضلة':'💗 إضافة للمفضلة',`favorite:${id}`)],
    [button('🔄 تحديث',`product:${id}`),button('🛍️ الأقسام','categories')],backRow()),messageId);
}
export async function profile(db,env,uid,messageId=null){
  const u=await getUser(db,uid);
  const count=await db.prepare("SELECT count(*) n FROM orders WHERE user_tg_id=? AND status='delivered'").bind(uid).first();
  const referrals=await db.prepare('SELECT count(*) n FROM referrals WHERE referrer_tg_id=?').bind(uid).first();
  return sendOrEditText(env,uid,`👤 الملف الشخصي\n\nالاسم: ${short(u?.first_name,120)}\nالمعرف: ${u?.username?'@'+u.username:'غير موجود'}\nTelegram ID: ${uid}\n👛 الرصيد الداخلي: ${formatIQD(u?.wallet_balance_iqd)}\n🛍️ المشتريات المكتملة: ${count?.n||0}\n👥 الإحالات: ${referrals?.n||0}\n\nتنبيه: الرصيد الداخلي ليس بديلاً عن Telegram Stars للسلع الرقمية.`, keyboard(
    [button('👛 محفظتي','wallet','success')],
    [button('📦 طلباتي','orders','primary')],
    [button('📜 سجل العمليات','transactions','primary')],
    [button('💗 المفضلة','favorites','primary')],backRow()),messageId);
}
export async function wallet(db,env,uid,messageId=null){
  const u=await getUser(db,uid);
  return sendOrEditText(env,uid,`👛 محفظتي\n\n💰 الرصيد الداخلي: ${formatIQD(u?.wallet_balance_iqd)}\n\n⚠️ رصيد المحفظة لا يُستخدم لدفع ثمن الاشتراكات والخدمات الرقمية داخل البوت؛ تلك المدفوعات تتم عبر Telegram Stars.`,keyboard(
    ...(env.ENABLE_MANUAL_TOPUPS==='true' ? [[button('💳 طلب شحن يدوي','topup','success')]] : []),
    [button('📜 سجل المحفظة','transactions'),button('👤 الملف الشخصي','profile')],backRow()),messageId);
}
export async function transactions(db,env,uid,messageId=null){
  const entries=await ledger(db,uid);
  const text=entries.length?entries.map(e=>`#${e.id} | ${e.delta_iqd>0?'+':''}${formatIQD(e.delta_iqd)} | ${e.kind} | ${e.created_at}`).join('\n'):'لا توجد عمليات داخلية مسجلة حتى الآن.';
  return sendOrEditText(env,uid,`📜 سجل المحفظة\n\n${text}`,keyboard(backRow()),messageId);
}
export async function orders(db,env,uid,messageId=null){
  const items=await listOrders(db,uid);
  const txt=items.length?items.map(o=>`#${o.id} | ${short(o.title,36)}\n${formatStars(o.total_stars)} | ${orderNames[o.status]||o.status}`).join('\n\n'):'لم تنشئ أي طلبات بعد.';
  const rows=items.filter(o=>o.status==='awaiting_payment').slice(0,5).map(o=>[button(`💳 ادفع للطلب #${o.id}`,`pay:${o.id}`)]);
  rows.push(backRow());
  return sendOrEditText(env,uid,`📦 طلباتي\n\n${txt}`,keyboard(...rows),messageId);
}
export async function favorites(db,env,uid,messageId=null){
  const items=(await db.prepare('SELECT p.id,p.title,p.price_stars FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.user_tg_id=? AND p.active=1 ORDER BY p.id DESC LIMIT 20').bind(uid).all()).results??[];
  return sendOrEditText(env,uid,items.length?'💗 منتجاتك المفضلة:':'ليس لديك منتجات مفضلة.',keyboard(
    ...items.map(p=>[button(`${short(p.title,35)} — ${formatStars(p.price_stars)}`,`product:${p.id}`)]),backRow()),messageId);
}
export async function topupMethods(db,env,uid,messageId=null){
  const instructions=await getSetting(db,'topup_instructions','');
  return sendOrEditText(env,uid,`💳 طلب شحن المحفظة

اختر وسيلة الشحن اليدوي:${instructions?'\n\n'+short(instructions,1200):''}`,keyboard(
    [button('📱 آسيا سيل','topup_method:asiacell')],
    [button('💰 زين كاش','topup_method:zaincash')],
    [button('🏦 سوبر كي','topup_method:superqi')],backRow()),messageId);
}
export async function topupAmounts(db,env,uid,method,messageId=null){
  const receiverKey={asiacell:'asiacell_receiver',zaincash:'zaincash_receiver',superqi:'superqi_receiver'}[method];
  const fallback={asiacell:env.ASIACELL_RECEIVER,zaincash:env.ZAINCASH_RECEIVER,superqi:env.SUPERQI_RECEIVER}[method];
  const receiver=await getSetting(db,receiverKey,fallback||'');
  return sendOrEditText(env,uid,`💳 الشحن عبر ${moneyMethods[method]}\n\nبيانات الاستلام: ${receiver||'يرجى التواصل مع المدير للحصول عليها'}\n\nيرجى التحقق من وصول المبلغ إلى الحساب الصحيح. اختر مبلغ الشحن المطلوب:`, keyboard(
    [button('10,000 د.ع',`topup_amount:${method}:10000`),button('25,000 د.ع',`topup_amount:${method}:25000`)],
    [button('50,000 د.ع',`topup_amount:${method}:50000`),button('✍️ مبلغ مخصص',`topup_custom:${method}`)],backRow()),messageId);
}
