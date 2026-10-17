import {button,keyboard,short,formatStars,formatIQD,positiveInt,isAdmin} from './common.js';
import {sendText,sendOrEditText,telegram} from './telegram.js';
import {updateBotProfilePicture} from './bot-profile.js';
import {setSession,getSession,clearSession,audit,getUser} from './database.js';
import {SETTING_FIELDS,getSetting,validateSetting,updateSetting} from './settings.js';
import {usdRate,receiverFor} from './wallet.js';
import {DEFAULT_HOME_TEMPLATE,preserveCustomEmojiInTemplate} from './presentation.js';
import {home as customerHomePreview} from './ui.js';
import {restrictionLabel} from './moderation.js';

const adminBack=[button('🛡️ لوحة المدير','admin')];
const backTo=(destination)=>[button('⬅️ رجوع',destination)];

export function adminRoute(data){
  return /^(?:admin_bot_intro|admin_bot_photo_edit|admin_bot_photo_remove|admin_counter|admin_counter_edit|admin_counter_reset|admin_toggle_support_direct|admin_support_contact|admin_visuals|admin_visual_preview|admin_visual_reset|admin_visual_reset_confirm|admin_topup_setup|admin_rate_1520|admin_stats|admin_settings(?::\d+)?|admin_setting:[a-z_]+|admin_toggle_store|admin_toggle_topups|admin_products(?::\d+)?|admin_product:\d+|admin_product_field:\d+:[a-z_]+|admin_product_toggle:\d+:[a-z_]+|admin_product_categories:\d+|admin_product_move:\d+:\d+|admin_manage_categories|admin_category:\d+|admin_category_field:\d+:[a-z_]+|admin_category_toggle:\d+|admin_user_toggle:\d+|admin_find_user|admin_help)$/.test(data);
}

async function stats(db,env,uid,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const [users,products,categories,pending,paid,topups,sales]=await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM users').first(),
    db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').first(),
    db.prepare('SELECT COUNT(*) n FROM categories WHERE active=1').first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='awaiting_admin'").first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid_pending_delivery'").first(),
    db.prepare("SELECT COUNT(*) n FROM topup_requests WHERE status='pending'").first(),
    db.prepare("SELECT COUNT(*) orders_count,COALESCE(SUM(total_stars),0) stars FROM orders WHERE status='delivered'").first()
  ]);
  return reply(`📊 إحصائيات المتجر\n\n👥 المستخدمون: ${users.n}\n🛍️ المنتجات المنشورة: ${products.n}\n📂 الأقسام النشطة: ${categories.n}\n⏳ طلبات الشراء المعلقة: ${pending.n}\n📦 مدفوع بانتظار التسليم: ${paid.n}\n💳 طلبات الشحن المعلقة: ${topups.n}\n✅ الطلبات المكتملة: ${sales.orders_count}\n⭐ نجوم الطلبات المكتملة: ${sales.stars}\n\nملاحظة: إحصاء الإيرادات هو عدد نجوم الطلبات، وليس الأرباح الصافية.`,keyboard(adminBack));
}

