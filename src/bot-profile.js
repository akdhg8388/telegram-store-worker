import {telegram} from './telegram.js';

// Telegram profile photos are *not* the large Description Picture shown before
// pressing Start. That picture can only be changed with @BotFather.
export async function updateBotProfilePicture(env,fileId,{request=fetch,telegramCall=telegram}={}){
  if(typeof fileId!=='string'||fileId.length<5)throw new Error('Invalid photo');
  const metadata=await telegramCall(env,'getFile',{file_id:fileId});
  if(!metadata?.file_path || (metadata.file_size && metadata.file_size>5_000_000))
    throw new Error('Photo unavailable or too large');
  const fileUrl=`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadata.file_path}`;
  const downloaded=await request(fileUrl,{signal:AbortSignal.timeout(25000)});
  if(!downloaded.ok)throw new Error('Unable to download Telegram photo');
  const bytes=await downloaded.arrayBuffer();
  if(bytes.byteLength>5_000_000 || bytes.byteLength<4)throw new Error('Invalid file size');
  const array=new Uint8Array(bytes);
  if(array[0]!==0xff||array[1]!==0xd8||array[array.length-2]!==0xff||array[array.length-1]!==0xd9)
    throw new Error('Telegram photo was not JPEG');
  const form=new FormData();
  form.append('photo',JSON.stringify({type:'static',photo:'attach://avatar'}));
  form.append('avatar',new Blob([bytes],{type:'image/jpeg'}),'avatar.jpg');
  const uploaded=await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyProfilePhoto`,{
    method:'POST',body:form,signal:AbortSignal.timeout(25000)
  });
  const result=await uploaded.json().catch(()=>null);
  if(!uploaded.ok || !result?.ok)throw new Error('Telegram refused the profile photo');
  return true;
}
