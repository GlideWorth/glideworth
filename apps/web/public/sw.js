/*
 * Glideworth service worker: an offline shell. The app itself (HTML, JS, CSS, fonts, icons) is cached so
 * Glideworth opens without a connection; your data is never cached here: API, MCP and docs requests
 * always go to the network.
 */
// Filled in by the build (vite.config.ts, serviceWorkerManifest); empty in development.
const BUILD = /*__BUILD__*/ 'dev';
/** Everything the first render needs: installed atomically. */
const PRECACHE = /*__PRECACHE__*/ [];
/** Every other script (pages, workers): fetched in the background once active. */
const WARM = /*__WARM__*/ [];
const VERSION = `glideworth-shell-${BUILD}`;
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/glideworth.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  ...PRECACHE,
];
const NEVER = /^\/(api|mcp|docs|openapi\.json|health)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      // Best effort: a page or worker that fails to download now is fetched (and cached) on first use.
      .then(() => caches.open(VERSION))
      .then((cache) =>
        Promise.all(
          WARM.map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => undefined))),
        ),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;

  // Pages: network first (fresh app), falling back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build assets are immutable: cache first. Everything else: stale-while-revalidate.
  const immutable = url.pathname.startsWith('/assets/');
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit && immutable) return hit;
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || Response.error());
      return hit || network;
    }),
  );
});
