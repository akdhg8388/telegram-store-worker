// One unique stock unit per non-empty line. CSV supports a single column,
// optional "code" / "link" header, and quoted one-column values.
export function parseInventoryLines(text,maxItems=500){
 if(typeof text!=='string'||text.includes('\u0000')||text.length>180000)throw Error('الملف كبير جداً أو غير صالح.');
 const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(lines[0]&&/^(code|link|url|رمز|رابط)$/i.test(lines[0]))lines.shift();
 if(!lines.length||lines.length>maxItems)throw Error('يجب أن يحتوي الإدخال على 1 إلى '+maxItems+' سطر.');
 const values=lines.map(x=>{
  if(x.startsWith('"')&&x.endsWith('"'))x=x.slice(1,-1).replace(/""/g,'"');
  if(!x||x.length>1800||/[\r\n\u0000-\u001F]/.test(x)||/^(?:=|\+|@)/.test(x))throw Error('يوجد سطر غير صالح. أرسل كوداً أو رابطاً واحداً في كل سطر.');
  return x;
 });
 return {values,unique:[...new Set(values)]};
}
export async function readInventoryFile(env,document){
 const name=String(document?.file_name||'').toLowerCase();
 if(!/\.(txt|csv)$/.test(name))throw Error('أرسل ملف TXT أو CSV فقط.');
 if(!Number.isInteger(document.file_size)||document.file_size>180000||document.file_size<=0)throw Error('حجم الملف يجب ألا يتجاوز 180 كيلوبايت.');
 const token=env.TELEGRAM_BOT_TOKEN;
 const info=await fetch('https://api.telegram.org/bot'+token+'/getFile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:document.file_id})});
 const json=await info.json();
 if(!info.ok||!json.ok||!json.result?.file_path)throw Error('تعذر الحصول على ملف Telegram.');
 const path=json.result.file_path;
 if(!/^[a-zA-Z0-9_./-]+$/.test(path)||path.includes('..'))throw Error('مسار الملف غير صالح.');
 const response=await fetch('https://api.telegram.org/file/bot'+token+'/'+path);
 if(!response.ok||Number(response.headers.get('content-length')||0)>180000)throw Error('تعذر قراءة الملف أو حجمه كبير.');
 const buffer=await response.arrayBuffer();
 if(buffer.byteLength>180000)throw Error('حجم الملف كبير.');
 return new TextDecoder('utf-8',{fatal:true}).decode(buffer);
}
