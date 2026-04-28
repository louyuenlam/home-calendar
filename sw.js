// Family Calendar — service worker
// Cache-first for app shell so it opens offline.

const CACHE = 'family-calendar-v1';
const ASSETS = ['./', './index.html', './icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache the Apps Script API — always go to network so sync stays live.
  if (url.hostname.includes('script.google.com')) return;

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
