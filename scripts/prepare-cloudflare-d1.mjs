// Runs in GitHub Actions. Never logs API tokens, Bot Token, or webhook secret.
import {readFileSync,writeFileSync} from 'node:fs';

const token=process.env.CLOUDFLARE_API_TOKEN;
const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token || !/^[0-9a-f]{32}$/i.test(accountId??''))throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID or missing API token.');

async function cloudflare(path,method='GET',body){
  const res=await fetch('https://api.cloudflare.com/client/v4'+path,{
    method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const data=await res.json().catch(()=>null);
  if(!res.ok || !data?.success){
    const detail=(data?.errors??[]).map(e=>e?.message).filter(Boolean).join('; ');
    throw new Error('Cloudflare D1 request failed ('+res.status+'): '+(detail||'Unknown API error'));
  }
  return data.result;
}

const endpoint='/accounts/'+accountId+'/d1/database';
const databases=await cloudflare(endpoint+'?name=telegram_store&per_page=50');
if(!Array.isArray(databases))throw new Error('Unexpected D1 list response; refusing to create a duplicate.');
const matches=databases.filter(d=>d.name==='telegram_store');
if(matches.length>1)throw new Error('More than one D1 database has this name; requires review.');
let db=matches[0];
if(!db){
  console.log('Creating D1 database telegram_store...');
  db=await cloudflare(endpoint,'POST',{name:'telegram_store'});
}
if(!/^[0-9a-f-]{36}$/i.test(db?.uuid??''))throw new Error('Unexpected D1 database UUID.');
const configPath='wrangler.jsonc';
const config=JSON.parse(readFileSync(configPath,'utf8'));
const binding=config.d1_databases?.find(item=>item.binding==='DB' && item.database_name==='telegram_store');
if(!binding)throw new Error('D1 binding DB is missing from wrangler.jsonc');
binding.database_id=db.uuid;
writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
console.log('D1 database bound for deployment.');
