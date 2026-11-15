// V3.3: remove a interceptação dos CDNs utilizada nas versões anteriores.
// Restrito a /v3-teste/: a versão 2 nunca é interceptada.
const VERSION = 'v3-local-3';
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('v3-bergamot-worker-')).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
