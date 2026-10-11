// Offline app shell. The deploy build replaces __BUILD__ with a content hash,
// so every release installs as one atomic new cache. Unbuilt (development)
// copies go network-first so edits show up on reload.

const BUILD = "__BUILD__";
const DEV = BUILD.startsWith("__");
const SHELL_CACHE = `snap-diary-shell-${BUILD}`;
const CDN_CACHE = "snap-diary-cdn-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./config.js",
  "./css/app.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/config.js",
  "./js/depth.js",
  "./js/drive.js",
  "./js/grain.js",
  "./js/images.js",
  "./js/lock.js",
  "./js/model.js",
  "./js/place3d.js",
  "./js/repo.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/ui.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("snap-diary-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const key = request.mode === "navigate" ? "./index.html" : request;
  if (!DEV) {
    const hit = await cache.match(key, { ignoreSearch: request.mode === "navigate" });
    if (hit) return hit;
  }
  try {
    const response = await fetch(request);
    if (response.ok && request.mode !== "navigate") cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw error;
  }
}

// Versioned CDN files (the AI runtime) never change for a given URL.
async function cdn(request) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(shell(request));
  else if (url.hostname === "cdn.jsdelivr.net") event.respondWith(cdn(request));
  // Google APIs, sign-in and model downloads go straight to the network.
});
