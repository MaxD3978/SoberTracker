const CACHE_NAME = "soberfeb-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/pwa/manifest.webmanifest",
  "/pwa/icon-192.png",
  "/pwa/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
