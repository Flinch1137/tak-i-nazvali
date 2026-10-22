import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const cli=require.resolve('wrangler/bin/wrangler.js');
const configPath=new URL('../wrangler.json',import.meta.url);
const config=JSON.parse(readFileSync(configPath,'utf8'));
const placeholder='00000000-0000-4000-8000-000000000000';
const exec=(args,capture=false)=>{
 const result=spawnSync(process.execPath,[cli,...args],{cwd:new URL('..',import.meta.url),stdio:capture?['inherit','pipe','pipe']:'inherit',encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 if(result.error)throw result.error;
 return {ok:result.status===0,stdout:result.stdout||'',stderr:result.stderr||''};
};
function required(args){const result=exec(args);if(!result.ok)throw new Error('Команда не выполнена: wrangler '+args.join(' '));return result}
function parseList(text){const start=text.indexOf('['),end=text.lastIndexOf(']');if(start<0||end<start)throw new Error('Не удалось прочитать список баз Cloudflare.');return JSON.parse(text.slice(start,end+1))}
function persist(){const tmp=new URL('../wrangler.json.tmp',import.meta.url);writeFileSync(tmp,JSON.stringify(config,null,2)+'\n');renameSync(tmp,configPath)}
try{
 console.log('\nТак и назвали → запуск в твоём Cloudflare\n');
 const me=exec(['whoami'],true);
 if(!me.ok||/not authenticated|not logged in/i.test(me.stdout+me.stderr))required(['login']);
 const binding=config.d1_databases.find(d=>d.binding==='DB');
 if(!binding)throw new Error('В wrangler.json отсутствует привязка DB.');
 if(!binding.database_id||binding.database_id===placeholder){
  const list=exec(['d1','list','--json'],true);if(!list.ok){process.stderr.write(list.stderr||list.stdout);throw new Error('Не удалось получить базы. Проверь вход и выбранный аккаунт Cloudflare.');}
  const existing=parseList(list.stdout).find(d=>d.name===binding.database_name);
  if(existing){binding.database_id=existing.uuid;persist();console.log('Используем существующую базу: '+binding.database_name);}
  else{
   required(['d1','create',binding.database_name,'--location','eeur']);
   const fresh=exec(['d1','list','--json'],true);if(!fresh.ok)throw new Error('База создана, но список не загрузился. Повтори npm run setup: существующая база будет использована.');
   const created=parseList(fresh.stdout).find(d=>d.name===binding.database_name);if(!created?.uuid)throw new Error('Не удалось найти созданную базу. Повтори npm run setup.');
   binding.database_id=created.uuid;persist();
  }
 }
 const bucket=config.r2_buckets.find(d=>d.binding==='BUCKET');if(!bucket)throw new Error('В wrangler.json отсутствует привязка BUCKET.');
 const info=exec(['r2','bucket','info',bucket.bucket_name],true);
 if(!info.ok){
  const created=exec(['r2','bucket','create',bucket.bucket_name,'--location','eeur']);
  if(!created.ok)throw new Error('Не удалось создать хранилище. Открой Cloudflare → R2, активируй R2 и повтори npm run setup. Если хранилище уже есть, проверь доступ к нему.');
 }
 required(['d1','migrations','apply','DB','--remote']);
 required(['deploy']);
 console.log('\nГотово. Адрес опубликованного сайта указан выше.\nДля следующих обновлений: npm run deploy\nЕсли используешь GitHub, сохрани обновлённый wrangler.json в репозитории.\n');
}catch(error){console.error('\n'+(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1}
