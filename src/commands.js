// Native Telegram three-line Commands menu, not ReplyKeyboardMarkup.
export const CUSTOMER_COMMANDS=Object.freeze([
  {command:'start',description:'ابدأ استخدام البوت'},
  {command:'menu',description:'القائمة الرئيسية'},
  {command:'shop',description:'فتح المتجر'},
  {command:'topup',description:'شحن المحفظة'},
  {command:'wallet',description:'رصيد محفظتي'},
  {command:'profile',description:'الملف الشخصي'},
  {command:'orders',description:'طلباتي'},
  {command:'history',description:'سجل العمليات'},
  {command:'favorites',description:'المفضلة'},
  {command:'currency',description:'تغيير العملة'},
  {command:'support',description:'الدعم الفني'}
]);
export const OWNER_COMMANDS=Object.freeze([
  ...CUSTOMER_COMMANDS,
  {command:'admin',description:'لوحة تحكم المدير'}
]);
