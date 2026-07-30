/* Court Card service worker.
   Network-first for the page so pushes show up immediately when online;
   cache is only a fallback for offline. Static assets are cache-first.
   Bump CACHE on any shell change. */
var CACHE = 'court-card-v5';
var SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = req.url;

  // Never touch the Apps Script endpoint.
  if (url.indexOf('script.google.com') > -1 || url.indexOf('googleusercontent.com') > -1) return;

  // Page navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return resp;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Everything else same-origin: cache-first, refresh in background.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return resp;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
