// Telegram uses UTF-16 offsets; JavaScript string lengths match that requirement.
export function boldEntities(text){return [{type:'bold',offset:0,length:String(text).length}];}
