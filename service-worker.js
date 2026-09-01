const APP_VERSION = 'v8';
const CACHE_PREFIX = 'maker-inventar-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './db.js',
  './providers.js',
  './zip.js',
  './config.json',
  './VERSION',
  './manifest.webmanifest',
  './offline.html',
  './icons/favicon.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

function shellRequest(url) {
  return new Request(url, { cache: 'reload', credentials: 'same-origin' });
}

async function installShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL.map(shellRequest));
}

async function cleanupOldCaches() {
  const keys = await caches.keys();
  const currentNumber = Number(APP_VERSION.replace(/^v/, ''));
  await Promise.all(keys.map(key => {
    if (!key.startsWith(CACHE_PREFIX) || key === CACHE_NAME) return Promise.resolve(false);
    const versionNumber = Number(key.slice(CACHE_PREFIX.length).replace(/^v/, ''));
    // Keep exactly one previous release as a conservative fallback.
    const safeToDelete = Number.isFinite(currentNumber) && Number.isFinite(versionNumber)
      ? versionNumber < currentNumber - 1
      : false;
    return safeToDelete ? caches.delete(key) : Promise.resolve(false);
  }));
}

self.addEventListener('install', event => {
  // Intentionally do NOT call skipWaiting here. A freshly downloaded release
  // must not replace a running session without an explicit safe transition.
  event.waitUntil(installShell());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await cleanupOldCaches();
    // Essential after an explicit SKIP_WAITING: make the newly activated worker
    // control the current PWA so controllerchange fires exactly once.
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'APP_VERSION', version: APP_VERSION });
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API and backend health/image traffic must never be served from the app-shell cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Explicit connectivity/version probes always go to the network.
  if (url.searchParams.has('network-check') || url.searchParams.has('update-check')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Runtime configuration prefers the network, but remains available offline.
  if (url.pathname.endsWith('/config.json')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || new Response('{}', {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  // Navigation is deliberately app-shell-first. This is what lets an installed
  // Pages PWA start when GitHub Pages itself is temporarily unavailable.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch {
        return caches.match('./offline.html');
      }
    })());
    return;
  }

  // Immutable app-shell assets are cache-first. They are refreshed atomically
  // into a NEW versioned cache by the next worker during install.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
