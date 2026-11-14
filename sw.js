const CACHE='leitor-bilingue-v2';
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./index.html','./app.js?v=2','./manifest.webmanifest','./icon.svg'])));
});
self.addEventListener('activate',e=>{
  e.waitUntil(Promise.all([
    caches.keys().then(names=>Promise.all(names.filter(n=>n!==CACHE).map(n=>caches.delete(n)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
  // Prefer fresh HTML/JS; offline fallback to the current cache.
  e.respondWith(fetch(e.request).then(res=>{
    if(res.ok)caches.open(CACHE).then(c=>c.put(e.request,res.clone()));
    return res;
  }).catch(()=>caches.match(e.request)));
});
