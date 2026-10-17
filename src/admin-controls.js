import {button,keyboard,short,formatStars,formatIQD,positiveInt,isAdmin} from './common.js';
import {sendText,sendOrEditText,telegram} from './telegram.js';
import {updateBotProfilePicture} from './bot-profile.js';
import {setSession,getSession,clearSession,audit,getUser} from './database.js';
import {SETTING_FIELDS,getSetting,validateSetting,updateSetting} from './settings.js';
import {usdRate,receiverFor} from './wallet.js';
import {DEFAULT_HOME_TEMPLATE,DEFAULT_HOME_TEMPLATE_EN,preserveCustomEmojiInTemplate} from './presentation.js';
import {home as customerHomePreview} from './ui.js';
import {restrictionLabel} from './moderation.js';
import {HOME_BUTTONS,ICON_SLOTS,homeSettingKey,productIconKey,loadVisualSettings,resolvedHomeButton} from './home-buttons.js';

const adminBack=[button('🛡️ لوحة المدير','admin')];
const backTo=(destination)=>[button('⬅️ رجوع',destination)];

export function adminRoute(data){
  return /^(?:admin_bot_intro|admin_bot_photo_edit|admin_bot_photo_remove|admin_counter|admin_counter_edit|admin_counter_reset|admin_toggle_support_direct|admin_support_contact|admin_visuals|admin_home_buttons(?::\d+)?|admin_home_button:[a-z_]+|admin_home_button_reset:[a-z_]+|admin_home_reset_all|admin_home_reset_all_confirm|admin_product_icons|admin_product_icon:\d+|admin_visual_preview|admin_visual_reset|admin_visual_reset_confirm|admin_topup_setup|admin_rate_1520|admin_stats|admin_settings(?::\d+)?|admin_setting:[a-z_]+|admin_toggle_store|admin_toggle_topups|admin_products(?::\d+)?|admin_product:\d+|admin_product_field:\d+:[a-z_]+|admin_product_photo:\d+|admin_product_photo_delete:\d+|admin_product_code:\d+|admin_product_mode:\d+:(?:shared|unique|disabled)|admin_product_toggle:\d+:[a-z_]+|admin_product_categories:\d+|admin_product_move:\d+:\d+|admin_manage_categories|admin_category:\d+|admin_category_field:\d+:[a-z_]+|admin_category_toggle:\d+|admin_user_toggle:\d+|admin_find_user|admin_help)$/.test(data);
}

