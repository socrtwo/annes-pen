// Anne's Pen service worker: makes the web app (and the ChromeOS / desktop-browser install) work
// offline. The build (vite.config.ts, swPrecache) fills in the version and the list of every file
// it emitted; installing caches all of them, so the app, dictionaries and math fonts work offline
// from the first visit. Pages are network-first so an update shows on the next visit; other files
// come from the cache. Each build has its own cache; activating deletes the older ones.
const VERSION = /*__VERSION__*/'dev';
const PRECACHE = /*__PRECACHE__*/[];
const PREFIX = 'annes-pen-';
const CACHE = PREFIX + VERSION;
// Caches of earlier versions of this app (this origin may also host sister apps: leave theirs alone).
const OWN = (k) => k.startsWith(PREFIX) || k === 'quillpen-v1'; // rename:keep

const scope = new URL(self.registration.scope);
const INDEX = new URL('index.html', scope).href;
const isIndex = (url) => url.origin === scope.origin && (url.pathname === scope.pathname || url.pathname === new URL(INDEX).pathname);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(new URL(u, scope).href, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => OWN(k) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      // Only a good copy of the app's own page replaces the cached one (not 404s or other pages).
      if (res.ok && res.type === 'basic' && isIndex(url)) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(INDEX, copy)));
      }
      return res;
    }).catch(async () => (await caches.match(req, { cacheName: CACHE, ignoreSearch: isIndex(url), ignoreVary: true })) || caches.match(INDEX, { cacheName: CACHE, ignoreVary: true })));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (c) => {
    // ignoreVary: module scripts send an Origin header that the precache requests did not.
    const hit = await c.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') e.waitUntil(c.put(req, res.clone()));
    return res;
  }));
});
