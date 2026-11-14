/* Bergamot V3 - worker e WebAssembly no MESMO domínio do app.
 * Não intercepta PDFs nem altera a versão 2 (escopo: /v3-teste/).
 * Espelha somente os quatro arquivos oficiais do pacote npm 0.4.9.
 * Os modelos de tradução são obtidos pela biblioteca diretamente do registro Bergamot.
 */
const VERSION = 'v3-bergamot-worker-1';
const PACKAGE = '@browsermt/bergamot-translator@0.4.9';
const allowed = {
  'translator.js':'text/javascript; charset=utf-8',
  'worker/translator-worker.js':'text/javascript; charset=utf-8',
  'worker/bergamot-translator-worker.js':'text/javascript; charset=utf-8',
  'worker/bergamot-translator-worker.wasm':'application/wasm'
};
const dir = new URL('./vendor/', self.registration.scope).pathname;
self.addEventListener('install', evt => {evt.waitUntil(self.skipWaiting());});
self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('v3-bergamot-worker-') && k !== VERSION).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', evt => {
  const u = new URL(evt.request.url);
  if(u.origin !== self.location.origin || !u.pathname.startsWith(dir))return;
  const path = u.pathname.slice(dir.length);
  if(!Object.prototype.hasOwnProperty.call(allowed,path)) return;
  evt.respondWith((async() => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(path);
    if(cached) return cached;
    const routes = [
      `https://cdn.jsdelivr.net/npm/${PACKAGE}/${path}`,
      `https://unpkg.com/${PACKAGE}/${path}`
    ];
    let error = 'Não foi possível obter arquivo do tradutor';
    for(const endpoint of routes){
      try{
        const remote = await fetch(endpoint,{mode:'cors',credentials:'omit',redirect:'follow'});
        if(!remote.ok){error = `HTTP ${remote.status}: ${endpoint}`;continue;}
        const data = await remote.arrayBuffer();
        if(data.byteLength < 100) {error=`Arquivo muito pequeno: ${path}`;continue;}
        const local = new Response(data,{status:200,headers:{'content-type':allowed[path], 'cache-control':'public, max-age=604800'}});
        await cache.put(path, local.clone());
        return local;
      }catch(e){error=String(e?.message||e);}
    }
    // Erro explícito em vez de uma requisição de worker pendurada.
    return new Response(`Não foi possível carregar ${path}: ${error}`,{status:503,headers:{'content-type':'text/plain; charset=utf-8'}});
  })());
});
