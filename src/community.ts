import catalog from './catalog.json';
import type { Env } from './types';
import {HttpError,formBody,textField,networkKey,rateLimit,hash,turnstileConfig,verifyChallenge} from './security';
import {moderation} from './moderation';
const placeIds = new Set(catalog.map(p=>p.id));
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const statsSql=`SELECT p.place_id, COUNT(DISTINCT CASE WHEN p.kind='checkin' THEN p.user_id END) AS visits, COUNT(*) AS posts, 0 AS photos, (SELECT ROUND(AVG(r.value),1) FROM ratings r JOIN contributions rc ON rc.id=r.contribution_id WHERE r.place_id=p.place_id AND rc.moderation_status='published') AS rating, (SELECT COUNT(*) FROM ratings r JOIN contributions rc ON rc.id=r.contribution_id WHERE r.place_id=p.place_id AND rc.moderation_status='published') AS ratings FROM contributions p WHERE p.moderation_status='published' GROUP BY p.place_id`;
const publicSql=`SELECT c.id,c.place_id AS placeId,c.display_name AS displayName,c.kind,c.body,c.visited_at AS visitedAt,c.created_at AS createdAt,c.moderation_status AS moderationStatus, NULL AS photo, CASE WHEN c.user_id=? THEN 1 ELSE 0 END AS mine, (SELECT r.value FROM ratings r WHERE r.contribution_id=c.id) AS rating FROM contributions c`;
// A random browser cookie is the guest's deletion capability; only its hash is stored.
function guestCookieName(request:Request){const url=new URL(request.url);return url.protocol==='http:'&&['localhost','127.0.0.1','terminal.local'].includes(url.hostname)?'tak_guest_dev':'__Host-tak_guest'}
async function guestIdentity(request:Request){const name=guestCookieName(request);const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';if(!/^[a-f0-9]{64}$/.test(token))return '';const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return 'guest:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}
function guestCookie(request:Request,token:string,maxAge=31536000){const name=guestCookieName(request);return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${name.startsWith('__Host-')?'; Secure':''}`}
export async function handle(request:Request,env:Env):Promise<Response>{
 const db=()=>{if(!env.DB)throw new Error('Database unavailable');return env.DB};
const rows=async(sql:string,...args:unknown[])=>(await db().prepare(sql).bind(...args).all()).results;

 try{
  const path=new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
  if(!['GET','POST','DELETE'].includes(request.method))throw new HttpError(405,'Метод не поддерживается.');
  if(request.method!=='GET'){
   const origin=request.headers.get('origin');if(origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw new HttpError(403,'Недопустимый источник запроса');
  }
  if(path[0]==='admin')return await moderation(request,env,path);
  const guestId=await guestIdentity(request);const uid=guestId;
  if(request.method==='GET'){
   if(path.length===1&&path[0]==='config')return json({turnstile:turnstileConfig(env)});
   if(path.length===1&&path[0]==='state'){
    const [metrics,feed,visits,counts]=await Promise.all([rows(statsSql),rows(publicSql+` WHERE c.moderation_status='published' ORDER BY c.created_at DESC LIMIT 12`,uid),uid?rows(`SELECT DISTINCT place_id AS placeId FROM contributions WHERE user_id=? AND kind='checkin' AND moderation_status='published'`,uid):[],rows(`SELECT COUNT(*) AS posts,COUNT(DISTINCT user_id) AS people,0 AS photos FROM contributions WHERE moderation_status='published'`)]);
    return json({guestReady:Boolean(guestId),user:null,stats:metrics,feed,visited:visits.map((v:any)=>v.placeId),counts:counts[0]});
   }
   if(path.length===2&&path[0]==='places'&&placeIds.has(path[1])){
    const entries=await rows(publicSql+` WHERE c.place_id=? AND c.moderation_status='published' ORDER BY c.created_at DESC LIMIT 100`,uid,path[1]);
    const ownRating=uid?await rows("SELECT r.value FROM ratings r JOIN contributions c ON c.id=r.contribution_id WHERE r.user_id=? AND r.place_id=? AND c.moderation_status='published'",uid,path[1]):[];
    return json({entries,myRating:(ownRating[0] as any)?.value||0});
   }
   if(path.length===1&&path[0]==='profile'){
    if(!uid)return json({entries:[]});
    return json({entries:await rows(publicSql+` WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 200`,uid,uid)});
   }
   if(path[0]==='photos')return json({error:'Пока недоступно',code:'photos_unavailable'},501);
   return json({error:'Не найдено'},404);
  }
  if(request.method==='POST'&&path.length===1&&path[0]==='guest'){
   if(uid)return json({ok:true,guest:true});
   await rateLimit(env,'guest-create',await networkKey(request,env),20,600);
   const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
   const response=json({ok:true,guest:true});response.headers.set('Set-Cookie',guestCookie(request,token));return response;
  }
  if(!uid)return json({error:'Не удалось узнать этот браузер. Разреши cookies для сайта и попробуй ещё раз.',code:'guest_session_required'},401);
  if(request.method==='DELETE'&&path.length===2&&path[0]==='contributions'&&path[1]){
   const found=await rows('SELECT photo_key FROM contributions WHERE id=? AND user_id=?',path[1],uid);if(!found.length)return json({error:'Запись не найдена или принадлежит другому пользователю.'},404);
   await db().batch([db().prepare('DELETE FROM reports WHERE contribution_id=?').bind(path[1]),db().prepare('DELETE FROM ratings WHERE contribution_id=? AND user_id=?').bind(path[1],uid),db().prepare('DELETE FROM contributions WHERE id=? AND user_id=?').bind(path[1],uid)]);
   return json({ok:true});
  }
  if(request.method==='POST'&&path.length===2&&path[0]==='reports'){
   if(await db().prepare('SELECT 1 FROM bans WHERE user_id=?').bind(uid).first())throw new HttpError(403,'Публикации из этого браузера ограничены модератором.');
   await rateLimit(env,'report-ip',await networkKey(request,env),10,600);
   const form=await formBody(request,8192),reason=textField(form,'reason',20),details=textField(form,'details',500);
   if(!['spam','abuse','wrong','other'].includes(reason))throw new HttpError(400,'Выбери причину жалобы.');
   const entry=await db().prepare("SELECT user_id FROM contributions WHERE id=? AND moderation_status='published'").bind(path[1]).first<{user_id:string}>();
   if(!entry)throw new HttpError(404,'Запись не найдена.');if(entry.user_id===uid)throw new HttpError(400,'Свою запись можно удалить в паспорте.');
   await verifyChallenge(request,env,form,'report');
   await rateLimit(env,'report-guest',uid,5,600);
   await db().prepare('INSERT OR IGNORE INTO reports(id,contribution_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),path[1],uid,reason,details,Date.now()).run();
   return json({ok:true});
  }
  if(request.method==='POST'&&path.length===1&&path[0]==='contributions'){
   if(await db().prepare('SELECT 1 FROM bans WHERE user_id=?').bind(uid).first())throw new HttpError(403,'Публикации из этого браузера ограничены модератором.');
   await rateLimit(env,'publish-ip',await networkKey(request,env),15,600);
   const form=await formBody(request);const placeId=textField(form,'placeId',80),kind=textField(form,'kind',20),body=textField(form,'body',1200),displayName=textField(form,'displayName',40),visitedAt=textField(form,'visitedAt',10),rating=Number(textField(form,'rating',4)||0);
   if(!placeIds.has(placeId)||!['checkin','review','comment'].includes(kind))return json({error:'Выберите место и тип записи.'},400);
   if(displayName.length<2||displayName.length>40)return json({error:'Имя должно быть длиной от 2 до 40 символов.'},400);
   if(body.length>1200||((kind==='comment')&&body.length<1))return json({error:'Напишите комментарий до 1200 символов.'},400);
   if(!Number.isInteger(rating)||rating<0||rating>5||(kind==='review'&&rating===0))return json({error:'Выберите оценку от 1 до 5.'},400);
   if(kind==='comment'&&rating!==0)return json({error:'Для оценки выберите «Отзыв».'},400);
   const today=new Date(Date.now()+3*3600000).toISOString().slice(0,10);
   if(visitedAt&&(!/^\d{4}-\d{2}-\d{2}$/.test(visitedAt)||Number.isNaN(Date.parse(visitedAt))||new Date(visitedAt).toISOString().slice(0,10)!==visitedAt||visitedAt>today||visitedAt<'1900-01-01'))return json({error:'Укажите корректную дату посещения, не позже сегодняшнего дня.'},400);
   const photo=form.get('photo');
   if(photo!==null)return json({error:'Пока недоступно',code:'photos_unavailable'},501);
   await verifyChallenge(request,env,form,'publish');
   const fingerprint=await hash(JSON.stringify([placeId,kind,body,rating,kind==='checkin'?(visitedAt||today):'']));
   const duplicate=await db().prepare('SELECT id FROM contributions WHERE user_id=? AND fingerprint=?').bind(uid,fingerprint).first<{id:string}>();if(duplicate)return json({ok:true,id:duplicate.id,duplicate:true});
   await rateLimit(env,'publish-guest',uid,5,60);
   const photoKey=null;const id=crypto.randomUUID();
   const now=Date.now();
   {
    const commands=[db().prepare('INSERT OR IGNORE INTO contributions(id,place_id,user_id,display_name,kind,body,photo_key,visited_at,created_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,placeId,uid,displayName,kind,body,photoKey,kind==='checkin'?(visitedAt||today):null,now,fingerprint)];
    if(rating>0)commands.push(db().prepare('INSERT INTO ratings(id,place_id,user_id,contribution_id,value,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM contributions WHERE id=?) ON CONFLICT(user_id,place_id) DO UPDATE SET contribution_id=excluded.contribution_id,value=excluded.value,updated_at=excluded.updated_at').bind(crypto.randomUUID(),placeId,uid,id,rating,now,id));
    await db().batch(commands);
   }
   const saved=await db().prepare('SELECT id FROM contributions WHERE user_id=? AND fingerprint=?').bind(uid,fingerprint).first<{id:string}>();return json({ok:true,id:saved!.id,duplicate:saved!.id!==id},saved!.id===id?201:200);
  }
  return json({error:'Не найдено'},404);
 }catch(error){if(error instanceof HttpError){const response=json({error:error.message,code:error.code},error.status);if(error.retryAfter)response.headers.set('Retry-After',String(error.retryAfter));return response}console.error('Community request failed',error instanceof Error?error.message:'unknown');return json({error:'Не удалось загрузить данные. Попробуйте ещё раз чуть позже.'},503)}
}
