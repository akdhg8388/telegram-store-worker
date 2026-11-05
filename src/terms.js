import {button,keyboard,backRow} from './common.js';
import {getSetting} from './settings.js';
import {sendOrEditText} from './telegram.js';

// Initial policy mirrors the example supplied by the store owner. The complete
// body may be replaced through the existing admin terms_text setting.
export const DEFAULT_TERMS=`📜 سياسة الروبوت

نحن نؤمن بالشفافية الكاملة مع عملائنا ولا نهدف أبداً إلى إزعاج أو استغلال أي شخص. يرجى قراءة السياسة التالية بعناية قبل استخدام خدماتنا:

1️⃣ سياسة استرداد الأموال:

• الأموال المودعة في البوت غير قابلة للاسترداد خارج البوت إلا وفق الحالات التي يوافق عليها المسؤول.

• إذا قمت بإيداع أموال ولم تشترِ أي منتج أو خدمة، أو لم تكتمل المعاملة، يمكن إعادة المبلغ إلى رصيدك داخل البوت، وليس كتحويل مالي مباشر.

• إذا طلب العميل استرداد المبلغ بعد شراء منتج أو خدمة وكانت فترة استخدامها أقل من 15 يوماً، فقد تتم إعادة 50% من المبلغ فقط كرصيد داخل البوت، وفق شروط المنتج ومراجعة الإدارة.

2️⃣ سياسة الضمان:

• نضمن المنتجات أو الخدمات التي يُذكر صراحةً أنها تتضمن ضماناً خلال الفترة المحددة لها.

• إذا حدثت مشكلة مشمولة بالضمان، سنراجع الطلب ونعمل على استبدال الخدمة أو تعويض العميل وفق شروط الضمان الخاصة بالمنتج.

• إذا تعذّر توفير بديل، فقد يُعاد المبلغ المستحق كرصيد داخل البوت يمكن استخدامه لشراء منتج أو خدمة أخرى.

• المنتجات والخدمات التي تُباع دون ضمان لا تشمل تعويضاً أو استبدالاً تلقائياً، مع الحفاظ على الحقوق المقررة قانوناً.

3️⃣ سياسة الشراء:

• يرجى قراءة وصف المنتج وشروط ضمانه والتأكد من اختياره قبل إتمام الدفع.

• إذا اشترى العميل المنتج أو الخدمة بالخطأ، فستُراجع إمكانية الاستبدال أو الاسترداد وفق طبيعة المنتج وحالته وحقوق المستهلك المعمول بها.

• يتحمل العميل مسؤولية التحقق من تفاصيل المنتج أو الخدمة قبل إتمام الدفع.

4️⃣ التزامنا:

• نحن مسؤولون عن خدماتنا ونسعى دائماً لتقديم أفضل جودة ممكنة دون التسبب بإزعاج أو ضرر لعملائنا.

5️⃣ الموافقة على الشروط:

• بشرائك أي منتج أو خدمة من المتجر، فأنت تقر باطلاعك على هذه السياسة والموافقة عليها، ضمن ما يسمح به القانون.

6️⃣ وعدنا:

• نعد بأن نكون صادقين وشفافين دائماً مع عملائنا، وأن نعمل باستمرار على تقديم أفضل الخدمات بأعلى جودة ممكنة.

🍀 يُمنع الشتم أو السب أو القذف أو الإساءة إلى الآخرين، وقد يؤدي السلوك المسيء إلى تقييد التواصل مع الدعم.`;

const SIMPLE_HEADING=/^(?:📜\s*سياسة الروبوت|[1-9]️⃣\s*.+[:：]?\s*|(?:\d+[.)]\s*).+)$/u;

// Plain text is displayed without HTML / Markdown parsing. One whole-line
// **bold marker** is optional for owner-defined headings; explanatory text stays
// normal. Telegram offsets are measured in UTF-16, exactly as JS strings.
export function formatTerms(body){
  const input=String(body||DEFAULT_TERMS).trim();
  const textLines=[],entities=[];
  let offset='📜 شروط الاستخدام\n\n'.length;
  for(const source of input.split(/\r?\n/)){
    const raw=source.trimEnd();
    const explicit=/^\s*\*\*(.+?)\*\*\s*$/.exec(raw);
    const line=explicit?explicit[1]:raw;
    const heading=Boolean(explicit)||SIMPLE_HEADING.test(line.trim());
    if(heading&&line.trim())entities.push({type:'bold',offset,length:line.length});
    textLines.push(line);
    offset+=line.length+1;
  }
  const text='📜 شروط الاستخدام\n\n'+textLines.join('\n');
  entities.unshift({type:'bold',offset:0,length:'📜 شروط الاستخدام'.length});
  return {text,entities};
}
export async function termsPage(db,env,uid,messageId=null){
  const content=await getSetting(db,'terms_text','');
  const formatted=formatTerms(content);
  // The configured text is max 3500 characters. The heading still fits into
  // the 4000-char Telegram text safe limit, without slicing legal terms.
  return sendOrEditText(env,uid,formatted.text,keyboard(
    [button('❌ الرجوع إلى الرئيسية','home','danger')]),messageId,
    {entities:formatted.entities,preserveText:true});
}
