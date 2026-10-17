import {button,keyboard,short,formatStars,formatIQD,positiveInt,isAdmin} from './common.js';
import {sendText} from './telegram.js';
import {setSession,clearSession,audit,getUser} from './database.js';
import {SETTING_FIELDS,getSetting,validateSetting,updateSetting} from './settings.js';

const adminBack=[button('🛡️ لوحة المدير','admin')];
const backTo=(destination)=>[button('⬅️ رجوع',destination)];

export function adminRoute(data){
  return /^(?:admin_stats|admin_settings(?::\d+)?|admin_setting:[a-z_]+|admin_toggle_store|admin_products(?::\d+)?|admin_product:\d+|admin_product_field:\d+:[a-z_]+|admin_product_toggle:\d+:[a-z_]+|admin_product_categories:\d+|admin_product_move:\d+:\d+|admin_manage_categories|admin_category:\d+|admin_category_field:\d+:[a-z_]+|admin_category_toggle:\d+|admin_user_toggle:\d+|admin_find_user|admin_help)$/.test(data);
}

async function stats(db,env,uid){
  const [users,products,categories,pending,paid,topups,sales]=await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM users').first(),
    db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').first(),
    db.prepare('SELECT COUNT(*) n FROM categories WHERE active=1').first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='awaiting_admin'").first(),
    db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid_pending_delivery'").first(),
    db.prepare("SELECT COUNT(*) n FROM topup_requests WHERE status='pending'").first(),
    db.prepare("SELECT COUNT(*) orders_count,COALESCE(SUM(total_stars),0) stars FROM orders WHERE status='delivered'").first()
  ]);
  return sendText(env,uid,`📊 إحصائيات المتجر\n\n👥 المستخدمون: ${users.n}\n🛍️ المنتجات المنشورة: ${products.n}\n📂 الأقسام النشطة: ${categories.n}\n⏳ طلبات الشراء المعلقة: ${pending.n}\n📦 مدفوع بانتظار التسليم: ${paid.n}\n💳 طلبات الشحن المعلقة: ${topups.n}\n✅ الطلبات المكتملة: ${sales.orders_count}\n⭐ نجوم الطلبات المكتملة: ${sales.stars}\n\nملاحظة: إحصاء الإيرادات هو عدد نجوم الطلبات، وليس الأرباح الصافية.`,keyboard(adminBack));
}

