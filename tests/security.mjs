import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const built=await build({entryPoints:['src/index.ts'],bundle:true,write:false,format:'esm',platform:'neutral'});
const password='test-only-owner-password-2387';
let checks=0,requestNumber=0;
function check(v,m){assert.ok(v,m);checks++}
async function fixture(bindings={}){
 const used=new Set();
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-05-15',d1Databases:['DB'],bindings,assets:{directory:resolve('public'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}},outboundService:async request=>{
  assert.equal(new URL(request.url).hostname,'challenges.cloudflare.com');const data=await request.json();const token=data.response;
  if(token==='service-down')return new Response('down',{status:503});
  const result={success:!used.has(token)&&token!=='invalid',hostname:token==='wrong-host'?'other.example':'test.example',action:token==='wrong-action'?'report':'publish'};
  used.add(token);return Response.json(result);
 }});
 const db=await mf.getD1Database('DB');for(const file of ['0001_community.sql','0002_moderation.sql']){const sql=await readFile('migrations/'+file,'utf8');await db.batch(sql.split('--> statement-breakpoint').filter(s=>s.trim()).map(s=>db.prepare(s.trim())))}
 const call=async(path,{method='GET',cookie='',fields,ip='198.51.100.'+(++requestNumber),origin='https://test.example',body,headers:extra={}}={})=>{
  const url='https://test.example'+path,headers={'CF-Connecting-IP':ip,...extra};if(cookie)headers.Cookie=cookie;if(method!=='GET'&&origin)headers.Origin=origin;
  if(fields){const fd=new FormData();for(const[k,v]of Object.entries(fields))fd.set(k,v);const encoded=new Request(url,{method,body:fd});headers['Content-Type']=encoded.headers.get('content-type');body=await encoded.arrayBuffer()}
  return mf.dispatchFetch(url,{method,headers,body,...(body instanceof ReadableStream?{duplex:'half'}:{})});
 };
 const guest=async()=>{const r=await call('/api/guest',{method:'POST'});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]};
 return {mf,db,call,guest};
}
const base={placeId:'place-43',kind:'checkin',displayName:'Гость',body:'Моя поездка',rating:'1',visitedAt:'2026-01-02'};
const f=await fixture({ADMIN_PASSWORD:password});const{call,guest,db}=f;
try{
 let r=await call('/admin');check(r.status===200&&(await r.text()).includes('Вход владельца'),'admin page is served');
 r=await call('/api/admin/entries');check(r.status===401,'admin records unavailable without session');
 r=await call('/api/admin/entries',{headers:{'CF-Access-Authenticated-User-Email':'owner@example.invalid'}});check(r.status===401,'identity header does not grant admin');
 r=await call('/api/admin/login',{method:'POST',origin:'https://evil.example',fields:{password}});check(r.status===403,'cross-origin admin login rejected');
 r=await call('/api/admin/login',{method:'POST',fields:{password:'incorrect'}});check(r.status===401,'incorrect password rejected');
 r=await call('/api/admin/login',{method:'POST',fields:{password}});check(r.status===200,'owner login succeeds');const admin=r.headers.get('set-cookie').split(';')[0];check(r.headers.get('set-cookie').includes('HttpOnly')&&r.headers.get('set-cookie').includes('Secure')&&r.headers.get('set-cookie').includes('SameSite=Strict'),'admin cookie protected');
 check(!JSON.stringify((await db.prepare('SELECT * FROM admin_sessions').all()).results).includes(password),'admin password not stored in session table');
 const a=await guest(),b=await guest();
 r=await call('/api/contributions',{method:'POST',cookie:a,fields:base});const first=(await r.json()).id;check(r.status===201,'normal check-in created');
 r=await call('/api/contributions',{method:'POST',cookie:a,fields:base});const dupe=await r.json();check(r.status===200&&dupe.id===first&&dupe.duplicate,'repeat submit returns original record');
 check((await db.prepare('SELECT COUNT(*) AS n FROM contributions').first()).n===1,'repeat leaves exactly one record');
 const concurrent={...base,placeId:'place-44',body:'Concurrent request'};
 const pair=await Promise.all([call('/api/contributions',{method:'POST',cookie:a,fields:concurrent}),call('/api/contributions',{method:'POST',cookie:a,fields:concurrent})]);const ids=await Promise.all(pair.map(r=>r.json()));check(pair.every(r=>[200,201].includes(r.status))&&ids[0].id===ids[1].id,'concurrent repeat idempotent');check((await db.prepare('SELECT COUNT(*) AS n FROM ratings WHERE place_id=?').bind('place-44').first()).n===1,'concurrent repeat has one valid rating');
 r=await call('/api/contributions',{method:'POST',cookie:b,fields:{...base,rating:'5',body:'Другая поездка'}});check(r.status===201,'another browser posts');
 r=await call('/api/reports/'+first,{method:'POST',cookie:a,fields:{reason:'spam'}});check(r.status===400,'cannot report own entry');
 r=await call('/api/reports/'+first,{method:'POST',cookie:b,fields:{reason:'spam',details:'private complaint note'}});check(r.status===200,'report accepted');
 r=await call('/api/reports/'+first,{method:'POST',cookie:b,fields:{reason:'spam'}});check(r.status===200,'repeated report handled');check((await db.prepare('SELECT COUNT(*) AS n FROM reports').first()).n===1,'one report per guest and entry');
 let data=await(await call('/api/admin/entries?filter=reported',{cookie:admin})).json();check(data.entries.length===1&&data.reports[0].details==='private complaint note','owner sees report queue');
 data=await(await call('/api/state')).json();check(!JSON.stringify(data).includes('private complaint note')&&data.feed.some(e=>e.id===first),'reports private and do not auto-hide');
 const action=async(type)=>call('/api/admin/entries/'+first,{method:'POST',cookie:admin,fields:{action:type,note:'Test moderation'}});
 r=await action('hide');check(r.status===200,'moderator hides record');
 data=await(await call('/api/state')).json();check(!data.feed.some(e=>e.id===first)&&data.stats.find(p=>p.place_id===base.placeId).rating===5,'hidden entry removed from feed and ratings');
 data=await(await call('/api/places/'+base.placeId,{cookie:a})).json();check(!data.entries.some(e=>e.id===first)&&data.myRating===0,'hidden entry removed from place and own visible rating');
 data=await(await call('/api/profile',{cookie:a})).json();check(data.entries.some(e=>e.id===first&&e.moderationStatus==='hidden'),'author can see hidden status in passport');
 r=await action('restore');check(r.status===200,'moderator restores record');data=await(await call('/api/state')).json();check(data.stats.find(p=>p.place_id===base.placeId).rating===3,'restored rating included again');
 r=await action('block');check(r.status===200,'browser author blocked');
 r=await call('/api/contributions',{method:'POST',cookie:a,fields:{...base,body:'blocked post'}});check(r.status===403,'blocked browser cannot post');
 r=await call('/api/reports/'+first,{method:'POST',cookie:a,fields:{reason:'other'}});check(r.status===403,'blocked browser cannot report');
 r=await call('/api/contributions/'+first,{method:'DELETE',cookie:b});check(r.status===404,'ownership enforced after moderation');
 r=await action('unblock');check(r.status===200,'browser author unblocked');
 r=await call('/api/contributions',{method:'POST',cookie:a,fields:{...base,kind:'comment',rating:'0',body:'unblocked'}});check(r.status===201,'unblocked browser can post');
 r=await call('/api/contributions',{method:'POST',cookie:a,fields:{...base,displayName:new File(['bad'],'name.txt')}});check(r.status===400,'file in text field rejected');
 const chunks=new ReadableStream({start(c){c.enqueue(new Uint8Array(9000));c.enqueue(new Uint8Array(9000));c.close()}});
 r=await call('/api/contributions',{method:'POST',cookie:a,body:chunks,headers:{'Content-Type':'multipart/form-data; boundary=test'}});check(r.status===413,'stream body limit enforced without length header');
 r=await call('/api/contributions',{method:'POST',cookie:a,body:'invalid',headers:{'Content-Type':'multipart/form-data; boundary=test'}});check(r.status===400,'malformed form is client error');
 r=await call('/api/admin/entries/'+first,{method:'POST',cookie:admin,origin:'https://evil.example',fields:{action:'hide'}});check(r.status===403,'admin mutations reject cross-origin');
 const newGuest=await guest();r=await call('/api/admin/entries/'+first,{method:'POST',cookie:newGuest,fields:{action:'hide'}});check(r.status===401,'guest cannot moderate');
 data=await(await call('/api/admin/log',{cookie:admin})).json();check(data.entries.length===4,'moderation actions audited');
 r=await call('/api/admin/logout',{method:'POST',cookie:admin});check(r.status===200,'logout succeeds');r=await call('/api/admin/session',{cookie:admin});check(r.status===401,'logged-out session cannot be replayed');
 for(let i=0;i<5;i++)await call('/api/admin/login',{method:'POST',ip:'203.0.113.90',fields:{password:'bad'}});
 r=await call('/api/admin/login',{method:'POST',ip:'203.0.113.90',fields:{password}});check(r.status===429&&Number(r.headers.get('Retry-After'))>0,'owner password brute force throttled');
 for(let i=0;i<15;i++){const cookie=await guest();r=await call('/api/contributions',{method:'POST',cookie,ip:'203.0.113.91',fields:{...base,body:'Network test '+i}});check(r.status===201,'network quota allows normal posts')}
 const fresh=await guest();r=await call('/api/contributions',{method:'POST',cookie:fresh,ip:'203.0.113.91',fields:{...base,body:'reset browser'}});check(r.status===429,'new guest cookie does not reset network quota');
 const counters=JSON.stringify((await db.prepare('SELECT * FROM request_limits').all()).results);check(!counters.includes('203.0.113.91'),'raw IP not stored in rate-limit table');
 r=await call('/api/contributions/'+first,{method:'DELETE',cookie:a});check(r.status===200,'author can delete moderated record');check((await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE contribution_id=?').bind(first).first()).n===0,'deletion cleans reports');
}finally{await f.mf.dispose()}
const disabled=await fixture();try{const r=await disabled.call('/api/admin/login',{method:'POST',fields:{password}});check(r.status===503,'owner login closed when password not configured')}finally{await disabled.mf.dispose()}
const partial=await fixture({TURNSTILE_SITE_KEY:'public-test-key'});try{const cookie=await partial.guest();const r=await partial.call('/api/contributions',{method:'POST',cookie,fields:base});check(r.status===503,'partial challenge setup fails closed')}finally{await partial.mf.dispose()}
const protectedSite=await fixture({TURNSTILE_SITE_KEY:'public-test-key',TURNSTILE_SECRET_KEY:'test-secret-not-production'});
try{
 const cookie=await protectedSite.guest();const send=token=>protectedSite.call('/api/contributions',{method:'POST',cookie,fields:{...base,...(token?{'cf-turnstile-response':token}:{})}});
 let r=await send();check(r.status===400,'challenge token required');for(const token of['invalid','wrong-host','wrong-action']){r=await send(token);check(r.status===400,'invalid token/host/action rejected')}
 r=await send('service-down');check(r.status===503,'challenge upstream failure fails closed');r=await send('valid-publish');check(r.status===201,'verified challenge allows post');r=await send('valid-publish');check(r.status===400,'challenge token replay rejected');
 const d=await(await protectedSite.call('/api/config')).json();check(d.turnstile.enabled&&d.turnstile.siteKey==='public-test-key'&&!JSON.stringify(d).includes('test-secret'),'only public challenge config exposed');
}finally{await protectedSite.mf.dispose()}
console.log(`${checks} security and moderation integration checks passed.`);
