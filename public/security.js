'use strict';
window.SiteSecurity=(()=>{
 let configuration,scriptPromise;const widgets=new Map();
 async function config(){if(!configuration)configuration=fetch('/api/config',{credentials:'same-origin',cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error('Не удалось загрузить проверку безопасности.');return (await r.json()).turnstile}).catch(e=>{configuration=null;throw e});return configuration}
 function script(){if(!scriptPromise)scriptPromise=new Promise((resolve,reject)=>{if(window.turnstile){resolve();return}const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.async=true;const timer=setTimeout(()=>reject(new Error('Проверка безопасности не загрузилась. Проверь соединение и открой форму ещё раз.')),12000);s.onload=()=>{clearTimeout(timer);resolve()};s.onerror=()=>{clearTimeout(timer);reject(new Error('Проверка безопасности не загрузилась.'))};document.head.append(s)}).catch(e=>{scriptPromise=null;throw e});return scriptPromise}
 async function mount(node,action){
  for(const [el,w]of widgets)if(!el.isConnected){if(w.id!==undefined)window.turnstile?.remove(w.id);widgets.delete(el)}
  const state={token:'',id:undefined,ready:null};widgets.set(node,state);
  state.ready=(async()=>{const c=await config();if(!node.isConnected)return;if(!c.enabled){node.hidden=true;return}node.hidden=false;if(!c.siteKey)throw new Error('Проверка безопасности временно недоступна.');await script();if(!node.isConnected)return;node.textContent='';state.id=window.turnstile.render(node,{sitekey:c.siteKey,action,callback:token=>{state.token=token},'expired-callback':()=>{state.token=''},'error-callback':()=>{state.token='';return true}})})().catch(e=>{state.error=e;node.hidden=false;node.textContent=e.message});await state.ready;
 }
 async function prepare(form,node){const state=widgets.get(node);if(!state)throw new Error('Открой форму ещё раз.');await state.ready;if(state.error)throw state.error;const c=await config();if(c.enabled){if(!state.token)throw new Error('Дождись проверки безопасности или подтверди её.');form.set('cf-turnstile-response',state.token)}}
 function reset(node){const s=widgets.get(node);if(s){s.token='';if(s.id!==undefined)window.turnstile?.reset(s.id)}}
 return {mount,prepare,reset};
})();