async function settings(db,env,uid,page=0){
  const entries=Object.entries(SETTING_FIELDS);
  const pageSize=6, offset=Math.max(0,Math.min(page,Math.ceil(entries.length/pageSize)-1))*pageSize;
  const rows=entries.slice(offset,offset+pageSize).map(([key,def])=>[button(def.label,`admin_setting:${key}`)]);
  const nav=[];
  if(offset>0)nav.push(button('⬅️ السابق',`admin_settings:${Math.max(0,page-1)}`));
  if(offset+pageSize<entries.length)nav.push(button('التالي ➡️',`admin_settings:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push(adminBack);
  return sendText(env,uid,'⚙️ إدارة المتجر والرسائل\n\nاختر ما تريد تعديله. لا يمكن تعديل رمز البوت أو هوية المدير من داخل تيليجرام.',keyboard(...rows));
}
async function settingDetail(db,env,uid,key){
  const def=SETTING_FIELDS[key];if(!def)return sendText(env,uid,'الإعداد غير معروف.');
  const fallback=key==='store_name'?env.STORE_NAME:key==='news_url'?env.NEWS_URL:key==='support_url'?env.SUPPORT_URL:key==='store_enabled'?'true':'';
  const value=await getSetting(db,key,fallback||'');
  const rows=def.toggle?[[button(value==='false'?'✅ تشغيل استقبال الطلبات':'⏸️ إيقاف الطلبات الجديدة','admin_toggle_store',value==='false'?'success':'danger')]]:[[button('✏️ تعديل','admin_setting_edit:'+key)]];
  rows.push(backTo('admin_settings:0'),adminBack);
  return sendText(env,uid,`${def.label}\n\nالقيمة الحالية:\n${short(value||'لم يتم التحديد بعد',1750)}\n\n${def.toggle?'الإيقاف يمنع إنشاء طلبات جديدة، ولا يُلغي الطلبات المدفوعة أو المعلقة.':'اكتب نصاً جديداً عند الضغط على تعديل، أو كلمة /empty لمسح الحقول الاختيارية.'}`,keyboard(...rows));
}

async function products(db,env,uid,page=0){
  const pageSize=7;
  const items=(await db.prepare('SELECT id,title,price_stars,active,stock FROM products ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(pageSize+1,Math.max(0,page)*pageSize).all()).results??[];
  const rows=items.slice(0,pageSize).map(p=>[button(`${p.active?'🟢':'🔴'} #${p.id} ${short(p.title,23)} • ${formatStars(p.price_stars)}`,`admin_product:${p.id}`)]);
  const nav=[];
  if(page>0)nav.push(button('⬅️ السابق',`admin_products:${page-1}`));
  if(items.length>pageSize)nav.push(button('التالي ➡️',`admin_products:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([button('➕ إضافة منتج','admin_addproduct')],adminBack);
  return sendText(env,uid,'📦 إدارة المنتجات\n\nيمكنك تغيير السعر والوصف والمخزون والتعليمات وحالة العرض من الأزرار. المنتجات المخفية تبقى في السجل.',keyboard(...rows));
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
async function productDetail(db,env,uid,id){
  const p=await db.prepare('SELECT p.*,c.title category_title FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?').bind(id).first();
  if(!p)return sendText(env,uid,'المنتج غير موجود.',keyboard(adminBack));
  const rows=[];
  for(const fields of [['title','description'],['price_stars','stock'],['duration_months','delivery_instructions']])
    rows.push(fields.map(f=>button(PRODUCT_FIELDS[f].label,`admin_product_field:${id}:${f}`)));
  rows.push([button('📂 نقل إلى قسم آخر',`admin_product_categories:${id}`)]);
  rows.push([button(p.active?'🚫 إخفاء المنتج':'✅ إظهار المنتج',`admin_product_toggle:${id}:active`,p.active?'danger':'success'),
             button(p.featured?'⭐ إلغاء التمييز':'🌟 تمييز المنتج',`admin_product_toggle:${id}:featured`)]);
  rows.push(backTo('admin_products:0'),adminBack);
  return sendText(env,uid,`📦 المنتج #${p.id}\n\n🏷️ ${short(p.title,120)}\n📂 ${short(p.category_title,80)}\n💰 ${formatStars(p.price_stars)}\n📦 المخزون: ${p.stock??'غير محدود'}\n🗓️ المدة: ${p.duration_months??'غير محددة'}\n📢 النشر: ${p.active?'ظاهر':'مخفي'}\n🌟 مميز: ${p.featured?'نعم':'لا'}\n📝 الوصف: ${short(p.description,500)||'—'}\n📬 تعليمات التسليم: ${short(p.delivery_instructions,500)||'—'}`,keyboard(...rows));
}
async function categories(db,env,uid){
  const list=(await db.prepare('SELECT id,title,emoji,active FROM categories ORDER BY id DESC LIMIT 40').all()).results??[];
  const rows=list.map(c=>[button(`${c.active?'🟢':'🔴'} #${c.id} ${short(c.emoji,6)} ${short(c.title,32)}`,`admin_category:${c.id}`)]);
  rows.push([button('➕ إضافة قسم','admin_addcategory')],adminBack);
  return sendText(env,uid,'📂 إدارة الأقسام\n\nاختر قسماً لتعديل اسمه ورمزه أو إظهاره وإخفائه.',keyboard(...rows));
}
async function categoryDetail(db,env,uid,id){
  const c=await db.prepare('SELECT * FROM categories WHERE id=?').bind(id).first();
  if(!c)return sendText(env,uid,'القسم غير موجود.',keyboard(adminBack));
  return sendText(env,uid,`📂 القسم #${c.id}\n\n${c.emoji} ${c.title}\nالحالة: ${c.active?'ظاهر':'مخفي'}`,keyboard(
    [button('✏️ تعديل الاسم',`admin_category_field:${id}:title`),button('🎨 تغيير الرمز',`admin_category_field:${id}:emoji`)],
    [button(c.active?'🚫 إخفاء':'✅ إظهار',`admin_category_toggle:${id}`,c.active?'danger':'success')],backTo('admin_manage_categories'),adminBack));
}
async function userLookup(db,env,uid,input){
  const userId=positiveInt(input);if(!userId)return sendText(env,uid,'أدخل Telegram ID رقمي صحيح.');
  const u=await getUser(db,userId);if(!u)return sendText(env,uid,'هذا الحساب غير مسجل في المتجر.',keyboard(adminBack));
  const [orders,topups]=await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM orders WHERE user_tg_id=?').bind(userId).first(),
    db.prepare('SELECT COUNT(*) n FROM topup_requests WHERE user_tg_id=?').bind(userId).first(),
  ]);
  return sendText(env,uid,`👤 عميل #${userId}

الاسم: ${short(u.first_name,120)}
المعرف: ${u.username?'@'+u.username:'لا يوجد'}
الرصيد الداخلي: ${formatIQD(u.wallet_balance_iqd)}
الطلبات: ${orders.n}
طلبات الشحن: ${topups.n}
تاريخ التسجيل: ${u.joined_at}
الوضع: ${u.is_blocked?'⛔ محظور':'✅ نشط'}

يمكن إرسال رد خاص عبر: /reply ${userId} نص الرسالة`,keyboard(
    [button(u.is_blocked?'✅ رفع الحظر':'⛔ حظر الحساب',`admin_user_toggle:${userId}`,u.is_blocked?'success':'danger')],adminBack));
}

// Returns true if the callback was recognized, including denied admin access.
export async function handleAdminCallback(db,env,uid,data){
  if(!adminRoute(data) && !data.startsWith('admin_setting_edit:'))return false;
  if(!isAdmin(env,uid)){await sendText(env,uid,'⛔ هذا الإجراء غير متاح.');return true;}
  if(data==='admin_stats')await stats(db,env,uid);
  else if(data.startsWith('admin_settings'))await settings(db,env,uid,Math.min(10,positiveInt(data.split(':')[1])??0));
  else if(data==='admin_toggle_store'){
    const current=await getSetting(db,'store_enabled','true');
    await updateSetting(db,'store_enabled',current==='false'?'true':'false',uid);
    await audit(db,uid,'toggle','setting',0);
    await settingDetail(db,env,uid,'store_enabled');
  }
  else if(data.startsWith('admin_setting_edit:')){
    const key=data.substring('admin_setting_edit:'.length);
    if(!SETTING_FIELDS[key]||SETTING_FIELDS[key].toggle)return true;
    await setSession(db,uid,'owner_setting',{key});
    await sendText(env,uid,`✏️ تعديل ${SETTING_FIELDS[key].label}\n\nأرسل النص الجديد (حد أقصى ${SETTING_FIELDS[key].max} حرف).\nلمسح الحقل اكتب /empty. وللإلغاء اكتب /cancel.`);
  }
  else if(data.startsWith('admin_setting:'))await settingDetail(db,env,uid,data.substring('admin_setting:'.length));
  else if(data.startsWith('admin_products'))await products(db,env,uid,Math.min(100,positiveInt(data.split(':')[1])??0));
  else if(data.startsWith('admin_product:'))await productDetail(db,env,uid,Number(data.split(':')[1]));
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
    await productDetail(db,env,uid,Number(id));
  }
  else if(data.startsWith('admin_product_toggle:')){
    const [,id,field]=data.split(':');
    if(!['active','featured'].includes(field)||!positiveInt(id))return true;
    await db.prepare(`UPDATE products SET ${field}=CASE WHEN ${field}=1 THEN 0 ELSE 1 END, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id).run();
    await audit(db,uid,`toggle_${field}`,'product',Number(id));
    await productDetail(db,env,uid,Number(id));
  }
  else if(data==='admin_manage_categories')await categories(db,env,uid);
  else if(data.startsWith('admin_category:'))await categoryDetail(db,env,uid,Number(data.split(':')[1]));
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
    await categoryDetail(db,env,uid,id);
  }
  else if(data.startsWith('admin_user_toggle:')){
    const target=positiveInt(data.split(':')[1]);if(!target)return true;
    if(String(target)===String(uid)){
      await sendText(env,uid,'لا يمكنك حظر حساب المدير.');return true;
    }
    const res=await db.prepare('UPDATE users SET is_blocked=CASE is_blocked WHEN 1 THEN 0 ELSE 1 END WHERE tg_id=?').bind(target).run();
    if(res.meta?.changes){await audit(db,uid,'toggle_block','user',target);await userLookup(db,env,uid,String(target));}
    else await sendText(env,uid,'الحساب غير موجود.');
  }
  else if(data==='admin_find_user'){
    await setSession(db,uid,'owner_user_search');
    await sendText(env,uid,'🔎 اكتب Telegram ID للعميل الذي تريد عرض ملفه. للإلغاء /cancel.');
  }
  else if(data==='admin_help')await sendText(env,uid,'📖 دليل الإدارة\n\n• تعديل الأسعار والنصوص من الأزرار داخل لوحة المدير.\n• الطلبات والمدفوعات لا تكتمل دون مراجعتك.\n• إخفاء منتج لا يمسح الطلبات القديمة.\n• أسرار Cloudflare وهوية المدير لا يمكن تغييرهما من داخل البوت.\n• الشحن اليدوي معطل افتراضياً ولا يُستخدم بديلاً عن Telegram Stars.\n• للتراجع عن أي عملية تحرير: /cancel.',keyboard(adminBack));
  return true;
}

export async function handleAdminText(db,env,uid,session,message){
  if(!isAdmin(env,uid))return false;
  const text=String(message.text??'').trim();
  if(session.action==='owner_setting'){
    const {key}=session.payload||{};
    const valid=validateSetting(key,text==='/empty'?'':text);
    if(!valid.ok){await sendText(env,uid,'❌ '+valid.reason);return true;}
    await updateSetting(db,key,valid.value,uid);
    await audit(db,uid,'edit_'+key,'setting',0);
    await clearSession(db,uid);
    await sendText(env,uid,`✅ تم حفظ الإعداد: ${SETTING_FIELDS[key].label}`,keyboard([button('⚙️ الإعدادات','admin_settings:0')],adminBack));
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
