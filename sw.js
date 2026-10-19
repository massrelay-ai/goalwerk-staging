// Ported from massrelay apps/web/public/sw.js @ 27b4681f0 (Apache-2.0): the offline shell + web-push worker, plain JS fetched by the browser directly.
// Adapted for Atingo (L10): names; the ONE API answer the worker caches is /api/me/progress (so the Path renders offline, with the time it was last
// updated); every other /api/* request is never intercepted, same-origin or the kernel's origin. The worker holds no other state.
//
// STRATEGY.
//   /api/me/progress (GET, any origin)  network-first; an ok answer is stored under a key that includes a hash of the Authorization header
//                                       (learner B never reads learner A's answer); offline, the stored answer is served and the open pages are
//                                       told when it was stored ("atingo:offline-progress").
//   any other /api/*, any write         never intercepted: straight to the network.
//   navigation (same-origin)            network-first, the last good page kept as /index.html; offline: that page, else /offline.html.
//   same-origin GET assets              cache-first, else fetch-then-cache.
//   cross-origin (not progress)         never intercepted.
const SW_VERSION = "l10-v1";
const SHELL_CACHE = `atingo-shell-${SW_VERSION}`;
const RUNTIME_CACHE = `atingo-runtime-${SW_VERSION}`;
const PROGRESS_CACHE = `atingo-progress-${SW_VERSION}`;
const PRECACHE_URLS = ["/", "/index.html", "/offline.html", "/manifest.webmanifest", "/favicon.svg"];
const PROGRESS_PATH = "/api/me/progress";
const CACHED_AT = "x-atingo-cached-at";

/** The route table: what the worker does with a request. Pure; the test loads this file and drives the fetch handler. */
function routeFor(request, url) {
  if (request.method !== "GET") return "skip";
  if (url.pathname === PROGRESS_PATH) return "progress";
  if (url.pathname.startsWith("/api/")) return "skip";
  if (url.origin !== self.location.origin) return "skip";
  if (request.mode === "navigate") return "navigate";
  return "static";
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const progressKey = (request) => `${self.location.origin}/__atingo/progress/${hash(request.headers.get("authorization") || "")}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE, PROGRESS_CACHE];
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => !keep.includes(n)).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});

async function progress(request, event) {
  const key = progressKey(request);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT, new Date().toISOString());
      const copy = new Response(await response.clone().blob(), { status: 200, headers });
      event.waitUntil(caches.open(PROGRESS_CACHE).then((c) => c.put(key, copy)));
    }
    return response;
  } catch (err) {
    const cached = await caches.open(PROGRESS_CACHE).then((c) => c.match(key));
    if (!cached) throw err;
    const at = cached.headers.get(CACHED_AT);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: "atingo:offline-progress", at });
    return cached;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const route = routeFor(request, url);
  if (route === "skip") return;
  if (route === "progress") { event.respondWith(progress(request, event)); return; }
  if (route === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put("/index.html", copy))); }
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached ?? caches.match("/offline.html")))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy))); }
        return response;
      });
    })
  );
});

// Push. Payload {title, body, url, tag, kind}; a tap opens the url (an in-app path).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Atingo", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Atingo", {
      body: data.body || "", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: data.tag || data.kind || "atingo-notification", data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) if (client.url.endsWith(targetUrl) && "focus" in client) return client.focus();
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
