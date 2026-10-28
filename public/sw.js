// Offline support: the app shell and every chapter you open are cached, so the Gita keeps working offline.
// Bump VERSION when the shell list changes; content updates arrive on their own through the background refresh.
const VERSION = "gita-v1";
const SHELL = ["/", "/genz.js", "/config.js", "/manifest.webmanifest", "/icons/icon-192.png", "/data/chapters.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  // Ask Gita and ads always go to the network.
  if ((!sameOrigin && !isFont) || url.pathname.startsWith("/api/")) return;

  // Stale-while-revalidate: answer from the cache at once and refresh it in the background.
  const key = req.mode === "navigate" ? "/" : req;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(key);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached || Response.error());
      if (cached) {
        e.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }),
  );
});
