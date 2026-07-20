// Sprite Baker service worker — caches the app shell + Three.js CDN modules
// for true offline use after the first successful load.
//
// IMPORTANT: bump CACHE_NAME on every deploy that changes index.html, style.css,
// or app.js. Without this, the cache-first strategy below will keep serving the
// old cached files even after you've pushed new ones to GitHub — the browser
// won't know anything changed.

const CACHE_NAME = 'sprite-baker-v6';

// App shell — same-origin files
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// Three.js CDN modules used by the importmap + loaders.
// Precached on install so the app works fully offline after first run.
const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.165.0';
const CDN_SHELL = [
  `${THREE_BASE}/build/three.module.js`,
  `${THREE_BASE}/examples/jsm/loaders/GLTFLoader.js`,
  `${THREE_BASE}/examples/jsm/loaders/DRACOLoader.js`,
  `${THREE_BASE}/examples/jsm/controls/OrbitControls.js`,
  `${THREE_BASE}/examples/jsm/libs/draco/gltf/draco_decoder.js`,
  `${THREE_BASE}/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js`,
  `${THREE_BASE}/examples/jsm/libs/draco/gltf/draco_decoder.wasm`,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // App shell — same-origin, should always succeed
    await cache.addAll(APP_SHELL);
    // CDN files — best-effort; a single failure shouldn't block install
    // (GLTFLoader may pull in a couple of extra small submodules at runtime;
    // those get caught by the fetch handler's "cache what we fetch" fallback below).
    await Promise.all(CDN_SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (e) {
        // Non-fatal — will be cached on first successful online fetch instead.
      }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isCDN = url.hostname === 'cdn.jsdelivr.net';
  const isSameOrigin = url.origin === self.location.origin;

  if (!isCDN && !isSameOrigin) return; // let other cross-origin requests pass through normally

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // Cache any successful same-origin or CDN response we haven't seen yet
      // (covers extra Three.js submodules GLTFLoader may pull in at runtime).
      if (res && res.ok && (isCDN || isSameOrigin)) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // Offline and not cached — for navigations, fall back to the app shell.
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
