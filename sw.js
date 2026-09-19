const VERSION='ayro-pwa-v2';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  // Network only: Supabase, Mercado Pago, config.js and AYRO API must never use stale cache.
  event.respondWith(fetch(event.request));
});
