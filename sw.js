// Cache only this app's shell; never intercept API requests or other sites.
const CACHE='court-card-v7-integrity';
const SHELL=['./index.html','./manifest.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('court-card-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 const req=e.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==self.location.origin)return;
 if(req.mode==='navigate')e.respondWith(fetch(req).then(async r=>{if(r.ok){const c=await caches.open(CACHE);await c.put('./index.html',r.clone());}return r;}).catch(()=>caches.match('./index.html')));
 else if(SHELL.some(p=>new URL(p,self.registration.scope).pathname===url.pathname))e.respondWith(caches.match(req).then(hit=>hit||fetch(req)));
});