async function homeButtonList(db,env,uid,page=0,messageId=null){
  const visual=await loadVisualSettings(db);
  const rows=[];
  const current=HOME_BUTTONS.slice(page*7,(page+1)*7);
  for(const b of current){
    const shown=resolvedHomeButton(visual,b.id,'ar');
    rows.push([button(`${shown.icon?'✨':'▫️'} ${short(shown.text,35)}`,`admin_home_button:${b.id}`,'primary')]);
  }
  const nav=[];
  if(page)nav.push(button('⬅️ السابق',`admin_home_buttons:${page-1}`));
  if((page+1)*7<HOME_BUTTONS.length)nav.push(button('التالي ➡️',`admin_home_buttons:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([button('↩️ استعادة جميع أسماء ورموز الرئيسية','admin_home_reset_all','danger')]);
  rows.push([button('👁️ معاينة الرئيسية','admin_visual_preview','success')],[button('🎨 تخصيص الواجهة','admin_visuals')],adminBack);
  return sendOrEditText(env,uid,'🎨 تخصيص أزرار الرئيسية\n\nاختر الزر لتعديل اسمه بالعربي والإنجليزي ورمزه المتحرك، بدون تغيير وظيفته.',keyboard(...rows),messageId);
}
async function homeButtonDetail(db,env,uid,key,messageId=null){
  const def=HOME_BUTTONS.find(x=>x.id===key);
  if(!def)return;
  const visual=await loadVisualSettings(db);
  const ar=resolvedHomeButton(visual,key,'ar');
  const en=resolvedHomeButton(visual,key,'en');
  return sendOrEditText(env,uid,`🎨 تخصيص الزر: ${def.ar}\n\n🇮🇶 العربي: ${ar.text}\n🇬🇧 English: ${en.text}\n✨ الرمز المتحرك: ${ar.icon?'مضاف ✅':'غير مضاف'}\n\nالتغيير يخص اسم الزر ورمزه فقط؛ مساره وصلاحياته لا تتغير.`,keyboard(
    [button('✏️ تعديل الاسم العربي',`admin_setting_edit:${homeSettingKey(key,'label_ar')}`)],
    [button('✏️ Edit English label',`admin_setting_edit:${homeSettingKey(key,'label_en')}`)],
    [button('✨ تعديل الرمز المتحرك',`admin_setting_edit:${homeSettingKey(key,'icon')}`)],
    [button('↩️ استعادة هذا الزر للأصل',`admin_home_button_reset:${key}`,'danger')],
    [button('🎨 قائمة أزرار الرئيسية','admin_home_buttons:0')],adminBack),messageId);
}
async function productIconsMenu(db,env,uid,messageId=null){
  const settings=await loadVisualSettings(db);
  const rows=ICON_SLOTS.map(x=>[button(`${settings[productIconKey(x.id)]?'✅':'▫️'} ${x.ar}`,`admin_setting_edit:${productIconKey(x.id)}`,'primary')]);
  rows.push([button('🎨 تخصيص الواجهة','admin_visuals')],adminBack);
  return sendOrEditText(env,uid,'✨ رموز المنتجات والسعر والمخزون\n\nالرموز تظهر داخل تفاصيل المنتج؛ رمز المنتج يظهر كذلك على زر المنتج في القائمة. يمكن إعطاء منتج معيّن رمزاً مختلفاً من صفحة إدارته.\n\nارسل إيموجي متحركاً فعلياً أو معرّفه، واكتب /empty للإزالة.',keyboard(...rows),messageId);
}
async function stats(db,env,uid,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const [users,products,categories,pending,paid,topups,sales,walletSales]=await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM users').first(),
    db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').first(),
    db.prepare('SELECT COUNT(*) n FROM categories WHERE active=1').first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='awaiting_admin'").first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid_pending_delivery'").first(),
    db.prepare("SELECT COUNT(*) n FROM topup_requests WHERE status='pending'").first(),
    db.prepare("SELECT COUNT(*) orders_count,COALESCE(SUM(total_stars),0) stars FROM orders WHERE status='delivered'").first(),
    db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(price_iqd),0) AS iqd FROM wallet_purchases').first()
  ]);
  return reply(`📊 إحصائيات المتجر\n\n👥 المستخدمون: ${users.n}\n🛍️ المنتجات المنشورة: ${products.n}\n📂 الأقسام النشطة: ${categories.n}\n⏳ طلبات الشراء المعلقة: ${pending.n}\n📦 مدفوع بانتظار التسليم: ${paid.n}\n💳 طلبات الشحن المعلقة: ${topups.n}\n✅ مشتريات المحفظة المكتملة: ${walletSales.n}\n💰 إجمالي مشتريات المحفظة: ${formatIQD(walletSales.iqd)}\n✅ الطلبات القديمة المكتملة: ${sales.orders_count}\n⭐ نجوم الطلبات القديمة المكتملة: ${sales.stars}\n\nملاحظة: إحصاء الإيرادات هو عدد نجوم الطلبات، وليس الأرباح الصافية.`,keyboard(adminBack));
}

async function settings(db,env,uid,page=0,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const entries=Object.entries(SETTING_FIELDS).filter(([key,def])=>!def.internal && !key.startsWith('home_button_') && !['product_custom_emoji_id','price_custom_emoji_id','stock_custom_emoji_id'].includes(key));
  const pageSize=6, offset=Math.max(0,Math.min(page,Math.ceil(entries.length/pageSize)-1))*pageSize;
  const rows=entries.slice(offset,offset+pageSize).map(([key,def])=>[button(def.label,`admin_setting:${key}`)]);
  const nav=[];
  if(offset>0)nav.push(button('⬅️ السابق',`admin_settings:${Math.max(0,page-1)}`));
  if(offset+pageSize<entries.length)nav.push(button('التالي ➡️',`admin_settings:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push(adminBack);
  return reply('⚙️ إدارة المتجر والرسائل\n\nاختر ما تريد تعديله. لا يمكن تعديل رمز البوت أو هوية المدير من داخل تيليجرام.',keyboard(...rows));
}
async function settingDetail(db,env,uid,key,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const def=SETTING_FIELDS[key];if(!def)return reply('الإعداد غير معروف.');
  const fallback=key==='home_template'?DEFAULT_HOME_TEMPLATE:key==='home_template_en'?DEFAULT_HOME_TEMPLATE_EN:key==='store_name'?env.STORE_NAME:key==='news_url'?env.NEWS_URL:key==='support_url'?env.SUPPORT_URL:key==='store_enabled'?'true':key==='manual_topups_enabled'?env.ENABLE_MANUAL_TOPUPS||'false':'';
  const value=await getSetting(db,key,fallback||'');
  const rows=def.toggle?[[button(value==='false'?(key==='manual_topups_enabled'?'✅ تشغيل الشحن':key==='support_direct_enabled'?'✅ إظهار زر المسؤول':'✅ تشغيل استقبال الطلبات'):(key==='manual_topups_enabled'?'⏸️ إيقاف الشحن':key==='support_direct_enabled'?'🙈 إخفاء زر المسؤول':'⏸️ إيقاف الطلبات الجديدة'),key==='manual_topups_enabled'?'admin_toggle_topups':key==='support_direct_enabled'?'admin_toggle_support_direct':'admin_toggle_store',value==='false'?'success':'danger')]]:[[button('✏️ تعديل','admin_setting_edit:'+key)]];
  if(key==='support_direct_enabled')rows.push([button('👤 إعداد حساب المسؤول','admin_setting:support_direct_username','primary')]);
  if(key==='home_template')rows.push([button('↩️ إعادة رسالة الترحيب الافتراضية','admin_visual_reset','danger')]);
  if(def.botProfile)rows.push([button('🖼️ تعريف البوت','admin_bot_intro','primary')]);
  rows.push(backTo('admin_settings:0'),adminBack);
  return reply(`${def.label}\n\nالقيمة الحالية:\n${short(value||'لم يتم التحديد بعد',1750)}\n\n${def.toggle?(key==='manual_topups_enabled'?'يمكن تعطيل الشحن دون إلغاء طلبات الشحن التي سبق إرسالها.':key==='support_direct_enabled'?'يظهر زر فتح حساب المسؤول فقط عند تفعيله وإضافة اسم المستخدم الصحيح.':'الإيقاف يمنع إنشاء طلبات شراء جديدة ولا يلغي الطلبات السابقة.'):key==='home_template'?'الحقول الحقيقية: {store} {balance} {name} {id} {users} {instructions}. {balance} تعرض عملة واحدة حسب اختيار العميل. يمكنك إرسال رسالة تحتوي على إيموجي متحرك حقيقي داخل القالب.':def.customEmoji?'يمكنك لصق رقم custom_emoji_id أو إرسال رمز متحرك ليتعرف البوت على معرّفه. اكتب /empty للإزالة.':'اكتب نصاً جديداً عند الضغط على تعديل، أو كلمة /empty لمسح الحقول الاختيارية.'}`,keyboard(...rows));
}

async function products(db,env,uid,page=0,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const pageSize=7;
  const items=(await db.prepare('SELECT id,title,price_iqd,active,stock FROM products ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize+1,Math.max(0,page)*pageSize).all()).results??[];
  const rows=items.slice(0,pageSize).map(p=>[button(`${p.active?'🟢':'🔴'} #${p.id} ${short(p.title,23)} • ${p.price_iqd?formatIQD(p.price_iqd):'بدون سعر محفظة'}`,`admin_product:${p.id}`)]);
  const nav=[];
  if(page>0)nav.push(button('⬅️ السابق',`admin_products:${page-1}`));
  if(items.length>pageSize)nav.push(button('التالي ➡️',`admin_products:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([button('➕ إضافة منتج','admin_addproduct')],adminBack);
  return reply('📦 إدارة المنتجات\n\nيمكنك تغيير السعر والوصف والمخزون والتعليمات وحالة العرض من الأزرار. المنتجات المخفية تبقى في السجل.',keyboard(...rows));
}
const PRODUCT_FIELDS={
  title:{label:'🏷️ الاسم',max:150},
  title_en:{label:'🇬🇧 English product name',max:150},
  description_en:{label:'🇬🇧 English description',max:1800},
  usage_instructions_en:{label:'🇬🇧 English usage instructions',max:1800},
  description:{label:'📝 الوصف',max:1800},
  price_iqd:{label:'💰 سعر المحفظة بالدينار',integer:true,min:1,max:100000000},
  usage_instructions:{label:'📖 طريقة الاستخدام',max:1800},
  delivery_shared_text:{label:'📦 محتوى التسليم الثابت',max:2000},
  price_stars:{label:'⭐ سعر قديم (للسجل فقط)',integer:true,min:1,max:10000000},
  stock:{label:'📦 المخزون',integer:true,min:0,max:1000000,nullable:true},
  duration_months:{label:'🗓️ المدة بالأشهر',integer:true,min:1,max:120,nullable:true},
  delivery_instructions:{label:'📦 تعليمات التسليم الخاصة',max:1800},
};
function validatedProductValue(field,text){
  const f=PRODUCT_FIELDS[field];if(!f)return {ok:false,message:'حقل غير مدعوم.'};
  if(f.nullable&&text==='-')return {ok:true,value:null};
  if(f.integer){
    if(!/^\d+$/.test(text))return {ok:false,message:'أدخل رقماً صحيحاً فقط.'};
    const n=Number(text);
    if(!Number.isSafeInteger(n)||n<f.min||n>f.max)return {ok:false,message:`القيمة يجب أن تكون بين ${f.min} و ${f.max}.`};
    return {ok:true,value:n};
  }
  if(!text && field==='title')return {ok:false,message:'الاسم لا يمكن أن يكون فارغاً.'};
  if(text.length>f.max)return {ok:false,message:`الحد الأقصى ${f.max} حرف.`};
  return {ok:true,value:text};
}
async function productDetail(db,env,uid,id,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const p=await db.prepare('SELECT p.*,c.title category_title FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?').bind(id).first();
  if(!p)return reply('المنتج غير موجود.',keyboard(adminBack));
  const rows=[];
  for(const fields of [['title','description'],['title_en','description_en'],['price_iqd','stock'],['duration_months','usage_instructions'],['usage_instructions_en'],['delivery_shared_text','delivery_instructions']])
    rows.push(fields.map(f=>button(PRODUCT_FIELDS[f].label,`admin_product_field:${id}:${f}`)));
  rows.push([button('✨ رمز متحرك خاص بهذا المنتج',`admin_product_icon:${id}`,'primary')]);
  rows.push([button('📷 إضافة/تغيير صورة المنتج',`admin_product_photo:${id}`,'primary'),button('🗑️ حذف الصورة',`admin_product_photo_delete:${id}`,'danger')]);
  rows.push([button('📦 تسليم محتوى ثابت',`admin_product_mode:${id}:shared`,'success'),button('🔑 تسليم كود فريد',`admin_product_mode:${id}:unique`,'primary')]);
  rows.push([button('➕ إضافة أكواد (كود في كل سطر)',`admin_product_code:${id}`,'success'),button('⏸️ إيقاف الشراء التلقائي',`admin_product_mode:${id}:disabled`,'danger')]);
  rows.push([button('📂 نقل إلى قسم آخر',`admin_product_categories:${id}`)]);
  rows.push([button(p.active?'🚫 إخفاء المنتج':'✅ إظهار المنتج',`admin_product_toggle:${id}:active`,p.active?'danger':'success'),
             button(p.featured?'⭐ إلغاء التمييز':'🌟 تمييز المنتج',`admin_product_toggle:${id}:featured`)]);
  rows.push(backTo('admin_products:0'),adminBack);
  const codes=await db.prepare('SELECT COUNT(*) n FROM product_delivery_items WHERE product_id=? AND used_by_purchase_id IS NULL').bind(id).first();
  return reply(`📦 المنتج #${p.id}\n\n🏷️ ${short(p.title,120)}\n📂 ${short(p.category_title,80)}\n💰 سعر المحفظة: ${p.price_iqd?formatIQD(p.price_iqd):'لم يحدد'}\n📷 الصورة: ${p.photo_file_id?'✅ محفوظة':'—'}\n✨ رمز المنتج: ${p.custom_emoji_id?'✅ مخصص':'الرمز العام'}\n📖 طريقة الاستخدام: ${short(p.usage_instructions||'لم تضف',100)}\n🇬🇧 English product name: ${short(p.title_en||'—',100)}\n📦 طريقة التسليم: ${p.fulfillment_mode}\n🔑 أكواد غير مستخدمة: ${codes?.n||0}\n📦 المحتوى الثابت: ${p.delivery_shared_text?'✅ محفوظ':'—'}\n📦 المخزون: ${p.stock??'غير محدود'}\n🗓️ المدة: ${p.duration_months??'غير محددة'}\n📢 النشر: ${p.active?'ظاهر':'مخفي'}\n🌟 مميز: ${p.featured?'نعم':'لا'}\n📝 الوصف: ${short(p.description,500)||'—'}\n📬 تعليمات التسليم: ${short(p.delivery_instructions,500)||'—'}`,keyboard(...rows));
}
async function categories(db,env,uid,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const list=(await db.prepare('SELECT id,title,emoji,active FROM categories ORDER BY id DESC LIMIT 40').all()).results??[];
  const rows=list.map(c=>[button(`${c.active?'🟢':'🔴'} #${c.id} ${short(c.emoji,6)} ${short(c.title,32)}`,`admin_category:${c.id}`)]);
  rows.push([button('➕ إضافة قسم','admin_addcategory')],adminBack);
  return reply('📂 إدارة الأقسام\n\nاختر قسماً لتعديل اسمه ورمزه أو إظهاره وإخفائه.',keyboard(...rows));
}
async function categoryDetail(db,env,uid,id,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const c=await db.prepare('SELECT * FROM categories WHERE id=?').bind(id).first();
  if(!c)return reply('القسم غير موجود.',keyboard(adminBack));
  return reply(`📂 القسم #${c.id}\n\n${c.emoji} ${c.title}\nالحالة: ${c.active?'ظاهر':'مخفي'}`,keyboard(
    [button('✏️ تعديل الاسم',`admin_category_field:${id}:title`),button('🎨 تغيير الرمز',`admin_category_field:${id}:emoji`)],
    [button('🇬🇧 English category name',`admin_category_field:${id}:title_en`)],
    [button(c.active?'🚫 إخفاء':'✅ إظهار',`admin_category_toggle:${id}`,c.active?'danger':'success')],backTo('admin_manage_categories'),adminBack));
}
async function userLookup(db,env,uid,input,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const userId=positiveInt(input);if(!userId)return reply('أدخل Telegram ID رقمي صحيح.');
  const u=await getUser(db,userId);if(!u)return reply('هذا الحساب غير مسجل في المتجر.',keyboard(adminBack));
  const [orders,topups]=await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM orders WHERE user_tg_id=?').bind(userId).first(),
    db.prepare('SELECT COUNT(*) n FROM topup_requests WHERE user_tg_id=?').bind(userId).first(),
  ]);
  return reply(`👤 عميل #${userId}

الاسم: ${short(u.first_name,120)}
المعرف: ${u.username?'@'+u.username:'لا يوجد'}
الرصيد الداخلي: ${formatIQD(u.wallet_balance_iqd)}
الطلبات: ${orders.n}
طلبات الشحن: ${topups.n}
تاريخ التسجيل: ${u.joined_at}
الوضع: ${restrictionLabel(u)}

يمكن إرسال رد خاص عبر: /reply ${userId} نص الرسالة`,keyboard(
    [button('👤 إدارة الحظر والتعليق',`admin_user:${userId}`,'primary')],adminBack));
}

// A single guided page avoids making the owner search through pages of settings.
async function topupSetup(db,env,uid,messageId=null){
  const rate=await usdRate(db);
  const enabled=(await getSetting(db,'manual_topups_enabled',env.ENABLE_MANUAL_TOPUPS||'false'))==='true';
  const methods=[
    ['zain_balance','📱 رصيد زين','zain_balance_receiver'],
    ['superqi','🏦 سوبر كي','superqi_receiver'],
    ['binance','🟡 Binance','binance_receiver']
  ];
  const receivers=await Promise.all(methods.map(async ([method,label])=>({method,label,ready:!!(await receiverFor(db,env,method))})));
  const count=receivers.filter(m=>m.ready).length;
  const status=enabled?'🟢 تعمل وتستقبل طلبات الشحن':'🔴 متوقفة عن استقبال طلبات الشحن';
  const checklist=`${rate?'✅':'❌'} سعر الصرف: ${rate?'1 USD = '+formatIQD(rate):'لم يُحدد'}\n`+
    `${count?'✅':'❌'} حسابات الاستلام المضبوطة: ${count} من ${methods.length}\n`+
    `${enabled?'✅':'⏳'} تفعيل استقبال الطلبات`;
  const rows=[
    [button('💱 تعديل سعر الصرف','admin_setting_edit:usd_rate_iqd','primary')],
    ...(!rate?[[button('✅ اعتماد 1 دولار = 1,520 د.ع','admin_rate_1520','success')]]:[]),
    ...methods.map(([,label,key],i)=>[button((receivers[i].ready?'✅ ':'➕ ')+label,`admin_setting_edit:${key}`,'primary')]),
    [button(enabled?'⏸️ تعطيل طلبات الشحن':'✅ تفعيل طلبات الشحن','admin_toggle_topups',enabled?'danger':'success')],
    [button('📥 مراجعة طلبات الشحن','admin_topups','primary')],
    [button('🛡️ لوحة المدير','admin','primary')]
  ];
  const note=rate===1520?'سعر 1,520 هو السعر الرسمي المعلن لبيع الدولار للجمهور، وليس بالضرورة سعر السوق أو سعر استلام تحويلاتك.':'يمكنك اعتماد 1,520 كسعر مرجعي معلن أو إدخال سعر مختلف بنفسك. لا يُطبّق الاقتراح إلا عند ضغط زر اعتماده.';
  return sendOrEditText(env,uid,`⚙️ إعداد شحن المحفظة\n\nالحالة: ${status}\n\n${checklist}\n\n${note}\n\nلتشغيل الشحن: تأكد من السعر واملأ بيانات استلام وسيلة واحدة على الأقل، ثم اضغط تفعيل. لا يُضاف رصيد إلا بعد قبولك طلباً موثّقاً.`,keyboard(...rows),messageId);
}

// Returns true if the callback was recognized, including denied admin access.
export async function handleAdminCallback(db,env,uid,data,messageId=null){
  if(!adminRoute(data) && !data.startsWith('admin_setting_edit:'))return false;
  if(!isAdmin(env,uid)){await sendText(env,uid,'⛔ هذا الإجراء غير متاح.');return true;}
  if(data==='admin_bot_intro') {
    const [name,description,shortDescription]=await Promise.all([
      getSetting(db,'bot_public_name',''),getSetting(db,'bot_public_description',''),getSetting(db,'bot_public_short_description','')]);
    await sendOrEditText(env,uid,`🖼️ تعريف البوت قبل «ابدأ»\n\n🏷️ الاسم: ${short(name||'اسم البوت الحالي',120)}\n📝 الوصف: ${short(description||'غير محدد',400)}\n📃 المختصر: ${short(shortDescription||'غير محدد',150)}\n\nيمكن تعديل الاسم والوصفين مباشرة؛ تُرسل التغييرات إلى Telegram عند الحفظ.\n\n📷 صورة البوت الشخصية: يمكن تغييرها أو إزالتها هنا.\n⚠️ صورة وصف البداية الكبيرة منفصلة عن صورة الملف، ويجب ضبطها من @BotFather ← Edit Bot ← Edit Description Picture؛ لا توجد طريقة لها في Bot API.`,keyboard(
      [button('🏷️ تعديل العنوان','admin_setting_edit:bot_public_name','primary')],
      [button('📝 تعديل الوصف','admin_setting_edit:bot_public_description','primary')],
      [button('📃 الوصف المختصر','admin_setting_edit:bot_public_short_description','primary')],
      [button('📷 تغيير صورة البوت','admin_bot_photo_edit','success')],
      [button('🗑️ إزالة الصورة الشخصية','admin_bot_photo_remove','danger')],
      [button('👥 عداد المستخدمين','admin_counter','primary')],
      [button('🛡️ لوحة المدير','admin','primary')]),messageId);
  }
  else if(data==='admin_bot_photo_edit') {
    await setSession(db,uid,'owner_bot_profile_picture');
    await sendText(env,uid,'📷 أرسل صورة جديدة بصيغة صورة تيليجرام، لتصبح الصورة الشخصية للبوت.\n\nملاحظة: صورة وصف البداية الكبيرة تتطلب BotFather.\nللإلغاء /cancel.');
  }
  else if(data==='admin_bot_photo_remove') {
    try {await telegram(env,'removeMyProfilePhoto',{});
      await audit(db,uid,'remove_bot_profile_photo','bot',0);
      await sendOrEditText(env,uid,'✅ تمت إزالة صورة البوت الشخصية الحالية.',keyboard([button('🖼️ إعدادات تعريف البوت','admin_bot_intro','primary')],adminBack),messageId);
    }catch(e){await sendText(env,uid,'❌ تعذر إزالة الصورة من تيليجرام. لم نغيّر أي بيانات أخرى.');}
  }
  else if(data==='admin_support_contact'){
    const [enabled,username,label]=await Promise.all([
      getSetting(db,'support_direct_enabled','false'),
      getSetting(db,'support_direct_username',''),
      getSetting(db,'support_direct_label','👤 تواصل مباشر مع المسؤول')]);
    await sendOrEditText(env,uid,`🎧 إدارة التواصل مع المسؤول\n\nالحالة: ${enabled==='true'?'ظاهر':'مخفي'}\nالمعرف: ${username||'لم يُحدد'}\nعنوان الزر: ${label}\n\nيظهر زر الرابط للعملاء فقط إذا كان مفعلاً ومعرف المسؤول صحيحاً.`,keyboard(
      [button('👤 تعديل معرف المسؤول','admin_setting_edit:support_direct_username','primary')],
      [button('✏️ تعديل عنوان الزر','admin_setting_edit:support_direct_label','primary')],
      [button(enabled==='true'?'🙈 إخفاء':'✅ إظهار','admin_toggle_support_direct',enabled==='true'?'danger':'success')],
      [button('🛡️ لوحة المدير','admin','primary')]),messageId);
  }
  else if(data==='admin_counter'){
    const [real,offset]=await Promise.all([db.prepare('SELECT COUNT(*) n FROM users').first(),getSetting(db,'users_display_adjustment','0')]);
    const count=Number(real?.n||0),adjustment=Number(offset||0);
    await sendOrEditText(env,uid,`👥 إعدادات عداد المستخدمين\n\n📊 العدد الحقيقي في D1: ${count.toLocaleString('en-US')}\n🎨 العدد الظاهر بالترحيب: ${Math.max(0,count+adjustment).toLocaleString('en-US')}\n\nعند تسجيل مستخدم جديد، سيزيد العدد المعروض واحداً تلقائياً لأن التسجيل الفعلي هو أساس الحساب. هذا الرقم المعروض مخصص ولا يغيّر الإحصائيات الحقيقية.`,keyboard(
      [button('✏️ تغيير العدد المعروض','admin_counter_edit','primary')],
      [button('🔄 استعادة العدد الحقيقي','admin_counter_reset','success')],
      [button('🖼️ إعدادات تعريف البوت','admin_bot_intro','primary')],adminBack),messageId);
  }
  else if(data==='admin_counter_edit'){
    await setSession(db,uid,'owner_users_display_count');
    await sendText(env,uid,'👥 أرسل العدد الذي تريد عرضه في رسالة الترحيب (رقم صحيح من 0 إلى 1,000,000,000).\n\nسيزداد تلقائياً عند تسجيل مستخدم جديد. للإلغاء /cancel.');
  }
  else if(data==='admin_counter_reset'){
    await updateSetting(db,'users_display_adjustment','0',uid);
    await audit(db,uid,'reset_display_count','setting',0);
    await sendOrEditText(env,uid,'✅ استُعيد العدد الحقيقي المسجل في D1 دون حذف مستخدمين.',keyboard([button('👥 إعدادات العداد','admin_counter','primary')],adminBack),messageId);
  }
  else if(data==='admin_visuals')await sendOrEditText(env,uid,`🎨 تخصيص واجهة المتجر

يمكن تعديل رسالة الترحيب والرموز المتحركة للصفحات دون تغيير الأرصدة أو الهويات الحقيقية.

حقول القالب: {store} {name} {id} {users} {balance} {instructions}
{balance} تعرض رصيد العميل بعملة واحدة (IQD أو $).
أرسل الإيموجي المتحرك ضمن نص الترحيب نفسه لحفظه مع مكانه.

أرسل رقم custom_emoji_id أو رسالة تحتوي على إيموجي متحرك عند اختيار حقل الرمز. يلزم دعم Telegram لتظهر الحركة.`,keyboard(
    [button('🖼️ تعريف البوت قبل ابدأ','admin_bot_intro','primary')],
    [button('👥 عداد المستخدمين','admin_counter','primary')],
    [button('👋 تعديل رسالة الترحيب','admin_setting:home_template','primary')],
    [button('👋 English welcome message','admin_setting:home_template_en','primary')],
    [button('🎨 تخصيص جميع أزرار الرئيسية','admin_home_buttons:0','success')],
    [button('🛍️ رموز المنتج والسعر والمخزون','admin_product_icons','success')],
    [button('↩️ إعادة رسالة الترحيب الأصلية','admin_visual_reset','danger')],
    [button('👁️ معاينة الرئيسية بالبيانات الحقيقية','admin_visual_preview','success')],
    [button('✨ رمز الرئيسية','admin_setting:home_custom_emoji_id','primary'),button('✨ رمز المتجر','admin_setting:shop_custom_emoji_id','primary')],
    [button('✨ رمز الملف','admin_setting:profile_custom_emoji_id','primary'),button('✨ رمز المحفظة','admin_setting:wallet_custom_emoji_id','primary')],
    [button('✨ رمز الطلبات','admin_setting:orders_custom_emoji_id','primary'),button('✨ رمز الدعم','admin_setting:support_custom_emoji_id','primary')],
    [button('🛡️ لوحة المدير','admin','primary')]),messageId);
  else if(data==='admin_home_buttons'||data.startsWith('admin_home_buttons:')){
    const page=Math.min(1,Number(data.split(':')[1]||0)||0);
    await homeButtonList(db,env,uid,page,messageId);
  }
  else if(data.startsWith('admin_home_button:'))await homeButtonDetail(db,env,uid,data.split(':')[1],messageId);
  else if(data==='admin_product_icons')await productIconsMenu(db,env,uid,messageId);
  else if(data.startsWith('admin_home_button_reset:')){
    const key=data.split(':')[1];
    if(!HOME_BUTTONS.some(b=>b.id===key))return true;
    await Promise.all(['label_ar','label_en','icon'].map(field=>updateSetting(db,homeSettingKey(key,field),'',uid)));
    await audit(db,uid,'reset_home_button','ui',0);
    await homeButtonDetail(db,env,uid,key,messageId);
  }
  else if(data==='admin_home_reset_all'){
    await setSession(db,uid,'owner_home_buttons_reset');
    await sendOrEditText(env,uid,'⚠️ إعادة أسماء ورموز جميع أزرار الرئيسية إلى قيمها الأصلية؟ لا تمس العملية الترحيب ولا الطلبات ولا الأرصدة.',keyboard(
      [button('✅ تأكيد الاستعادة','admin_home_reset_all_confirm','danger')],
      [button('❌ إلغاء','admin_home_buttons:0')]),messageId);
  }
  else if(data==='admin_home_reset_all_confirm'){
    const session=await getSession(db,uid);
    if(session?.action!=='owner_home_buttons_reset')return true;
    for(const b of HOME_BUTTONS)for(const field of ['label_ar','label_en','icon'])
      await updateSetting(db,homeSettingKey(b.id,field),'',uid);
    await clearSession(db,uid);
    await audit(db,uid,'reset_all_home_buttons','ui',0);
    await homeButtonList(db,env,uid,0,messageId);
  }
  else if(data==='admin_visual_preview')await customerHomePreview(db,env,uid,messageId);
  else if(data==='admin_visual_reset') {
    await setSession(db,uid,'owner_home_reset');
    await sendOrEditText(env,uid,
    '↩️ استعادة رسالة الترحيب الافتراضية\n\nسيُستبدل نص الترحيب المعدّل بقالب My Store الأصلي، دون تغيير رصيد أي مستخدم أو بياناته أو إعدادات الرموز المتحركة المستقلة.\n\nهل تؤكد الاستعادة؟',keyboard(
      [button('✅ نعم، استعادة الترحيب','admin_visual_reset_confirm','success')],
      [button('❌ إلغاء','admin_visuals','danger')]),messageId);
  }
  else if(data==='admin_visual_reset_confirm'){
    const pending=await getSession(db,uid);
    if(pending?.action!=='owner_home_reset'){
      await sendText(env,uid,'⚠️ انتهى طلب الاستعادة. افتح تخصيص الواجهة واختر إعادة تعيين الترحيب مجدداً.');
      return true;
    }
    await updateSetting(db,'home_template',DEFAULT_HOME_TEMPLATE,uid);
    await audit(db,uid,'reset_home_template','setting',0);
    await clearSession(db,uid);
    await sendOrEditText(env,uid,'✅ تمت استعادة رسالة الترحيب الافتراضية بنجاح.\n\nستظهر الأسماء والأرصدة وعدد المستخدمين مباشرة من بياناتهم الحقيقية. وتظل إعدادات الرموز المتحركة الأخرى محفوظة.',keyboard(
      [button('👁️ معاينة الترحيب','admin_visual_preview','success')],
      [button('🎨 إعدادات الواجهة','admin_visuals','primary')],adminBack),messageId);
  }
  else if(data==='admin_topup_setup')await topupSetup(db,env,uid,messageId);
  else if(data==='admin_rate_1520'){
    // Old callbacks must never overwrite an explicit owner rate.
    if(await usdRate(db)){
      await sendText(env,uid,'⚠️ سعر الصرف محدد بالفعل. لتغييره استخدم «تعديل سعر الصرف» من إعداد الشحن.');
      return true;
    }
    await updateSetting(db,'usd_rate_iqd','1520',uid);
    await audit(db,uid,'set_usd_rate_1520','setting',0);
    await topupSetup(db,env,uid,messageId);
  }
  else if(data==='admin_stats')await stats(db,env,uid,messageId);
  else if(data.startsWith('admin_settings'))await settings(db,env,uid,Math.min(20,positiveInt(data.split(':')[1])??0),messageId);
  else if(data==='admin_toggle_support_direct'){
    const current=await getSetting(db,'support_direct_enabled','false');
    await updateSetting(db,'support_direct_enabled',current==='true'?'false':'true',uid);
    await audit(db,uid,'toggle_support_direct','setting',0);
    await handleAdminCallback(db,env,uid,'admin_support_contact',messageId);
  }
  else if(data==='admin_toggle_store'){
    const current=await getSetting(db,'store_enabled','true');
    await updateSetting(db,'store_enabled',current==='false'?'true':'false',uid);
    await audit(db,uid,'toggle','setting',0);
    await settingDetail(db,env,uid,'store_enabled',messageId);
  }
  else if(data==='admin_toggle_topups'){
    const current=await getSetting(db,'manual_topups_enabled',env.ENABLE_MANUAL_TOPUPS||'false');
    if(current!=='true'){
      const rate=await usdRate(db);
      const receivers=await Promise.all(['zain_balance','superqi','binance'].map(m=>receiverFor(db,env,m)));
      if(!rate || !receivers.some(Boolean)){
        await sendText(env,uid,'⚠️ لا يمكن تفعيل الشحن بعد: '+(!rate?'حدّد سعر الدولار. ':'')+(!receivers.some(Boolean)?'وأضف رقم أو حساب استلام واحداً على الأقل.':'') ,keyboard([button('⚙️ فتح إعداد الشحن','admin_topup_setup','primary')]));
        return true;
      }
    }
    await updateSetting(db,'manual_topups_enabled',current==='true'?'false':'true',uid);
    await audit(db,uid,'toggle_manual_topups','setting',0);
    await topupSetup(db,env,uid,messageId);
  }
  else if(data.startsWith('admin_setting_edit:')){
    const key=data.substring('admin_setting_edit:'.length);
    if(!SETTING_FIELDS[key]||SETTING_FIELDS[key].toggle)return true;
    if(SETTING_FIELDS[key]?.internal)return true;
    await setSession(db,uid,'owner_setting',{key});
    await sendText(env,uid,`✏️ تعديل ${SETTING_FIELDS[key].label}\n\nأرسل النص الجديد (حد أقصى ${SETTING_FIELDS[key].max} حرف).\nلمسح الحقل اكتب /empty. وللإلغاء اكتب /cancel.`);
  }
  else if(data.startsWith('admin_setting:'))await settingDetail(db,env,uid,data.substring('admin_setting:'.length),messageId);
  else if(data.startsWith('admin_products'))await products(db,env,uid,Math.min(100,positiveInt(data.split(':')[1])??0),messageId);
  else if(data.startsWith('admin_product:'))await productDetail(db,env,uid,Number(data.split(':')[1]),messageId);
  else if(data.startsWith('admin_product_icon:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    await setSession(db,uid,'owner_product_icon',{id});
    await sendText(env,uid,'✨ أرسل إيموجي متحرك خاص بهذا المنتج، أو رقم custom_emoji_id.\nلإزالة الرمز الخاص والعودة للرمز العام أرسل /empty. للإلغاء /cancel.');
  }
  else if(data.startsWith('admin_product_photo:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    await setSession(db,uid,'owner_product_photo',{id});
    await sendText(env,uid,'📷 أرسل صورة المنتج الآن (كصورة عادية في تيليجرام). للإلغاء /cancel.');
  }
  else if(data.startsWith('admin_product_photo_delete:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    await db.prepare('UPDATE products SET photo_file_id=NULL WHERE id=?').bind(id).run();
    await audit(db,uid,'remove_product_photo','product',id);
    await productDetail(db,env,uid,id,messageId);
  }
  else if(data.startsWith('admin_product_mode:')){
    const [,rawId,mode]=data.split(':');const id=positiveInt(rawId);
    if(!id||!['shared','unique','disabled'].includes(mode))return true;
    await db.prepare(`UPDATE products SET fulfillment_mode=?,
      stock=CASE WHEN ?='unique' THEN
        (SELECT COUNT(*) FROM product_delivery_items i WHERE i.product_id=products.id AND i.used_by_purchase_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM product_delivery_items older
             WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL)))
        ELSE stock END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(mode,mode,id).run();
    await audit(db,uid,'set_delivery_mode','product',id);
    await productDetail(db,env,uid,id,messageId);
  }
  else if(data.startsWith('admin_product_code:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    await setSession(db,uid,'owner_product_code',{id});
    await sendText(env,uid,'🔑 أرسل كوداً واحداً، أو حتى 50 كوداً دفعة واحدة (كود في كل سطر).\n\nكل عملية شراء تستلم كوداً مختلفاً، والأكواد المباعة لا تعود للمخزون. لن تتكرر الأكواد المتطابقة.\n\nللإلغاء /cancel.');
  }
  else if(data.startsWith('admin_product_field:')){ 
    const [, id,field]=data.split(':');
    if(!PRODUCT_FIELDS[field] || !positiveInt(id))return true;
    await setSession(db,uid,'owner_product_field',{id:Number(id),field});
    await sendText(env,uid,`✏️ تعديل ${PRODUCT_FIELDS[field].label} للمنتج #${id}\nأرسل القيمة الجديدة.${PRODUCT_FIELDS[field].nullable?'\nاكتب - لإلغاء التحديد.':''}\nللإلغاء /cancel.`);
  }
  else if(data.startsWith('admin_product_categories:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    const cats=(await db.prepare('SELECT id,title,emoji FROM categories WHERE active=1 ORDER BY id').all()).results??[];
    await sendText(env,uid,`📂 اختر القسم الجديد للمنتج #${id}:`,keyboard(
      ...cats.slice(0,35).map(c=>[button(`${c.emoji} #${c.id} ${short(c.title,36)}`,`admin_product_move:${id}:${c.id}`)]),
      backTo(`admin_product:${id}`),adminBack));
  }
  else if(data.startsWith('admin_product_move:')){
    const [,id,cid]=data.split(':');if(!positiveInt(id)||!positiveInt(cid))return true;
    const res=await db.prepare('UPDATE products SET category_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS(SELECT 1 FROM categories WHERE id=? AND active=1)').bind(cid,id,cid).run();
    if(res.meta?.changes)await audit(db,uid,'move_category','product',Number(id));
    await productDetail(db,env,uid,Number(id),messageId);
  }
  else if(data.startsWith('admin_product_toggle:')){
    const [,id,field]=data.split(':');
    if(!['active','featured'].includes(field)||!positiveInt(id))return true;
    await db.prepare(`UPDATE products SET ${field}=CASE WHEN ${field}=1 THEN 0 ELSE 1 END, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
    await audit(db,uid,`toggle_${field}`,'product',Number(id));
    await productDetail(db,env,uid,Number(id),messageId);
  }
  else if(data==='admin_manage_categories')await categories(db,env,uid,messageId);
  else if(data.startsWith('admin_category:'))await categoryDetail(db,env,uid,Number(data.split(':')[1]),messageId);
  else if(data.startsWith('admin_category_field:')){
    const [, id,field]=data.split(':');
    if(!['title','title_en','emoji'].includes(field)||!positiveInt(id))return true;
    await setSession(db,uid,'owner_category_field',{id:Number(id),field});
    await sendText(env,uid,`✏️ أرسل ${field==='title'?'اسم القسم الجديد':field==='title_en'?'الاسم الإنجليزي للقسم':'الرمز التعبيري'} للقسم #${id}. للإلغاء /cancel. لمسح الاسم الإنجليزي أرسل /empty.`);
  }
  else if(data.startsWith('admin_category_toggle:')){
    const id=positiveInt(data.split(':')[1]);if(!id)return true;
    await db.prepare('UPDATE categories SET active=CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
    await audit(db,uid,'toggle_active','category',id);
    await categoryDetail(db,env,uid,id,messageId);
  }
  else if(data.startsWith('admin_user_toggle:')){
    const target=positiveInt(data.split(':')[1]);if(!target)return true;
    if(String(target)===String(uid)){
      await sendText(env,uid,'لا يمكنك حظر حساب المدير.');return true;
    }
    const res=await db.prepare('UPDATE users SET is_blocked=CASE is_blocked WHEN 1 THEN 0 ELSE 1 END WHERE tg_id=?').bind(target).run();
    if(res.meta?.changes){await audit(db,uid,'toggle_block','user',target);await userLookup(db,env,uid,String(target),messageId);}
    else await sendText(env,uid,'الحساب غير موجود.');
  }
  else if(data==='admin_find_user'){
    await setSession(db,uid,'owner_user_search');
    await sendText(env,uid,'🔎 اكتب Telegram ID للعميل الذي تريد عرض ملفه. للإلغاء /cancel.');
  }
  else if(data==='admin_help')await sendText(env,uid,'📖 دليل الإدارة\n\n• تعديل الأسعار والنصوص من الأزرار داخل لوحة المدير.\n• شراء المحفظة يتم تلقائياً عند وجود السعر والمخزون ومحتوى تسليم جاهز.\n• إخفاء منتج لا يمسح الطلبات القديمة.\n• أسرار Cloudflare وهوية المدير لا يمكن تغييرهما من داخل البوت.\n• لتفعيل طلبات الشحن، أدخل سعر الصرف وبيانات استلام رصيد زين أو سوبر كي أو Binance، ثم فعّل الزر من الإعدادات. لا تستخدم الرصيد الداخلي بديلاً عن Stars لبيع الخدمات الرقمية.\n• للتراجع عن أي عملية تحرير: /cancel.',keyboard(adminBack));
  return true;
}

export async function handleAdminText(db,env,uid,session,message){
  if(!isAdmin(env,uid))return false;
  const text=String(message.text??'').trim();
  if(session.action==='owner_product_photo'){
    const id=positiveInt(session.payload?.id);
    if(!id)return true;
    if(!message.photo?.length){await sendText(env,uid,'📷 أرسل صورة، أو /cancel للإلغاء.');return true;}
    await db.prepare('UPDATE products SET photo_file_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(message.photo.at(-1).file_id,id).run();
    await audit(db,uid,'set_product_photo','product',id);
    await clearSession(db,uid);
    await sendText(env,uid,'✅ تم حفظ الصورة وستظهر عند تسليم المنتج.',keyboard([button('📦 إعداد المنتج',`admin_product:${id}`,'success')],adminBack));
    return true;
  }
  if(session.action==='owner_product_code'){
    const id=positiveInt(session.payload?.id);
    if(!id)return true;
    const values=text.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    if(!values.length||values.length>50||text.length>3900||values.some(v=>v.length>1800)){
      await sendText(env,uid,'❌ أرسل من 1 إلى 50 كوداً، كود واحد في كل سطر. الحد الأقصى للرسالة 3900 حرف.');
      return true;
    }
    const codes=[...new Set(values)];
    const product=await db.prepare('SELECT id FROM products WHERE id=?').bind(id).first();
    if(!product){await clearSession(db,uid);return sendText(env,uid,'المنتج غير موجود.');}
    // D1 batch is an atomic transaction: reject duplicate values, never overwrite sold codes.
    const inserts=codes.map(code=>db.prepare(`INSERT INTO product_delivery_items(product_id,payload)
      SELECT id,? FROM products WHERE id=? AND NOT EXISTS
      (SELECT 1 FROM product_delivery_items WHERE product_id=? AND payload=?)`).bind(code,id,id,code));
    const stockRefresh=db.prepare(`UPDATE products SET stock=(SELECT COUNT(*) FROM product_delivery_items i
        WHERE i.product_id=? AND i.used_by_purchase_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
            WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL))),
        updated_at=CURRENT_TIMESTAMP WHERE id=? AND fulfillment_mode='unique'`).bind(id,id);
    const result=await db.batch([...inserts,stockRefresh]);
    const added=result.slice(0,codes.length).reduce((n,v)=>n+Number(v.meta?.changes||0),0);
    if(added)await audit(db,uid,'add_unique_delivery_codes','product',id);
    await clearSession(db,uid);
    const available=await db.prepare(`SELECT COUNT(*) n FROM product_delivery_items i WHERE i.product_id=?
      AND i.used_by_purchase_id IS NULL AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
        WHERE older.product_id=i.product_id AND older.payload=i.payload AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL))`).bind(id).first();
    await sendText(env,uid,`✅ أضيف ${added} كود فريد.\n🔁 أكواد مكررة لم تُضف: ${values.length-added}\n🔑 الأكواد الباقية للبيع: ${available?.n||0}\n\nلتفعيلها اختر «🔑 تسليم كود فريد». وكل شراء جديد يستهلك كوداً واحداً دون إعادة استخدامه.`,keyboard([button('📦 إعداد المنتج',`admin_product:${id}`,'success')],adminBack));
    return true;
  }
  if(session.action==='owner_bot_profile_picture'){
    if(!message.photo?.length){await sendText(env,uid,'📷 أرسل صورة باستخدام خيار الصور في تيليجرام (JPEG). للإلغاء /cancel.');return true;}
    try {
      await updateBotProfilePicture(env,message.photo.at(-1).file_id);
      await audit(db,uid,'set_bot_profile_photo','bot',0);
      await clearSession(db,uid);
      await sendText(env,uid,'✅ تم تحديث صورة البوت الشخصية بنجاح. صورة وصف البداية الكبيرة تُضبط بشكل منفصل من BotFather.',keyboard([button('🖼️ إعدادات تعريف البوت','admin_bot_intro','primary')],adminBack));
    }catch(e){await sendText(env,uid,'❌ تعذر حفظ الصورة لدى تيليجرام. أرسل صورة JPEG أخرى أو /cancel.');}
    return true;
  }
  if(session.action==='owner_users_display_count'){
    if(!/^\d{1,10}$/.test(text)||Number(text)>1000000000){await sendText(env,uid,'❌ أرسل رقماً صحيحاً من 0 إلى 1,000,000,000.');return true;}
    const users=await db.prepare('SELECT COUNT(*) n FROM users').first();
    const offset=Number(text)-Number(users?.n||0);
    await updateSetting(db,'users_display_adjustment',String(offset),uid);
    await audit(db,uid,'adjust_display_count','setting',0);
    await clearSession(db,uid);
    await sendText(env,uid,`✅ العدد الظاهر الآن: ${Number(text).toLocaleString('en-US')}\nسيزيد واحداً عند تسجيل مستخدم جديد؛ العدد الحقيقي لم يتغيّر.`,keyboard([button('👥 إعدادات العداد','admin_counter','primary')],adminBack));
    return true;
  }
  if(session.action==='owner_setting'){
    const {key}=session.payload||{};
    const receivedCustom=(message.entities||message.caption_entities||[]).find(e=>e.type==='custom_emoji'&&e.custom_emoji_id)?.custom_emoji_id;
    const raw=['home_template','home_template_en'].includes(key) ? preserveCustomEmojiInTemplate(text,message.entities||[])
      : SETTING_FIELDS[key]?.customEmoji && receivedCustom ? String(receivedCustom) : text;
    const valid=validateSetting(key,raw==='/empty'?'':raw);
    if(!valid.ok){await sendText(env,uid,'❌ '+valid.reason);return true;}
    if(SETTING_FIELDS[key]?.botProfile){
      const method=SETTING_FIELDS[key].botProfile;
      const payload= method==='setMyName'?{name:valid.value}:method==='setMyDescription'?{description:valid.value}:{short_description:valid.value};
      try{await telegram(env,method,payload);}catch(e){
        await sendText(env,uid,'❌ تعذّر تحديث معلومات البوت في Telegram؛ لم تُحفظ القيمة الجديدة. تحقق من حدود النص ثم أعد المحاولة.');
        return true;
      }
    }
    if(SETTING_FIELDS[key]?.internal){await sendText(env,uid,'❌ لا يمكن تغيير هذا الحقل مباشرة. استخدم صفحة عداد المستخدمين.');return true;}
    await updateSetting(db,key,valid.value,uid);
    await audit(db,uid,'edit_'+key,'setting',0);
    await clearSession(db,uid);
    await sendText(env,uid,`✅ تم حفظ الإعداد: ${SETTING_FIELDS[key].label}`,keyboard(
      [button('🎨 تخصيص الواجهة','admin_visuals','primary')],
      [button('⚙️ جميع الإعدادات','admin_settings:0','primary')],adminBack));
    return true;
  }
  if(session.action==='owner_product_icon'){
    const id=Number(session.payload?.id);
    const found=(message.entities||message.caption_entities||[]).find(e=>e.type==='custom_emoji'&&/^\d{10,30}$/.test(String(e.custom_emoji_id)))?.custom_emoji_id;
    const value=text==='/empty'?'':found||text;
    if(value&&!/^\d{10,30}$/.test(value)){await sendText(env,uid,'❌ أرسل رمزاً متحركاً حقيقياً أو رقم custom_emoji_id، أو /empty.');return true;}
    await db.prepare('UPDATE products SET custom_emoji_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(value||null,id).run();
    await clearSession(db,uid);
    await audit(db,uid,'set_product_emoji','product',id);
    await sendText(env,uid,'✅ تم حفظ رمز المنتج.',keyboard([button('📦 تفاصيل المنتج',`admin_product:${id}`)],adminBack));
    return true;
  }
  if(session.action==='owner_product_field'){
    const {id,field}=session.payload||{};
    const valid=validatedProductValue(field,text==='/empty'&&field.endsWith('_en')?'':text);
    if(!valid.ok){await sendText(env,uid,'❌ '+valid.message);return true;}
    const res=await db.prepare(`UPDATE products SET ${field}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(valid.value,id).run();
    await clearSession(db,uid);
    if(res.meta?.changes)await audit(db,uid,'edit_'+field,'product',id);
    await sendText(env,uid,res.meta?.changes?'✅ تم تحديث المنتج.':'لم يتم العثور على المنتج.',keyboard([button('📦 تفاصيل المنتج',`admin_product:${id}`)],adminBack));
    return true;
  }
  if(session.action==='owner_category_field'){
    const {id,field}=session.payload||{};
    const limit=field==='title'||field==='title_en'?70:8;
    if(!['title','title_en','emoji'].includes(field)||(!text&&field!=='title_en')||text.length>limit){await sendText(env,uid,`أدخل قيمة لا تتجاوز ${limit} أحرف.`);return true;}
    const res=await db.prepare(`UPDATE categories SET ${field}=? WHERE id=?`).bind(text==='/empty'&&field==='title_en'?null:text,id).run();
    await clearSession(db,uid);
    if(res.meta?.changes)await audit(db,uid,'edit_'+field,'category',id);
    await sendText(env,uid,res.meta?.changes?'✅ تم تحديث القسم.':'القسم غير موجود.',keyboard([button('📂 عرض القسم',`admin_category:${id}`)],adminBack));
    return true;
  }
  if(session.action==='owner_user_search'){
    await clearSession(db,uid);
    await userLookup(db,env,uid,text);
    return true;
  }
  return false;
}
