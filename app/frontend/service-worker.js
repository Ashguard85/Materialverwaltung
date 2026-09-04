const APP_VERSION = 'v13';
const CACHE_PREFIX = 'maker-inventar-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;
const INDEX_URL = './index.html';

// Files required for the app to boot. If one of these cannot be fetched,
// installation of the new worker fails atomically and the old release stays active.
const ESSENTIAL_SHELL = [
  './index.html',
  './app.js',
  './app.css',
  './db.js',
  './providers.js',
  './zip.js',
  './config.json',
  './VERSION'
];

// Useful install/offline assets. A transient missing icon must not block a valid update.
const OPTIONAL_SHELL = [
  './manifest.webmanifest',
  './offline.html',
  './icons/favicon.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

async function fetchFresh(url) {
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Precache failed: ${url} (${response.status})`);
  return response;
}

async function installShell() {
  const cache = await caches.open(CACHE_NAME);
  for (const url of ESSENTIAL_SHELL) {
    const response = await fetchFresh(url);
    await cache.put(url, response);
  }
  for (const url of OPTIONAL_SHELL) {
    try {
      const response = await fetchFresh(url);
      await cache.put(url, response);
    } catch (error) {
      console.warn('Optional PWA asset could not be cached', url, error);
    }
  }
}

async function cleanupOldCaches() {
  const keys = await caches.keys();
  const currentNumber = Number(APP_VERSION.replace(/^v/, ''));
  await Promise.all(keys.map(key => {
    if (!key.startsWith(CACHE_PREFIX) || key === CACHE_NAME) return Promise.resolve(false);
    const versionNumber = Number(key.slice(CACHE_PREFIX.length).replace(/^v/, ''));
    // Keep one previous complete release as a rollback/offline fallback.
    const safeToDelete = Number.isFinite(currentNumber) && Number.isFinite(versionNumber)
      ? versionNumber < currentNumber - 1
      : false;
    return safeToDelete ? caches.delete(key) : Promise.resolve(false);
  }));
}

self.addEventListener('install', event => {
  // Never skipWaiting automatically. The running version stays stable until a
  // deliberate safe transition initiated by the app.
  event.waitUntil(installShell());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keysBeforeCleanup = await caches.keys();
    const migratingFromV11 = keysBeforeCleanup.includes(`${CACHE_PREFIX}v11`);
    await cleanupOldCaches();
    // One-time compatibility bridge: the v11 client waits for controllerchange
    // after its legacy SKIP_WAITING message. From v13 onward no claim is used.
    if (migratingFromV11) await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'GET_VERSION') {
    const payload = { type: 'APP_VERSION', version: APP_VERSION };
    if (event.ports?.[0]) event.ports[0].postMessage(payload);
    else event.source?.postMessage(payload);
    return;
  }
  // v11 compatibility bridge: that client only sends SKIP_WAITING after an
  // explicit manual update or its former safe-start path. Keep this only for the
  // v11 -> v13 transition; v13 clients use ACTIVATE_UPDATE below.
  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (data.type === 'ACTIVATE_UPDATE' && data.safeActivation === true) {
    event.waitUntil(self.skipWaiting());
  }
});

async function cachedShellResponse() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(INDEX_URL)) || (await cache.match('./'));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Dynamic backend traffic must never come from an app-shell cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return;

  // Explicit probes must always see the network/CDN state.
  if (url.searchParams.has('network-check') || url.searchParams.has('update-check')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Runtime config prefers the network but remains usable when hosting is down.
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

  if (request.mode === 'navigate') {
    // Only the actual app entry may fall back to index.html. Requests for other
    // paths are not silently rewritten into the shell.
    const scopeUrl = new URL(self.registration.scope);
    const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;
    const relativePath = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : null;
    const isAppEntry = relativePath === '' || relativePath === 'index.html';
    if (!isAppEntry) return;

    event.respondWith((async () => {
      const shell = await cachedShellResponse();
      if (shell) return shell;
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(INDEX_URL, response.clone());
        }
        return response;
      } catch {
        return (await caches.match('./offline.html')) || Response.error();
      }
    })());
    return;
  }

  // Static shell assets are cache-first within the active release. A new worker
  // refreshes them atomically into a new versioned cache during install.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
