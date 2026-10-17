// Explicit owner-selected policy. No warranty is inferred from product category.
// A purchase keeps a snapshot so later owner edits cannot rewrite an old sale.
export function warrantyLine(record,language='ar'){
  if(!record || Number(record.warranty_visible)!==1)return '';
  const english=language==='en',hasWarranty=Number(record.warranty_available)===1;
  const headline=english
    ?`🛡️ Warranty: ${hasWarranty?'Warranty included':'No warranty'}`
    :`🛡️ الضمان: ${hasWarranty?'يوجد ضمان':'لا يوجد ضمان'}`;
  if(!hasWarranty)return headline;
  const terms=String(english?record.warranty_terms_en||'':record.warranty_terms_ar||'').trim().slice(0,500);
  return terms?`${headline}\n${english?'📋 Warranty details:':'📋 تفاصيل الضمان:'} ${terms}`:headline;
}
