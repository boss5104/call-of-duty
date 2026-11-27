/* Call Of Duty Modern Warfare service worker: ติดตั้งเป็นแอป + แจ้งเตือนแบบ push (เด้งขึ้นจอแม้ปิดแอป) */
const CACHE = 'duty-call-v9';
const CFG_CACHE = 'dc-cfg';          // ที่เก็บ API URL ที่หน้าเว็บส่งมาให้ (ห้ามลบตอนอัปเดต)
const CFG_KEY = './__dc_cfg';
const SHELL = ['./', './index.html', './assets/app.css', './assets/app.js', './config.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png'];
// สั่นยาว ๆ ~10 วินาที (Android) — iPhone ไม่รองรับการสั่นผ่านเว็บ
const VIBRATE = [1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CFG_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network-first สำหรับไฟล์ของแอป (ไม่แตะคำขอไปยัง Google Apps Script)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/__dc_cfg')) return;
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

/* ---------------- Push ---------------- */

async function cfg() {
  try { const r = await (await caches.open(CFG_CACHE)).match(CFG_KEY); return r ? await r.json() : {}; } catch (_) { return {}; }
}

async function api(action, p) {
  const { api: url } = await cfg();
  if (!url) throw new Error('no api');
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) throw new Error('no subscription');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ action, endpoint: sub.endpoint }, p)), redirect: 'follow', signal: ctl.signal });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'error');
    return j;
  } finally { clearTimeout(t); }
}

const acked = new Set(); // การเรียกที่กดรับทราบจากแจ้งเตือนแล้ว (กันเด้งซ้ำระหว่างรอเซิร์ฟเวอร์)

function callNotification(c) {
  return self.registration.showNotification('🚨 ' + (c.message || 'มีการเรียกปฏิบัติหน้าที่'), {
    body: (c.detail ? c.detail + '\n' : '') + 'กด “รับทราบ / ตอบรับ” — แจ้งเตือนจะดังซ้ำจนกว่าจะตอบรับ',
    tag: 'call-' + c.callId,
    renotify: true,             // ดัง + สั่นใหม่ทุกครั้งที่ส่งซ้ำ
    requireInteraction: true,   // ค้างบนจอจนกว่าจะกด
    silent: false,
    vibrate: VIBRATE,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    timestamp: c.createdAt || Date.now(),
    data: { callId: c.callId, message: c.message, detail: c.detail, createdAt: c.createdAt },
    actions: [
      { action: 'ack', title: '✅ รับทราบ / ตอบรับ' },
      { action: 'open', title: '🔊 เปิดแอป' }
    ]
  });
}

async function onPush(e) {
  // ข้อมูลการเรียกมากับ push (เข้ารหัส) → แสดงได้ทันทีไม่ต้องรอเซิร์ฟเวอร์
  let r = null;
  try {
    const d = e.data && e.data.json();
    if (d && d.t === 'test') r = { test: true, calls: [] };
    else if (d && d.t === 'call') r = { calls: d.calls || [] };
  } catch (_) {}
  if (!r) { try { r = await api('swPoll'); } catch (_) {} }
  if (!r) {
    // ดึงรายละเอียดไม่ได้ (เน็ตไม่ดี) — ยังต้องเด้งเตือนอยู่ดี
    return callNotification({ callId: 'unknown', message: 'มีการเรียกปฏิบัติหน้าที่!', detail: 'แตะเพื่อเปิดแอปและกดตอบรับ' });
  }
  const calls = (r.calls || []).filter(c => !acked.has(c.callId));
  tellClients({ type: 'push' });
  if (r.test) {
    await self.registration.showNotification('🚨 ทดสอบการแจ้งเตือน', {
      body: 'ระบบเด้งแจ้งเตือนได้แม้ปิดแอปแล้ว ✓ แตะเพื่อปิด', tag: 'dc-test', renotify: true,
      requireInteraction: true, vibrate: VIBRATE, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { test: true }
    });
    if (!calls.length) return;
  }
  if (!calls.length) {
    // ตอบรับครบแล้ว: เก็บแจ้งเตือนเก่าออก (เบราว์เซอร์บังคับให้ต้องแสดงอะไรบางอย่าง จึงแสดงสั้น ๆ แล้วปิด)
    (await self.registration.getNotifications()).forEach(n => { if (/^call-/.test(n.tag)) n.close(); });
    await self.registration.showNotification('Call Of Duty', { body: 'ไม่มีการเรียกค้างตอบรับ', tag: 'dc-info', silent: true, icon: 'icons/icon-192.png' });
    setTimeout(() => self.registration.getNotifications({ tag: 'dc-info' }).then(l => l.forEach(n => n.close())), 3000);
    return;
  }
  const live = new Set(calls.map(c => 'call-' + c.callId));
  (await self.registration.getNotifications()).forEach(n => { if (/^call-/.test(n.tag) && !live.has(n.tag)) n.close(); });
  await Promise.all(calls.map(callNotification));
}

self.addEventListener('push', e => { e.waitUntil(onPush(e)); });

function tellClients(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => list.forEach(c => c.postMessage(msg)));
}

async function openApp() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of list) {
    if ('focus' in c) { c.postMessage({ type: 'push' }); return c.focus(); }
  }
  return self.clients.openWindow('./?role=staff');
}

function callIdOf(n) {
  return (n.data && n.data.callId) || (/^call-(.+)$/.exec(n.tag || '') || [])[1] || '';
}

self.addEventListener('notificationclick', e => {
  const n = e.notification, id = callIdOf(n);
  n.close();
  if (e.action === 'ack' && id && id !== 'unknown') {
    e.waitUntil((async () => {
      acked.add(id);
      try {
        await api('swAck', { callId: id });
        tellClients({ type: 'acked', callId: id });
        await self.registration.showNotification('✅ ตอบรับแล้ว', { body: 'แจ้งผู้บังคับบัญชาแล้ว: ' + ((n.data && n.data.message) || ''), tag: 'dc-ok', silent: true, icon: 'icons/icon-192.png' });
        setTimeout(() => self.registration.getNotifications({ tag: 'dc-ok' }).then(l => l.forEach(x => x.close())), 4000);
      } catch (_) {
        // ส่งไม่สำเร็จ → เปิดแอปให้กดตอบรับในแอปแทน
        acked.delete(id);
        await openApp();
      }
    })());
    return;
  }
  e.waitUntil(openApp());
});

// ปัดแจ้งเตือนทิ้งโดยไม่ตอบรับ → เด้งกลับมาใหม่ทันที (พร้อมเสียง/สั่น)
self.addEventListener('notificationclose', e => {
  const n = e.notification, id = callIdOf(n);
  if (!/^call-/.test(n.tag || '') || !id || acked.has(id)) return;
  e.waitUntil((async () => {
    if (id !== 'unknown') {
      try {
        const r = await api('swPoll');
        if (!(r.calls || []).some(c => c.callId === id)) return; // ตอบรับจากที่อื่น / ปิดการเรียกแล้ว
      } catch (_) {}
    }
    await callNotification(Object.assign({ callId: id }, n.data || {}));
  })());
});
