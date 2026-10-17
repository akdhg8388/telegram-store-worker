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

// Telegram chooses these when the customer's Telegram app is in English.
// The in-bot language selector is independent and persists in D1.
const EN_COMMAND_TEXT=Object.freeze({
  start:'Start the bot',menu:'Main menu',shop:'Browse the store',topup:'Top up wallet',
  wallet:'My wallet balance',profile:'My profile',orders:'My orders',
  history:'Transaction history',favorites:'Saved favorites',currency:'Change currency',
  support:'Contact support',admin:'Owner control panel'
});
export const CUSTOMER_COMMANDS_EN=Object.freeze(CUSTOMER_COMMANDS.map(c=>({command:c.command,description:EN_COMMAND_TEXT[c.command]})));
export const OWNER_COMMANDS_EN=Object.freeze(OWNER_COMMANDS.map(c=>({command:c.command,description:EN_COMMAND_TEXT[c.command]})));
