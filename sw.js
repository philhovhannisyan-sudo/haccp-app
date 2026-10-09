// Сервис-воркер: приложение открывается и без сети.
// Сначала сеть (чтобы обновления приходили сразу), при отсутствии сети — сохранённая копия.
const CACHE = 'haccp-app-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Данные GitHub и всё чужое не трогаем
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
