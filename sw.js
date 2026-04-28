// Family Calendar — service worker
//
// Strategy:
//   - HTML (index.html and the root path): network-first → falls back to cache when offline.
//     Updates ship the moment they're pushed; users don't have to clear caches.
//   - Other assets (icon, manifest, etc): cache-first → fast, offline-friendly.
//   - Apps Script API: never touched by SW — always live.

const CACHE_VERSION = 'family-calendar-v3';
const ASSETS = ['./icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Apps Script — never cache
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleusercontent.com')) {
    return;
  }

  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  const isHtml =
    e.request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html');

  if (isHtml) {
    // Network-first for HTML
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() =>
          caches.match(e.request).then((hit) => hit || caches.match('./'))
        )
    );
    return;
  }

  // Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        }).catch(() => caches.match('./'))
    )
  );
});
