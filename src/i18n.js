import {ADMIN_EN} from './i18n-admin.js';
// English is a presentation choice only. IDs, prices, credentials, callback routes
// and the original owner-authored product content remain unchanged in D1.
export const languageOf=env=>env?.__locale==='en'?'en':'ar';
export const choice=(env,ar,en)=>languageOf(env)==='en'?en:ar;
export async function userLanguage(db,uid){
  if(!uid)return 'ar';
  const row=await db.prepare('SELECT language FROM users WHERE tg_id=?').bind(uid).first();
  return row?.language==='en'?'en':'ar';
}

// Fixed UI vocabulary shared by customer and owner paths. Replacements are sorted
// longest first so a short label cannot corrupt a longer translated phrase.
// Owner-created product descriptions/account credentials are not translated.
const pairs=[
['👋 أهلاً بك في','👋 Welcome to'],['اشترِ المنتجات الرقمية مباشرة من هنا.','Buy digital products instantly from our store.'],
['💰 رصيدك:','💰 Your balance:'],['👤 الاسم:','👤 Name:'],['🆔 المعرّف:','🆔 ID:'],['👥 المستخدمون:','👥 Users:'],
['🛍️ المنتجات المتوفرة في المتجر:','🛍️ Products available in the store:'],['لا توجد منتجات منشورة هنا حالياً.','There are no published products here right now.'],
['🛍️ أقسام المتجر','🛍️ Store Categories'],['اختر القسم الذي تريده:','Choose a category:'],
['هذا المنتج غير متوفر حالياً.','This product is currently unavailable.'],['لا يوجد وصف إضافي.','No additional description.'],
['حسب تفاصيل الخدمة','As described in the service'],['حسب المنتج','As specified for the product'],
['المخزون الجاهز:','Available stock:'],['غير متوفر •','Unavailable •'],['🟢 متوفر','🟢 Available'],['غير متاح','Unavailable'],['متوفر','Available'],
['لم يحدد المدير سعر المحفظة لهذا المنتج بعد.','The owner has not set a wallet price for this product yet.'],
['نفد مخزون المنتج.','This product is out of stock.'],['محتوى التسليم غير مهيأ بعد.','Delivery content has not been configured yet.'],
['نفدت بيانات التسليم الجاهزة.','No delivery items are left in stock.'],['التسليم التلقائي غير مفعّل لهذا المنتج.','Automatic delivery is disabled for this product.'],
['✅ يتم التسليم تلقائياً بعد الشراء من المحفظة.','✅ Delivered automatically after wallet payment.'],
['⛔ لا يمكن الشراء حتى يجهّز المدير بيانات التسليم.','⛔ Purchasing is disabled until delivery data is ready.'],
['يتم التسليم تلقائياً بعد الشراء من المحفظة.','Delivered automatically after wallet payment.'],
['لا يمكن الشراء حتى يجهّز المدير بيانات التسليم.','Purchasing is disabled until delivery data is ready.'],
['🛒 شراء فوري من المحفظة','🛒 Buy Now with Wallet'],['🔄 تحديث المخزون','🔄 Refresh Stock'],
['💔 إزالة من المفضلة','💔 Remove from Favorites'],['💗 إضافة للمفضلة','💗 Add to Favorites'],
['💱 تغيير العملة 🇮🇶/🇺🇸','💱 Change Currency 🇮🇶/🇺🇸'],['💎 المنتجات المميزة','💎 Featured Products'],
['👤 ملفي الشخصي','👤 My Profile'],['📜 سجل العمليات','📜 Transaction History'],['👥 الإحالات','👥 Referrals'],
['🛍️ جميع المنتجات','🛍️ All Products'],['🛍️ المتجر','🛍️ Shop'],['🛍️ الأقسام','🛍️ Categories'],['🔎 البحث','🔎 Search'],['🔎 بحث','🔎 Search'],
['💳 محفظتي','💳 My Wallet'],['💳 المحفظة','💳 Wallet'],['📦 طلباتي','📦 My Orders'],['🌐 اللغة','🌐 Language'],['🎧 الدعم','🎧 Support'],['📢 الأخبار','📢 News'],
['🛡️ لوحة تحكم المدير','🛡️ Admin Panel'],['🏠 الرئيسية','🏠 Home'],['↩️ الرجوع للرئيسية','↩️ Back to Home'],
['👤 الملف الشخصي','👤 Profile'],['👤 الاسم','👤 Name'],['◀المسؤول▶','◀Owner▶'],
['🪪 المعرّف —','🪪 Telegram ID —'],['💳 الرصيد —','💳 Balance —'],['👥 الإحالات —','👥 Referrals —'],['🛒 المنتجات المشتراة —','🛒 Purchases —'],
['💳 شحن الرصيد','💳 Top Up Balance'],['💗 المفضلة','💗 Favorites'],['📑 سجل العمليات','📑 Transaction History'],
['💳 شحن المحفظة','💳 Top Up Wallet'],['🗂️ طلبات الشحن','🗂️ Top-up Requests'],['📜 سجل المحفظة','📜 Wallet History'],
['🌐 تغيير العملة','🌐 Change Currency'],['💳 محفظتي','💳 My Wallet'],['💳 المحفظة','💳 Wallet'],
['لم تُفعّل من الإدارة بعد.','have not been enabled by the owner yet.'],
['✅ يمكنك إرسال طلب شحن لمراجعته من الإدارة.','✅ You may submit a top-up request for owner approval.'],
['⏳ شحن المحفظة لم يُفعّل من الإدارة بعد.','⏳ Wallet top-ups have not been enabled yet.'],
['🔒 لا يُضاف أي رصيد حتى يؤكد المدير وصول التحويل.','🔒 No balance is added until the owner verifies receipt.'],
['لم تُحدد بعد','Not configured yet'],['الدولار غير مهيأ بعد','USD conversion is not configured yet'],
['💳 طلبات شحن المحفظة','💳 Wallet Top-up Requests'],['💳 طلب شحن','💳 Top-up Request'],
['💳 اختيار طريقة الشحن','💳 Choose Top-up Method'],['💰 رصيدك:','💰 Your balance:'],['🏷️ عملة العرض:','🏷️ Display Currency:'],
['💱 السعر المعتمد:','💱 Exchange Rate:'],['💱 السعر المعتمد من الإدارة:','💱 Owner-set Rate:'],
['💱 سعر الصرف المعتمد:','💱 Exchange Rate:'],['⚠️ يحتاج عرض الدولار إلى تحديد سعر الصرف من المدير.','⚠️ The owner must set a USD rate to show USD prices.'],
['🌐 اختر عملة عرض المحفظة والشحن','🌐 Choose Wallet & Top-up Currency'],['الحالية:','Current:'],
['لا يؤدي اختيار العملة إلى تحويل الرصيد أو إنشاء أموال جديدة.','Changing currency only changes the display; your balance remains unchanged.'],
['⚠️ سعر الصرف لم يُحدد بعد من الإدارة؛ لن تظهر أرقام تحويل تخمينية.','⚠️ No exchange rate has been set; estimated conversions will not be shown.'],
['🇮🇶 الدينار العراقي IQD','🇮🇶 Iraqi Dinar IQD'],['🇺🇸 الدولار الأمريكي USD','🇺🇸 US Dollar USD'],
['📜 سجل المحفظة','📜 Wallet History'],['لا توجد عمليات داخلية مسجلة حتى الآن.','No wallet transactions yet.'],
['📦 مشترياتي وتسليماتي','📦 My Purchases & Deliveries'],['🛍️ الطلبات القديمة','🛍️ Previous Orders'],
['✅ مشتريات المحفظة المسلّمة:','✅ Wallet Purchases Delivered:'],
['اضغط «مشترياتي وتسليماتي» لعرض المنتجات والصور وتعليمات الاستخدام.','Tap “My Purchases & Deliveries” to view your items, images, and instructions.'],
['لا توجد طلبات بالنظام السابق.','No orders in the previous system.'],['لا توجد طلبات شحن.','No top-up requests.'],
['📨 رسائلي — ردود الدعم','📨 My Messages — Support Replies'],['💳 متابعة شحن','💳 Track Top-up'],
['💗 المفضلة — منتجاتك المحفوظة:','💗 Favorites — Your saved products:'],
['ليس لديك منتجات مفضلة.','You have no favorite products yet.'],['غير مسعر','Not priced'],['غير مسعّر','Not priced'],
['لا يمكن تحديد المبلغ قبل ضبط سعر الصرف.','The owner must configure the exchange rate first.'],
['اختر المبلغ المطلوب','Choose an amount'],['اختر طريقة التحويل من الخيارات المتاحة.','Choose a transfer method below.'],
['⚠️ لا توجد طرق شحن مهيأة حالياً. أضف أرقام/حسابات الاستلام من لوحة الإدارة.','⚠️ No top-up methods are configured yet. Contact the owner.'],
['📸 أرسل الآن *رقم التحويل* أو *صورة إثبات الحوالة*.','📸 Now send the *transfer reference* or a *proof-of-payment photo*.'],
['ستظهر شاشة مراجعة نهائية قبل رفع الطلب للمدير.','You will review the details before submitting to the owner.'],
['⚠️ لا تعتمد على الإيصال وحده؛ المدير يتحقق من وصول المبلغ فعلياً.','⚠️ The owner verifies the actual transfer before approving.'],
['📋 مراجعة طلب شحن المحفظة','📋 Review Wallet Top-up'],['يرجى التأكد من صحة البيانات قبل إرسال الطلب.','Please verify all details before submitting.'],
['🔔 ستصلك رسالة عند تحديث حالة الطلب، ويمكنك متابعته من قسم 📦 طلباتي.','🔔 We will notify you when the status changes. Track it under 📦 My Orders.'],
['💰 المبلغ:','💰 Amount:'],['💰 المبلغ المطلوب:','💰 Requested Amount:'],['💰 المطلوب:','💰 Requested:'],
['💳 وسيلة الدفع:','💳 Payment Method:'],['💸 الطريقة:','💸 Method:'],['💸 الوسيلة:','💸 Method:'],
['🔢 رقم العملية:','🔢 Reference:'],['🔢 رقم الحوالة:','🔢 Transfer Reference:'],['📸 إثبات التحويل:','📸 Payment Proof:'],
['📷 الإثبات:','📷 Proof:'],['✅ مرفق','✅ Attached'],['غير مرفق','Not attached'],['غير متوفر','Unavailable'],
['✅ تأكيد وإرسال الطلب','✅ Confirm & Submit'],['❌ إلغاء','❌ Cancel'],['↩️ إلغاء الطلب','↩️ Cancel Request'],
['🔄 تحديث الحالة','🔄 Refresh Status'],['📦 طلباتي','📦 My Orders'],
['🎧 مركز الدعم الفني','🎧 Support Center'],['اختر طريقة التواصل المناسبة:','Choose how you would like to contact support:'],
['💬 تواصل مع الدعم الفني','💬 Contact Support'],['👤 تواصل مباشر مع المسؤول','👤 Contact the Owner'],
['📦 المنتج:','📦 Product:'],['🛍️ المنتج:','🛍️ Product:'],['📦 الخدمة:','📦 Service:'],
['⏳ المدة:','⏳ Duration:'],['💰 السعر:','💰 Price:'],['🛍️ السعر:','🛍️ Price:'],['📦 المخزون:','📦 Stock:'],
['🛒 تأكيد الشراء من المحفظة','🛒 Confirm Wallet Purchase'],['📉 الناقص:','📉 Amount Needed:'],
['💳 رصيد المحفظة غير كافٍ.','💳 Insufficient wallet balance.'],['👛 رصيدك الحالي:','👛 Your Balance:'],['👛 رصيدك:','👛 Your Balance:'],
['يرجى شحن محفظتك للمتابعة.','Please top up your wallet to continue.'],['➕ شحن المحفظة','➕ Top Up Wallet'],
['✅ سيتم خصم المبلغ مرة واحدة وتسليم المحتوى المتاح فوراً.','✅ You will be charged once and your item will be delivered immediately.'],
['✅ تأكيد الشراء الفوري','✅ Confirm Instant Purchase'],['↩️ رجوع للمنتج','↩️ Back to Product'],
['✅ تم الشراء والتسليم بنجاح!','✅ Purchase and delivery successful!'],['🧾 العملية:','🧾 Purchase ID:'],
['📝 التفاصيل:','📝 Details:'],['💰 المبلغ المخصوم:','💰 Amount Charged:'],['💳 رصيدك المتبقي:','💳 Remaining Balance:'],
['📅 التاريخ والوقت:','📅 Date & Time:'],['📦 بيانات المنتج المستلم:','📦 Delivered Item:'],
['📖 طريقة الاستخدام:','📖 How to Use:'],['لم يضف المدير تعليمات إضافية.','The owner has not provided additional instructions.'],
['📦 مشترياتي من المحفظة','📦 My Wallet Purchases'],['اختر عملية لعرض تفاصيل المنتج والصورة وطريقة الاستخدام.','Select a purchase to view its details, photo and instructions.'],
['لم تشترِ منتجات من المحفظة بعد.','You have not made any wallet purchases yet.'],['📦 مشترياتي','📦 My Purchases'],
['لم يعد هذا المنتج متوفراً. لم يُخصم شيء.','This product is no longer available. No money was charged.'],
['رصيد المحفظة غير كافٍ. يرجى شحن محفظتك.','Insufficient wallet balance. Please top up.'],
['تغير الرصيد أو المخزون قبل تأكيد العملية. لم يُخصم شيء إذا لم يُسجل طلب ناجح.','Balance or stock changed before confirmation. No charge was made unless a successful order was recorded.'],
['لا توجد عملية شراء بهذا الرقم لحسابك.','No purchase with this ID belongs to your account.'],
['🖼️ صورة','🖼️ Photo of'],['عملية #','Purchase #'],
['🔎 أدخل اسم المنتج الذي تبحث عنه. للإلغاء /cancel.','🔎 Enter the product name to search. To cancel: /cancel.'],
['🎧 أرسل رسالتك الآن. للإلغاء /cancel.','🎧 Send your message now. To cancel: /cancel.'],
['لم يضف المدير قناة أخبار بعد.','The owner has not added a news channel yet.'],['📢 قناة الأخبار:','📢 News Channel:'],
['👥 برنامج الإحالات','👥 Referral Program'],['عدد الأصدقاء المدعوين:','Invited friends:'],['رابطك:','Your link:'],
['مكافآت الإحالة غير مفعّلة حالياً؛ لا توجد أرباح تلقائية من عمليات الشراء.','Referral rewards are not enabled; purchases do not generate automatic earnings.'],
['سيظهر الرابط عند ضبط BOT_USERNAME','The link will appear when BOT_USERNAME is configured'],
['⏸️ المتجر لا يستقبل مشتريات جديدة حالياً.','⏸️ The store is not accepting new purchases right now.'],
['⏸️ المتجر أوقف استقبال الشراء مؤقتاً.','⏸️ Purchasing is temporarily paused.'],
['انتهت صلاحية هذا التأكيد. افتح المنتج مجدداً.','This confirmation has expired. Open the product again.'],
['هذا الزر يعود لنظام شراء قديم. افتح المتجر لاستخدام نظام المحفظة الجديد.','This button belongs to the previous checkout system. Visit the store for the wallet checkout.'],
['⏳ طلبات شحن المحفظة لم تُفعّل بعد. يمكنك التواصل مع الدعم.','⏳ Wallet top-ups are not enabled yet. Contact support.'],
['⛔ أوقفت الإدارة استقبال طلبات الشحن حالياً.','⛔ The owner has temporarily disabled top-up requests.'],
['تغيرت العملة منذ عرض هذه الأزرار؛ افتح قائمة الشحن مجدداً.','Your currency changed. Reopen the top-up menu.'],
['✏️ أدخل المبلغ المخصص بعملة','✏️ Enter a custom amount in'],['مثال:','Example:'],['للإلغاء: /cancel','To cancel: /cancel'],
['انتهت هذه الخطوة. افتح شحن المحفظة وحدد المبلغ أولاً.','This step expired. Open Top Up Wallet and choose the amount again.'],
['هذه الوسيلة غير مهيأة لدى الإدارة بعد.','This payment method is not configured yet.'],
['تم تسجيل طلبك بالفعل برقم','Your request was already recorded as'],
['هذه رسالة تأكيد قديمة. افتح المحفظة وابدأ طلباً جديداً.','This confirmation is outdated. Open the wallet to start a new request.'],
['هذا الزر غير مدعوم أو انتهت صلاحيته. افتح القائمة مجدداً.','This button is unavailable or has expired. Open the menu again.'],
['اختر أحد الأقسام من القائمة الرئيسية أو اكتب /start.','Choose an option from the main menu or type /start.'],
['للشحن، افتح 💳 محفظتي أولاً.','To top up, open 💳 My Wallet first.'],
['🆔 معرف حسابك الرقمي في تيليجرام هو:','🆔 Your Telegram user ID is:'],
['هذا الطلب غير قابل للدفع حالياً.','This order cannot be paid now.'],
['الطلب غير صالح أو لم يعد متاحاً. تواصل مع الدعم.','This order is invalid or unavailable. Contact support.'],
['✅ تم تسجيل إشعار الدفع مسبقاً. يمكنك متابعة طلبك من قائمة طلباتي.','✅ This payment was already recorded. Track the order under My Orders.'],
['🔑 تسليم كود فريد','🔑 Deliver Unique Code'],['📦 تسليم محتوى ثابت','📦 Deliver Shared Content'],
['↩️ رجوع','↩️ Back'],['⬅️ رجوع','⬅️ Back'],['↩️ الرجوع','↩️ Back'],['⬅️ السابق','⬅️ Previous'],['التالي ➡️','Next ➡️'],
['غير محدود','Unlimited'],['غير محددة','Unspecified'],['غير محدد','Not specified'],['لم يحدد','Not specified'],
['قيد المراجعة','Under Review'],['تمت الموافقة','Approved'],['مرفوض','Rejected'],['مكتمل','Complete'],
['✅ مكتمل','✅ Complete'],['⏳ بانتظار موافقة المدير','⏳ Awaiting Owner Approval'],
['📦 مدفوع — قيد التجهيز','📦 Paid — Preparing Delivery'],['↩️ مسترد','↩️ Refunded'],
['د.ع','IQD'],['بتوقيت بغداد','Baghdad Time']
];
const ordered=[...pairs,...ADMIN_EN].sort((a,b)=>b[0].length-a[0].length);
export function translateUi(text,locale){
  if(locale!=='en' || typeof text!=='string')return text;
  let result=text;
  for(const [ar,en] of ordered)if(result.includes(ar))result=result.replaceAll(ar,en);
  return result;
}
export function translateMarkup(markup,locale){
  if(locale!=='en'||!markup?.inline_keyboard)return markup;
  return {...markup,inline_keyboard:markup.inline_keyboard.map(row=>row.map(btn=>{
    // Product titles and sale references may contain customer-owned or
    // license-related strings. Never rewrite that arbitrary content.
    const isDynamic=/^(?:product:|wallet_receipt:|admin_product:|admin_category:|category:)/.test(btn.callback_data||'');
    return {...btn,text:isDynamic?btn.text:translateUi(btn.text,locale)};
  }))};
}
export function translateTelegramParams(method,params,locale){
  const p={...params};
  const preserveText=p._preserve_text===true;
  delete p._preserve_text;
  if(locale!=='en')return p;
  if(['sendMessage','editMessageText','sendPhoto','sendVideo','sendInvoice','answerCallbackQuery','answerPreCheckoutQuery'].includes(method)){
    if(!preserveText)for(const name of ['text','caption','description','title','error_message'])if(typeof p[name]==='string')p[name]=translateUi(p[name],locale);
    if(p.reply_markup)p.reply_markup=translateMarkup(p.reply_markup,locale);
  }
  return p;
}
