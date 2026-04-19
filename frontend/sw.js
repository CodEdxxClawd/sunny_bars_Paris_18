const VERSION = 'sunny-bars-v2';
const SHELL = [
  '/',
  '/static/app.js?v=21',
  '/static/vendor/maplibre-gl.css?v=4',
  '/static/style.json',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API / dynamic endpoints
  if (/^\/(sunshine|forecast|shadows|report|api|admin)(\/|$)/.test(url.pathname)) return;

  // Network-first for HTML (fresh content when online)
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return r;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok && (url.origin === location.origin)) {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return r;
    }).catch(() => hit))
  );
});
