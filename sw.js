// Service worker: offline app shell, notification clicks, background alert checks.
// Bump VERSION when files change.
importScripts('alerts-core.js');

const VERSION = 'calendar-v5.1.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './assistant.js',
  './alerts-core.js',
  './llm-worker.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('calendar-') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first (always fresh when online), cache fallback when offline.
// The on-device AI engine (esm.run) is cached so the assistant also works offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (!same && url.hostname !== 'esm.run' && url.hostname !== 'cdn.jsdelivr.net') return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req.mode === 'navigate' ? './index.html' : req, copy)); }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true }))
  );
});

/* ---------- notifications ---------- */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const key = e.notification.data && e.notification.data.key;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) {
      await win.focus();
      if (key) win.postMessage({ type: 'open-day', key });
    } else {
      await clients.openWindow('./' + (key ? `?day=${key}` : ''));
    }
  })());
});

/* ---------- background checks (Chrome/Android installed PWA: periodic background sync) ---------- */
function idbGet(key) {
  return new Promise(res => {
    const r = indexedDB.open('calendar-pwa', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => res(undefined);
    r.onsuccess = () => {
      const q = r.result.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    };
  });
}
function idbSet(key, val) {
  return new Promise(res => {
    const r = indexedDB.open('calendar-pwa', 1);
    r.onerror = () => res();
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put(val, key);
      t.oncomplete = res; t.onerror = res;
    };
  });
}

async function backgroundCheck() {
  const settings = (await idbGet('asstSettings')) || {};
  if (!settings.notify || self.Notification && Notification.permission !== 'granted') return;
  // skip if a window is visible: the page handles alerts itself
  const wins = await clients.matchAll({ type: 'window' });
  if (wins.some(w => w.visibilityState === 'visible')) return;

  const days = (await idbGet('days')) || {};
  const sent = (await idbGet('notified')) || {};
  const now = new Date();
  for (const it of CalAlerts.urgentItems(days, settings, now)) {
    const s = CalAlerts.sig(it);
    if (sent[s]) continue;
    const n = CalAlerts.notificationFor(it, now);
    await self.registration.showNotification(n.title, { body: n.body, tag: s, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { key: it.key } });
    sent[s] = Date.now();
  }
  if (settings.weeklyDigest && Object.keys(days).length) {
    const wk = CalAlerts.weekStartKey(now);
    const last = await idbGet('digestWeek');
    if (last && last !== wk) {
      const d = CalAlerts.weekDigest(days, now);
      await self.registration.showNotification(d.title, { body: d.body, tag: 'digest-' + wk, icon: 'icons/icon-192.png', data: { key: wk } });
      await idbSet('digestWeek', wk);
    }
  }
  await idbSet('notified', sent);
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'calendar-alerts') e.waitUntil(backgroundCheck());
});
