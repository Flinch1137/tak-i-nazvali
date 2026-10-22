import type { Env } from './types';
import {HttpError,adminEnabled,isAdmin,formBody,textField,rateLimit,networkKey,equalSecrets,hash,randomToken,adminCookie,adminCookieName,cookieToken} from './security';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function moderation(request:Request,env:Env,path:string[]){
 if(request.method==='POST'&&path.length===2&&path[1]==='login'){
  await rateLimit(env,'admin-login',await networkKey(request,env),5,900);
  if(!adminEnabled(env))throw new HttpError(503,'Вход владельца ещё не настроен в Cloudflare.');
  const form=await formBody(request,4096);const password=textField(form,'password',256);
  if(!await equalSecrets(password,env.ADMIN_PASSWORD!))throw new HttpError(401,'Не удалось войти. Проверь пароль.');
  const old=cookieToken(request,adminCookieName(request));if(old)await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hash(old)).run();
  const token=randomToken();await env.DB.prepare('INSERT INTO admin_sessions(token_hash,password_hash,expires_at) VALUES(?,?,?)').bind(await hash(token),await hash(env.ADMIN_PASSWORD!),Date.now()+28800000).run();
  const response=json({ok:true});response.headers.set('Set-Cookie',adminCookie(request,token));return response;
 }
 if(!await isAdmin(request,env))throw new HttpError(401,'Войди в панель владельца.');
 if(request.method==='GET'&&path.length===2&&path[1]==='session')return json({ok:true,turnstileConfigured:Boolean(env.TURNSTILE_SITE_KEY&&env.TURNSTILE_SECRET_KEY)});
 if(request.method==='POST'&&path.length===2&&path[1]==='logout'){
  await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hash(cookieToken(request,adminCookieName(request)))).run();const response=json({ok:true});response.headers.set('Set-Cookie',adminCookie(request,'',0));return response;
 }
 if(request.method==='GET'&&path.length===2&&path[1]==='entries'){
  const url=new URL(request.url),filter=url.searchParams.get('filter')||'reported',offset=Number(url.searchParams.get('offset')||0);
  if(!['reported','all','hidden'].includes(filter)||!Number.isInteger(offset)||offset<0||offset>100000)throw new HttpError(400,'Неверный фильтр.');
  const where=filter==='reported'?"EXISTS(SELECT 1 FROM reports r WHERE r.contribution_id=c.id AND r.resolved_at IS NULL)":filter==='hidden'?"c.moderation_status='hidden'":'1=1';
  const entries=(await env.DB.prepare(`SELECT c.id,c.place_id AS placeId,c.display_name AS displayName,c.kind,c.body,c.created_at AS createdAt,c.moderation_status AS moderationStatus,EXISTS(SELECT 1 FROM bans b WHERE b.user_id=c.user_id) AS blocked,(SELECT COUNT(*) FROM reports r WHERE r.contribution_id=c.id AND r.resolved_at IS NULL) AS reportCount FROM contributions c WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT 51 OFFSET ?`).bind(offset).all()).results;
  const reports=(await env.DB.prepare(`SELECT r.contribution_id AS contributionId,r.reason,r.details,r.created_at AS createdAt FROM reports r WHERE r.resolved_at IS NULL AND r.contribution_id IN (SELECT c.id FROM contributions c WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT 50 OFFSET ?) ORDER BY r.created_at DESC LIMIT 250`).bind(offset).all()).results;
  return json({entries:entries.slice(0,50),reports,nextOffset:entries.length>50?offset+50:null});
 }
 if(request.method==='GET'&&path.length===2&&path[1]==='log')return json({entries:(await env.DB.prepare('SELECT contribution_id AS contributionId,action,note,created_at AS createdAt FROM moderation_log ORDER BY created_at DESC LIMIT 50').all()).results});
 if(request.method==='POST'&&path.length===3&&path[1]==='entries'){
  const form=await formBody(request,4096),action=textField(form,'action',20),note=textField(form,'note',300),id=path[2];
  if(!['hide','restore','block','unblock','dismiss'].includes(action))throw new HttpError(400,'Неизвестное действие.');
  const entry=await env.DB.prepare('SELECT user_id FROM contributions WHERE id=?').bind(id).first<{user_id:string}>();if(!entry)throw new HttpError(404,'Запись уже удалена.');
  const commands:D1PreparedStatement[]=[];const now=Date.now();
  if(action==='hide'||action==='restore')commands.push(env.DB.prepare('UPDATE contributions SET moderation_status=? WHERE id=?').bind(action==='hide'?'hidden':'published',id));
  if(action==='block')commands.push(env.DB.prepare('INSERT INTO bans(user_id,reason,created_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at').bind(entry.user_id,note,now));
  if(action==='unblock')commands.push(env.DB.prepare('DELETE FROM bans WHERE user_id=?').bind(entry.user_id));
  if(['hide','dismiss'].includes(action))commands.push(env.DB.prepare('UPDATE reports SET resolved_at=? WHERE contribution_id=? AND resolved_at IS NULL').bind(now,id));
  commands.push(env.DB.prepare('INSERT INTO moderation_log(id,contribution_id,action,note,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),id,action,note,now));await env.DB.batch(commands);return json({ok:true});
 }
 throw new HttpError(404,'Не найдено.');
}
