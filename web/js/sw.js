'use strict';
const APP_CACHE='tmux-launch-v16',APP_FILES=['/app','/static/js/i18n-en.js','/static/js/i18n.js','/static/js/i18n-boot.js','/static/js/settings.js','/static/js/accounts.js','/static/js/launcher.js','/static/css/launcher.css','/static/js/launcher-register.js','/static/js/theme.js','/static/css/theme-light.css','/static/css/theme-chrome.css','/static/css/theme-palette.css','/static/css/input-layout.css','/static/manifest.webmanifest','/static/assets/icons/icon-192.png','/static/assets/icons/icon-512.png','/static/assets/icons/maskable-512.png','/static/assets/icons/apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(APP_CACHE);await cache.addAll(APP_FILES);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('tmux-launch-')&&name!==APP_CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 const navigation=event.request.mode==='navigate'&&(url.pathname==='/app'||url.pathname==='/');
 if(!navigation&&!APP_FILES.includes(url.pathname))return;
 event.respondWith((async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
  try{const response=await fetch(event.request,{signal:controller.signal});if(response.status>=500)throw Error('unavailable');
   // Only the public launcher/static assets are stored, never terminal output or auth.
   if(response.ok&&APP_FILES.includes(url.pathname)){const cache=await caches.open(APP_CACHE);await cache.put(url.pathname,response.clone());}return response;
  }catch{const cached=await caches.match(navigation?'/app':url.pathname);return cached||new Response('잠시 뒤 다시 연결해 주세요.',{status:503});}
  finally{clearTimeout(timer);}
 })());
});
self.addEventListener('push',event=>{
  let item;try{item=event.data?.json();}catch{}if(!item)return;
  event.waitUntil((async()=>{
    await self.registration.showNotification(String(item.title||'Q tmux'),{body:String(item.body||'답변이 필요한 질문이 있어요.'),icon:'/static/assets/icons/icon-192.png?v=blue-q1',badge:'/static/assets/icons/icon-192.png?v=blue-q1',tag:'tmux-question-'+String(item.id||''),data:{id:String(item.id||''),url:String(item.url||'/')}});
    if(self.navigator.setAppBadge&&Number.isFinite(item.unread))await self.navigator.setAppBadge(item.unread).catch(()=>{});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const data=event.notification.data||{},target=new URL(data.url||'/',self.location.origin);if(target.origin!==self.location.origin)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(item=>new URL(item.url).origin===self.location.origin);
    if(client){if(new URL(client.url).pathname==='/')client.postMessage({type:'open-notification',id:data.id});else await client.navigate(target.href);await client.focus();}
    else await self.clients.openWindow(target.href);
  })());
});
