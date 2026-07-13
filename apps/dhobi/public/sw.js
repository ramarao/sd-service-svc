// Minimal service worker for the Captain PWA (scope: /captain).
// Network-first so captains always get the latest code and job data; falls back
// to cache only when offline. This avoids stale-bundle bugs at the cost of
// needing a connection for the first paint (fine for a live dispatch app).
const CACHE = "captain-v2";
const SHELL = ["/captain", "/captain.js", "/style.css", "/captain-icon.svg", "/captain.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // API/auth: always network, never cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  // Everything else (shell + assets): network-first, cache fallback offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/captain")))
  );
});
