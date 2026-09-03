// ============================================================================
//  sw.js — service worker: makes the app installable and fully offline.
//  Bump CACHE when you change any file, so devices pick up the new version.
// ============================================================================
const CACHE = 'jinnyfin-1.24';

const SHELL = [
  './', './index.html', './manifest.webmanifest', './config.js',
  './css/app.css',
  './js/app.js', './js/util.js', './js/store.js', './js/calc.js', './js/charts.js', './js/crypto.js',
  './js/alerts.js',
  './js/views/editor.js', './js/views/dashboard.js', './js/views/transactions.js', './js/views/tasks.js',
  './js/views/report.js', './js/views/incexp.js',
  './js/views/statement.js', './js/views/payee.js', './js/views/business.js', './js/views/equity.js',
  './js/views/networth.js', './js/views/insurance.js', './js/views/cards.js', './js/views/budgets.js',
  './js/views/settings.js', './js/views/importer.js', './js/views/printable.js',
  './icons/icon-32.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never cache Supabase — always talk to the network for data.
  if (url.hostname.endsWith('supabase.co')) return;

  // The seed file and the CDN module: cache-first, they never change.
  if (url.pathname.endsWith('seed-data.json') ||
      /^(cdn\.jsdelivr\.net|esm\.sh|unpkg\.com)$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // App files: network-first so updates land, cache as the offline fallback.
  // `no-cache` matters — a plain fetch() is allowed to answer from the browser's
  // own HTTP cache, which is how a device can keep serving a file that changed
  // on the server hours ago. This forces a revalidation instead.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, url.origin === location.origin ? { cache: 'no-cache' } : undefined);
      if (res.ok && url.origin === location.origin) {
        const c = await caches.open(CACHE); c.put(e.request, res.clone());
      }
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      // Only a page navigation may fall back to the shell. Handing index.html
      // back for a .js request makes the browser parse HTML as a module and the
      // whole app dies with a blank screen — which is exactly what a flaky
      // mobile connection used to trigger.
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

// Renewal reminders pushed from the scheduled job (optional — see SETUP.md).
self.addEventListener('push', e => {
  let data = { title: 'Jinnyfin', body: 'Something needs renewing.' };
  try { data = { ...data, ...e.data.json() }; } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    tag: 'jinnyfin-reminder', data: { url: './#/insurance' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data?.url || './');
  })());
});
