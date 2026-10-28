// Only these public, unauthenticated app files enter this cache.
// Bump the shell revision when public assets change.
const PREFIX = 'common-ground-shared-shell-';
const CACHE = PREFIX + 'b7accc2f2e27';
const INDEX = '/index.html';
const SHELL = [INDEX, '/app.js', '/styles.css', '/mobile.css', '/install.mjs', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
const PUBLIC_PATHS = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload', credentials: 'omit' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Auth, account, profile, Power bump, and chat API responses always use the network.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === INDEX)) {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch { return await (await caches.open(CACHE)).match(INDEX) || Response.error(); }
    })());
    return;
  }
  if (!PUBLIC_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    return await (await caches.open(CACHE)).match(url.pathname) || fetch(request);
  })());
});
