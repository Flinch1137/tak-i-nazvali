import catalog from './catalog.json';
import type { Env } from './types';
const placeIds = new Set(catalog.map(p=>p.id));
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const statsSql=`SELECT p.place_id, COUNT(DISTINCT CASE WHEN p.kind='checkin' THEN p.user_id END) AS visits, COUNT(*) AS posts, SUM(CASE WHEN p.photo_key IS NOT NULL THEN 1 ELSE 0 END) AS photos, (SELECT ROUND(AVG(r.value),1) FROM ratings r WHERE r.place_id=p.place_id) AS rating, (SELECT COUNT(*) FROM ratings r WHERE r.place_id=p.place_id) AS ratings FROM contributions p GROUP BY p.place_id`;
const publicSql=`SELECT c.id,c.place_id AS placeId,c.display_name AS displayName,c.kind,c.body,c.visited_at AS visitedAt,c.created_at AS createdAt, CASE WHEN c.photo_key IS NOT NULL THEN '/api/photos/'||c.id ELSE NULL END AS photo, CASE WHEN c.user_id=? THEN 1 ELSE 0 END AS mine, (SELECT r.value FROM ratings r WHERE r.contribution_id=c.id) AS rating FROM contributions c`;
async function imageMime(file:File){const bytes=new Uint8Array(await file.slice(0,16).arrayBuffer());if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';if(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71&&bytes[4]===13&&bytes[5]===10&&bytes[6]===26&&bytes[7]===10)return 'image/png';if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';return null}
// A random browser cookie is the guest's deletion capability; only its hash is stored.
function guestCookieName(request:Request){const url=new URL(request.url);return url.protocol==='http:'&&['localhost','127.0.0.1','terminal.local'].includes(url.hostname)?'tak_guest_dev':'__Host-tak_guest'}
async function guestIdentity(request:Request){const name=guestCookieName(request);const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';if(!/^[a-f0-9]{64}$/.test(token))return '';const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return 'guest:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')}
function guestCookie(request:Request,token:string,maxAge=31536000){const name=guestCookieName(request);return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${name.startsWith('__Host-')?'; Secure':''}`}
export async function handle(request:Request,env:Env):Promise<Response>{
 const db=()=>{if(!env.DB)throw new Error('Database unavailable');return env.DB};
const rows=async(sql:string,...args:unknown[])=>(await db().prepare(sql).bind(...args).all()).results;

 try{
  const path=new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
  const guestId=await guestIdentity(request);const uid=guestId;
  if(request.method==='GET'){
   if(path[0]==='state'){
    const [metrics,feed,visits,counts]=await Promise.all([rows(statsSql),rows(publicSql+` ORDER BY c.created_at DESC LIMIT 12`,uid),uid?rows(`SELECT DISTINCT place_id AS placeId FROM contributions WHERE user_id=? AND kind='checkin'`,uid):[],rows(`SELECT COUNT(*) AS posts,COUNT(DISTINCT user_id) AS people,SUM(CASE WHEN photo_key IS NOT NULL THEN 1 ELSE 0 END) AS photos FROM contributions`)]);
    return json({guestReady:Boolean(guestId),user:null,stats:metrics,feed,visited:visits.map((v:any)=>v.placeId),counts:counts[0]});
   }
   if(path[0]==='places'&&placeIds.has(path[1])){
    const entries=await rows(publicSql+` WHERE c.place_id=? ORDER BY c.created_at DESC LIMIT 100`,uid,path[1]);
    const ownRating=uid?await rows('SELECT value FROM ratings WHERE user_id=? AND place_id=?',uid,path[1]):[];
    return json({entries,myRating:(ownRating[0] as any)?.value||0});
   }
   if(path[0]==='profile'){
    if(!uid)return json({entries:[]});
    return json({entries:await rows(publicSql+` WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 200`,uid,uid)});
   }
   if(path[0]==='photos'&&path[1]){
    const found=await rows('SELECT photo_key FROM contributions WHERE id=?',path[1]);const key=(found[0] as any)?.photo_key;
    if(!key||!env.BUCKET)return json({error:'Фото не найдено'},404);
    const obj=await env.BUCKET.get(key);if(!obj)return json({error:'Фото не найдено'},404);
    return new Response(obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'image/jpeg','Content-Disposition':'inline','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
   }
   return json({error:'Не найдено'},404);
  }
  const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return json({error:'Недопустимый источник запроса'},403);
  if(request.method==='POST'&&path[0]==='guest'){
   if(uid)return json({ok:true,guest:true});
   const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
   const response=json({ok:true,guest:true});response.headers.set('Set-Cookie',guestCookie(request,token));return response;
  }
  if(!uid)return json({error:'Не удалось узнать этот браузер. Разреши cookies для сайта и попробуй ещё раз.',code:'guest_session_required'},401);
  if(request.method==='DELETE'&&path[0]==='contributions'&&path[1]){
   const found=await rows('SELECT photo_key FROM contributions WHERE id=? AND user_id=?',path[1],uid);if(!found.length)return json({error:'Запись не найдена или принадлежит другому пользователю.'},404);
   await db().batch([db().prepare('DELETE FROM ratings WHERE contribution_id=? AND user_id=?').bind(path[1],uid),db().prepare('DELETE FROM contributions WHERE id=? AND user_id=?').bind(path[1],uid)]);
   if((found[0] as any).photo_key&&env.BUCKET)await env.BUCKET.delete((found[0] as any).photo_key);
   return json({ok:true});
  }
  if(request.method==='POST'&&path[0]==='contributions'){
   const size=Number(request.headers.get('content-length')||0);if(size>6*1024*1024)return json({error:'Файл слишком большой. Максимум 5 МБ.'},413);
   if(!request.headers.get('content-type')?.includes('multipart/form-data'))return json({error:'Неверный формат запроса'},400);
   const form=await request.formData();const placeId=String(form.get('placeId')||'');const kind=String(form.get('kind')||'');const body=String(form.get('body')||'').trim();const displayName=String(form.get('displayName')||'').trim();const visitedAt=String(form.get('visitedAt')||'');const rating=Number(form.get('rating')||0);
   if(!placeIds.has(placeId)||!['checkin','review','comment'].includes(kind))return json({error:'Выберите место и тип записи.'},400);
   if(displayName.length<2||displayName.length>40)return json({error:'Имя должно быть длиной от 2 до 40 символов.'},400);
   if(body.length>1200||((kind==='comment')&&body.length<1))return json({error:'Напишите комментарий до 1200 символов.'},400);
   if(!Number.isInteger(rating)||rating<0||rating>5||(kind==='review'&&rating===0))return json({error:'Выберите оценку от 1 до 5.'},400);
   if(kind==='comment'&&rating!==0)return json({error:'Для оценки выберите «Отзыв».'},400);
   const today=new Date(Date.now()+3*3600000).toISOString().slice(0,10);
   if(visitedAt&&(!/^\d{4}-\d{2}-\d{2}$/.test(visitedAt)||Number.isNaN(Date.parse(visitedAt))||new Date(visitedAt).toISOString().slice(0,10)!==visitedAt||visitedAt>today||visitedAt<'1900-01-01'))return json({error:'Укажите корректную дату посещения, не позже сегодняшнего дня.'},400);
   const recent=await rows('SELECT COUNT(*) AS n FROM contributions WHERE user_id=? AND created_at>?',uid,Date.now()-60000);if(Number((recent[0] as any).n)>=5)return json({error:'Слишком много записей. Попробуйте через минуту.'},429);
   const photo=form.get('photo') as File|string|null;let photoKey:string|null=null;const id=crypto.randomUUID();
   if(photo instanceof File&&photo.size){
    if(photo.size>5*1024*1024)return json({error:'Фото должно быть не больше 5 МБ.'},413);
    const mime=await imageMime(photo);if(!mime)return json({error:'Поддерживаются фотографии JPG, PNG и WebP.'},400);
    if(!env.BUCKET)return json({error:'Хранилище фотографий временно недоступно.'},503);
    photoKey='photos/'+id;await env.BUCKET.put(photoKey,await photo.arrayBuffer(),{httpMetadata:{contentType:mime}});
   }
   const now=Date.now();
   try{
    const commands=[db().prepare('INSERT INTO contributions(id,place_id,user_id,display_name,kind,body,photo_key,visited_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,placeId,uid,displayName,kind,body,photoKey,kind==='checkin'?(visitedAt||today):null,now)];
    if(rating>0)commands.push(db().prepare('INSERT INTO ratings(id,place_id,user_id,contribution_id,value,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,place_id) DO UPDATE SET contribution_id=excluded.contribution_id,value=excluded.value,updated_at=excluded.updated_at').bind(crypto.randomUUID(),placeId,uid,id,rating,now));
    await db().batch(commands);
   }catch(error){if(photoKey&&env.BUCKET)await env.BUCKET.delete(photoKey);throw error}
   return json({ok:true,id},201);
  }
  return json({error:'Не найдено'},404);
 }catch(error){console.error('Community request failed',error instanceof Error?error.message:'unknown');return json({error:'Не удалось загрузить данные. Попробуйте ещё раз чуть позже.'},503)}
}
