// Offline cache for the static app shell only. Never caches or sees promo codes:
// the app makes no requests that contain them.
const VERSION = "camcut-codes-v5";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "core.js",
  "styles.css",
  "vendor/qrcode.mjs",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first, so the wallet opens instantly with no signal. Same-origin GETs only.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("index.html").then((r) => r || fetch(req));
      return fetch(req);
    })
  );
});
