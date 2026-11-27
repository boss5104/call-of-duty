/* Call Of Duty Modern Warfare service worker: ติดตั้งเป็นแอป + แสดงการแจ้งเตือนระบบ */
const CACHE = 'duty-call-v7';
const SHELL = ['./', './index.html', './assets/app.css', './assets/app.js', './config.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network-first สำหรับไฟล์ของแอป (ไม่แตะคำขอไปยัง Google Apps Script)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // ให้ไปถึงเซิร์ฟเวอร์ตรง ๆ เสมอ
  const fresh = e.request.mode === 'navigate'
    ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(fresh).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./?role=staff');
  }));
});
