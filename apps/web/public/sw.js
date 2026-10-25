/*
 * KICKSCOUT service worker: Web Push match alerts only. It does not cache pages or API answers, so
 * nobody is ever shown an old score as current, and a fix ships the moment it is deployed.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Only same-site paths are opened from a notification. */
function safePath(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/scores';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'KICKSCOUT';
  const options = {
    body: typeof data.body === 'string' ? data.body.slice(0, 200) : '',
    tag: typeof data.tag === 'string' ? data.tag.slice(0, 64) : undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: safePath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (w.url === target && 'focus' in w) return w.focus();
    }
    return self.clients.openWindow(target);
  })());
});
