import type { Env } from './types';
export class HttpError extends Error { constructor(public status:number,message:string,public code='',public retryAfter=0){super(message)} }
export const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export async function limitedBody(request:Request,max=16384){
 const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>max))throw new HttpError(413,'Запрос слишком большой.');
 const reader=request.body?.getReader();if(!reader)return new ArrayBuffer(0);
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>max){await reader.cancel();throw new HttpError(413,'Запрос слишком большой.')}chunks.push(item.value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength}return bytes.buffer;
}
export async function formBody(request:Request,max=16384){
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;'))throw new HttpError(400,'Неверный формат запроса.');
 const body=await limitedBody(request,max);try{return await new Response(body,{headers:{'Content-Type':request.headers.get('content-type')!}}).formData()}catch{throw new HttpError(400,'Не удалось прочитать форму.')}
}
export function textField(form:FormData,name:string,max:number){const values=form.getAll(name);if(values.length>1||values.some(v=>typeof v!=='string'))throw new HttpError(400,'Неверное поле формы.');const value=String(values[0]||'').trim();if(value.length>max)throw new HttpError(400,'Поле слишком длинное.');return value}
export async function networkKey(request:Request,env:Env){
 let salt=await env.DB.prepare("SELECT value FROM security_settings WHERE key='network_salt'").first<string>('value');
 if(!salt){await env.DB.prepare("INSERT OR IGNORE INTO security_settings(key,value) VALUES('network_salt',?)").bind(randomToken()).run();salt=(await env.DB.prepare("SELECT value FROM security_settings WHERE key='network_salt'").first<string>('value'))!}
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(salt),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const address=request.headers.get('CF-Connecting-IP')||'unknown';
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(address))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function rateLimit(env:Env,scope:string,key:string,max:number,seconds:number){
 const now=Date.now(),window=Math.floor(now/(seconds*1000)),expires=(window+1)*seconds*1000;
 const result=await env.DB.prepare('INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(`${scope}:${key}:${window}`,expires).first<{count:number}>();
 if(Math.random()<.02)await env.DB.batch([env.DB.prepare('DELETE FROM request_limits WHERE expires_at<?').bind(now),env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now)]);
 if(!result||result.count>max)throw new HttpError(429,'Слишком много запросов. Подожди немного и попробуй снова.','rate_limited',Math.ceil((expires-now)/1000));
}
export function turnstileConfig(env:Env){return {enabled:Boolean(env.TURNSTILE_SITE_KEY||env.TURNSTILE_SECRET_KEY),siteKey:env.TURNSTILE_SITE_KEY||''}}
export async function verifyChallenge(request:Request,env:Env,form:FormData,action:string){
 if(!turnstileConfig(env).enabled)return;
 if(!env.TURNSTILE_SECRET_KEY||!env.TURNSTILE_SITE_KEY)throw new HttpError(503,'Проверка безопасности временно недоступна.');
 const token=textField(form,'cf-turnstile-response',2048);if(!token)throw new HttpError(400,'Пройди проверку безопасности.','challenge_required');
 let result:{success?:boolean;hostname?:string;action?:string};
 try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token}),signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error();result=await response.json()}catch{throw new HttpError(503,'Проверка безопасности временно недоступна.')}
 if(!result.success||result.hostname!==new URL(request.url).hostname||result.action!==action)throw new HttpError(400,'Проверка не пройдена или устарела. Попробуй ещё раз.','challenge_invalid');
}
export function adminCookieName(request:Request){const url=new URL(request.url);return url.protocol==='http:'&&['localhost','127.0.0.1','terminal.local'].includes(url.hostname)?'tak_admin_dev':'__Host-tak_admin'}
export function cookieToken(request:Request,name:string){const value=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';return /^[a-f0-9]{64}$/.test(value)?value:''}
export function adminCookie(request:Request,token:string,age=28800){const name=adminCookieName(request);return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${name.startsWith('__Host-')?'; Secure':''}`}
export const adminEnabled=(env:Env)=>Boolean(env.ADMIN_PASSWORD&&env.ADMIN_PASSWORD.length>=20);
export async function isAdmin(request:Request,env:Env){if(!adminEnabled(env))return false;const token=cookieToken(request,adminCookieName(request));if(!token)return false;const session=await env.DB.prepare('SELECT password_hash,expires_at FROM admin_sessions WHERE token_hash=?').bind(await hash(token)).first<{password_hash:string;expires_at:number}>();return Boolean(session&&session.expires_at>Date.now()&&session.password_hash===await hash(env.ADMIN_PASSWORD!))}
export async function equalSecrets(a:string,b:string){const x=await hash(a),y=await hash(b);let different=0;for(let i=0;i<x.length;i++)different|=x.charCodeAt(i)^y.charCodeAt(i);return different===0}
