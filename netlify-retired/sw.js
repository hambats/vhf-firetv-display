// Retirement stub for the old Netlify origin.
//
// The display used to live here and registered a Service Worker at this scope. A browser
// that still carries that registration would serve the old cached app shell forever and
// never see the redirect — a cache outliving the site it came from. Browsers re-fetch
// sw.js when they next touch the origin, so replacing it with this file is what actually
// retires the old copy.
//
// This worker claims control, drops every cache it finds, unregisters itself, and reloads
// its clients, which then follow the 301 to GitHub Pages.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url);
  })());
});

// Never serve from cache again; let the network (and the redirect) win.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