async function settings(db,env,uid,page=0,messageId=null){
  const reply=(text,markup)=>sendOrEditText(env,uid,text,markup,messageId);
  const entries=Object.entries(SETTING_FIELDS).filter(([,def])=>!def.internal);
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
  const fallback=key==='home_template'?DEFAULT_HOME_TEMPLATE:key==='store_name'?env.STORE_NAME:key==='news_url'?env.NEWS_URL:key==='support_url'?env.SUPPORT_URL:key==='store_enabled'?'true':key==='manual_topups_enabled'?env.ENABLE_MANUAL_TOPUPS||'false':'';
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
  const items=(await db.prepare('SELECT id,title,price_stars,active,stock FROM products ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize+1,Math.max(0,page)*pageSize).all()).results??[];
  const rows=items.slice(0,pageSize).map(p=>[button(`${p.active?'🟢':'🔴'} #${p.id} ${short(p.title,23)} • ${formatStars(p.price_stars)}`,`admin_product:${p.id}`)]);
  const nav=[];
  if(page>0)nav.push(button('⬅️ السابق',`admin_products:${page-1}`));
  if(items.length>pageSize)nav.push(button('التالي ➡️',`admin_products:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([button('➕ إضافة منتج','admin_addproduct')],adminBack);
  return reply('📦 إدارة المنتجات\n\nيمكنك تغيير السعر والوصف والمخزون والتعليمات وحالة العرض من الأزرار. المنتجات المخفية تبقى في السجل.',keyboard(...rows));
}
const PRODUCT_FIELDS={
  title:{label:'🏷️ الاسم',max:150},
  description:{label:'📝 الوصف',max:1800},
  price_stars:{label:'⭐ السعر',integer:true,min:1,max:10000000},
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
  for(const fields of [['title','description'],['price_stars','stock'],['duration_months','delivery_instructions']])
    rows.push(fields.map(f=>button(PRODUCT_FIELDS[f].label,`admin_product_field:${id}:${f}`)));
  rows.push([button('📂 نقل إلى قسم آخر',`admin_product_categories:${id}`)]);
  rows.push([button(p.active?'🚫 إخفاء المنتج':'✅ إظهار المنتج',`admin_product_toggle:${id}:active`,p.active?'danger':'success'),
             button(p.featured?'⭐ إلغاء التمييز':'🌟 تمييز المنتج',`admin_product_toggle:${id}:featured`)]);
  rows.push(backTo('admin_products:0'),adminBack);
  return reply(`📦 المنتج #${p.id}\n\n🏷️ ${short(p.title,120)}\n📂 ${short(p.category_title,80)}\n💰 ${formatStars(p.price_stars)}\n📦 المخزون: ${p.stock??'غير محدود'}\n🗓️ المدة: ${p.duration_months??'غير محددة'}\n📢 النشر: ${p.active?'ظاهر':'مخفي'}\n🌟 مميز: ${p.featured?'نعم':'لا'}\n📝 الوصف: ${short(p.description,500)||'—'}\n📬 تعليمات التسليم: ${short(p.delivery_instructions,500)||'—'}`,keyboard(...rows));
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
    [button('↩️ إعادة رسالة الترحيب الأصلية','admin_visual_reset','danger')],
    [button('👁️ معاينة الرئيسية بالبيانات الحقيقية','admin_visual_preview','success')],
    [button('✨ رمز الرئيسية','admin_setting:home_custom_emoji_id','primary'),button('✨ رمز المتجر','admin_setting:shop_custom_emoji_id','primary')],
    [button('✨ رمز الملف','admin_setting:profile_custom_emoji_id','primary'),button('✨ رمز المحفظة','admin_setting:wallet_custom_emoji_id','primary')],
    [button('✨ رمز الطلبات','admin_setting:orders_custom_emoji_id','primary'),button('✨ رمز الدعم','admin_setting:support_custom_emoji_id','primary')],
    [button('🛡️ لوحة المدير','admin','primary')]),messageId);
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
  else if(data.startsWith('admin_settings'))await settings(db,env,uid,Math.min(10,positiveInt(data.split(':')[1])??0),messageId);
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
    if(!['title','emoji'].includes(field)||!positiveInt(id))return true;
    await setSession(db,uid,'owner_category_field',{id:Number(id),field});
    await sendText(env,uid,`✏️ أرسل ${field==='title'?'اسم القسم الجديد':'الرمز التعبيري'} للقسم #${id}. للإلغاء /cancel.`);
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
  else if(data==='admin_help')await sendText(env,uid,'📖 دليل الإدارة\n\n• تعديل الأسعار والنصوص من الأزرار داخل لوحة المدير.\n• الطلبات والمدفوعات لا تكتمل دون مراجعتك.\n• إخفاء منتج لا يمسح الطلبات القديمة.\n• أسرار Cloudflare وهوية المدير لا يمكن تغييرهما من داخل البوت.\n• لتفعيل طلبات الشحن، أدخل سعر الصرف وبيانات استلام رصيد زين أو سوبر كي أو Binance، ثم فعّل الزر من الإعدادات. لا تستخدم الرصيد الداخلي بديلاً عن Stars لبيع الخدمات الرقمية.\n• للتراجع عن أي عملية تحرير: /cancel.',keyboard(adminBack));
  return true;
}

export async function handleAdminText(db,env,uid,session,message){
  if(!isAdmin(env,uid))return false;
  const text=String(message.text??'').trim();
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
    const raw=key==='home_template' ? preserveCustomEmojiInTemplate(text,message.entities||[])
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
  if(session.action==='owner_product_field'){
    const {id,field}=session.payload||{};
    const valid=validatedProductValue(field,text);
    if(!valid.ok){await sendText(env,uid,'❌ '+valid.message);return true;}
    const res=await db.prepare(`UPDATE products SET ${field}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(valid.value,id).run();
    await clearSession(db,uid);
    if(res.meta?.changes)await audit(db,uid,'edit_'+field,'product',id);
    await sendText(env,uid,res.meta?.changes?'✅ تم تحديث المنتج.':'لم يتم العثور على المنتج.',keyboard([button('📦 تفاصيل المنتج',`admin_product:${id}`)],adminBack));
    return true;
  }
  if(session.action==='owner_category_field'){
    const {id,field}=session.payload||{};
    const limit=field==='title'?70:8;
    if(!['title','emoji'].includes(field)||!text||text.length>limit){await sendText(env,uid,`أدخل قيمة لا تتجاوز ${limit} أحرف.`);return true;}
    const res=await db.prepare(`UPDATE categories SET ${field}=? WHERE id=?`).bind(text,id).run();
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
