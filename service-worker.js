const APP_VERSION = 'v5';
const CACHE_PREFIX = 'maker-inventar-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './db.js',
  './providers.js',
  './config.json',
  './manifest.webmanifest',
  './offline.html',
  './icons/favicon.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      const currentNumber = Number(APP_VERSION.replace(/^v/, ''));
      return Promise.all(keys.map(key => {
        if (!key.startsWith(CACHE_PREFIX) || key === CACHE_NAME) return Promise.resolve(false);
        const versionNumber = Number(key.slice(CACHE_PREFIX.length).replace(/^v/, ''));
        const safeToDelete = Number.isFinite(currentNumber) && Number.isFinite(versionNumber)
          ? versionNumber < currentNumber - 1
          : false;
        return safeToDelete ? caches.delete(key) : Promise.resolve(false);
      }));
    })
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'APP_VERSION', version: APP_VERSION });
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has('network-check')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (url.pathname.endsWith('/config.json')) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(() => caches.match(request).then(cached => cached || new Response('{}', { headers: { 'Content-Type': 'application/json' } })))
    );
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(request).catch(() => caches.match('./offline.html')))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
