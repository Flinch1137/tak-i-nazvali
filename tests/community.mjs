import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const built=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral'});
const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-05-15',d1Databases:['DB'],r2Buckets:['BUCKET'],assets:{directory:resolve('public'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}}});
let checks=0;
function check(value,message){assert.ok(value,message);checks++}
try{
 const db=await mf.getD1Database('DB');const sql=await readFile('migrations/0001_community.sql','utf8');await db.batch(sql.split('--> statement-breakpoint').filter(s=>s.trim()).map(s=>db.prepare(s.trim())));
 const call=async(path,{method='GET',cookie='',fields,origin='https://test.example',headers:extra={}}={})=>{
  const url='https://test.example'+path,headers={...extra};if(cookie)headers.Cookie=cookie;if(method!=='GET')headers.Origin=origin;
  if(fields){const fd=new FormData();for(const [k,v]of Object.entries(fields))fd.set(k,v);const encoded=new Request(url,{method,body:fd});headers['Content-Type']=encoded.headers.get('content-type');return mf.dispatchFetch(url,{method,headers,body:await encoded.arrayBuffer()})}
  return mf.dispatchFetch(url,{method,headers});
 };
 const start=async()=>{const r=await call('/api/guest',{method:'POST'});check(r.status===200,'guest session created without account');return r.headers.get('set-cookie').split(';')[0]};
 const base={placeId:'place-43',kind:'checkin',displayName:'Тестовый гость',body:'Поездка без регистрации',rating:'5',visitedAt:'2026-01-02'};
 let r=await call('/');const page=await r.text();check(r.status===200&&page.includes('Так и назвали'),'home page served by Worker assets');check(!page.includes('signin-with-chatgpt'),'homepage has no sign-in dependency');
 r=await call('/app.js');const code=await r.text();check(r.status===200&&!code.includes('signin-with-chatgpt')&&!code.includes('/api/claim'),'client is independent of account platform');
 r=await call('/data.json');check(r.status===200&&(await r.json()).length===94,'94 places included');
 r=await call('/not-a-page');check(r.status===404,'unknown page returns 404');
 r=await call('/api/state');let data=await r.json();check(data.user===null&&data.feed.length===0,'anonymous public feed works');
 r=await call('/api/state',{headers:{'oai-authenticated-user-id':'spoofed','oai-authenticated-user-email':'private@example.invalid'}});data=await r.json();check(data.user===null,'external platform identity headers are ignored');
 r=await call('/api/profile');check(r.status===200&&(await r.json()).entries.length===0,'passport opens without login');
 r=await call('/api/guest',{method:'POST',origin:'https://other.example'});check(r.status===403,'cross-origin guest initialization blocked');
 r=await call('/api/contributions',{method:'POST',fields:base});check(r.status===401,'posting requires browser capability but no account');
 r=await call('/api/guest',{method:'POST'});check(r.status===200&&r.headers.get('set-cookie').includes('Secure')&&r.headers.get('set-cookie').includes('HttpOnly')&&r.headers.get('set-cookie').includes('SameSite=Lax'),'guest cookie is Secure, HttpOnly and SameSite');
 const cookie=r.headers.get('set-cookie').split(';')[0];
 r=await call('/api/guest',{method:'POST',cookie});check(!r.headers.has('set-cookie'),'existing guest identity is retained');
 r=await call('/api/contributions',{method:'POST',cookie,origin:'https://other.example',fields:base});check(r.status===403,'cross-origin posting blocked');
 for(const patch of[{placeId:'missing'},{rating:'6'},{visitedAt:'2026-02-31'},{body:'x'.repeat(1201)}]){r=await call('/api/contributions',{method:'POST',cookie,fields:{...base,...patch}});check(r.status===400,'invalid publication rejected')}
 const bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64'));
 r=await call('/api/contributions',{method:'POST',cookie,fields:{...base,photo:new File([bytes],'test.png',{type:'image/png'})}});check(r.status===201,'guest check-in with photo stored');const first=(await r.json()).id;
 r=await call('/api/photos/'+first);check(r.status===200&&r.headers.get('content-type')==='image/png','guest photo publicly readable');check(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(bytes)),'photo round-trip correct');
 r=await call('/api/state',{cookie});data=await r.json();check(data.guestReady&&data.visited.includes(base.placeId)&&data.feed[0].mine===1,'guest ownership and visited history persisted');
 r=await call('/api/profile',{cookie});data=await r.json();check(data.entries.length===1&&data.entries[0].id===first,'guest passport retrieves own history');
 r=await call('/api/profile');check((await r.json()).entries.length===0,'cleared cookies do not recover ownership by nickname');
 const otherCookie=await start();r=await call('/api/contributions/'+first,{method:'DELETE',cookie:otherCookie});check(r.status===404,'another guest cannot delete record');
 r=await call('/api/contributions',{method:'POST',cookie,fields:{...base,kind:'review',rating:'3'}});check(r.status===201,'guest review supported');const review=(await r.json()).id;
 r=await call('/api/contributions',{method:'POST',cookie:otherCookie,fields:{...base,kind:'review',rating:'5'}});check(r.status===201,'another guest can review');const otherReview=(await r.json()).id;
 data=await(await call('/api/state')).json();check(data.stats[0].rating===4&&data.stats[0].ratings===2,'one latest rating per browser is averaged');check(data.stats[0].visits===1&&data.stats[0].photos===1,'real visit and photo counts');
 r=await call('/api/contributions',{method:'POST',cookie,fields:{...base,kind:'comment',rating:'0',body:'Комментарий гостя'}});check(r.status===201,'guest comment supported');const comment=(await r.json()).id;
 r=await call('/api/contributions',{method:'POST',cookie,fields:{...base,photo:new File(['<script>bad</script>'],'bad.png',{type:'image/png'})}});check(r.status===400,'disguised unsupported file rejected');
 const malformed='__Host-tak_guest=invalid';r=await call('/api/contributions/'+first,{method:'DELETE',cookie:malformed});check(r.status===401,'invalid cookie cannot delete record');
 for(const [id,owner]of[[first,cookie],[review,cookie],[comment,cookie],[otherReview,otherCookie]]){r=await call('/api/contributions/'+id,{method:'DELETE',cookie:owner});check(r.status===200,'own record can be deleted')}
 r=await call('/api/photos/'+first);check(r.status===404,'photo deleted with record');
 data=await(await call('/api/state')).json();check(!data.feed.length&&!data.stats.length,'deletion clears public feed and aggregate data');
 check((await db.prepare('SELECT COUNT(*) AS n FROM ratings').first()).n===0,'no orphan ratings remain');
 const limited=await start();for(let i=0;i<5;i++){r=await call('/api/contributions',{method:'POST',cookie:limited,fields:{...base,kind:'comment',rating:'0',body:'Rate test '+i}});check(r.status===201,'within-limit posting works')}
 r=await call('/api/contributions',{method:'POST',cookie:limited,fields:{...base,kind:'comment',rating:'0',body:'One too many'}});check(r.status===429,'per-browser posting limit enforced');
 console.log(`${checks} standalone integration checks passed: Worker assets + anonymous API + D1 + R2.`);
}finally{await mf.dispose()}
