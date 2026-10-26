// Telegram's native three-line Commands menu. No ReplyKeyboard is required.
// Telegram displays these commands to all private-chat customers.
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
// Owner-only commands are installed with BotCommandScopeChat; bot.js still
// independently verifies ADMIN_ID on every privileged action.
export const OWNER_COMMANDS=Object.freeze([
  ...CUSTOMER_COMMANDS,
  {command:'admin',description:'لوحة تحكم المدير'}
]);

// Compatibility exports always use the same Arabic commands for every device locale.
export const CUSTOMER_COMMANDS_EN=CUSTOMER_COMMANDS;
export const OWNER_COMMANDS_EN=OWNER_COMMANDS;
