/* ============================================================
   DayForge — Service Worker
   Handles: offline caching, background sync, push notifications
   ============================================================ */

const APP_VERSION   = 'v1.1.0';
const CACHE_NAME    = `dayforge-shell-${APP_VERSION}`;
const SYNC_TAG      = 'dayforge-sync';

/* Files that make up the app shell — everything needed to run offline */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

/* ── INSTALL ─────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

/* ── ACTIVATE ────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('dayforge-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))   // delete old versions
      )
    ).then(() => self.clients.claim())      // take control of open tabs
  );
});

/* ── FETCH (network-first for API, cache-first for shell) ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET and cross-origin requests (Firebase SDK handles its own) */
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  /* Firebase Firestore/Auth calls — always go to network */
  if (url.hostname.includes('firebase') || url.hostname.includes('google')) return;

  /* App shell — cache-first, fall back to network */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        /* Clone and cache successful responses */
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        /* Offline fallback — return cached index.html for navigation requests */
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

/* ── BACKGROUND SYNC ─────────────────────────────────────── */
/*
   When the app writes data while offline, it registers a sync tag.
   This event fires when connectivity is restored.
   The app's Firestore SDK handles the actual re-queuing automatically;
   this event is used to notify the UI that sync has completed.
*/
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(notifyClientsOfSync());
  }
});

async function notifyClientsOfSync() {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client =>
    client.postMessage({ type: 'SYNC_COMPLETE', timestamp: Date.now() })
  );
}

/* ── PUSH NOTIFICATIONS ──────────────────────────────────── */
/*
   Used for: Pomodoro timer completion (when app is backgrounded),
   daily reminder to log, streak at-risk warning.
*/
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();

  const options = {
    body:    data.body  || 'Time to log your progress!',
    icon:    data.icon  || '/icons/icon-192.png',
    badge:   data.badge || '/icons/badge-72.png',
    tag:     data.tag   || 'dayforge-notif',
    renotify: true,
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/' },
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'DayForge', options)
  );
});

/* Open the app when a notification is tapped */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      /* Focus existing window if already open */
      for (const client of clients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      /* Otherwise open a new window */
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
