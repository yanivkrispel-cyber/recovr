/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa injectManifest). Keeps the T-12
// offline caching and adds T-18 Web Push handling.
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { RangeRequestsPlugin } from 'workbox-range-requests';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

self.skipWaiting();
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

precacheAndRoute(self.__WB_MANIFEST ?? []);

// Cache-first for exercise media; SWR for the plan/today/progress JSON. The
// match is on url.pathname because the Supabase API/Storage is a different
// origin in every environment (see the note in the previous vite.config.ts).
// GIFs are the bulk of the library's media, so they must be in this list.
// Range requests: Safari fetches <video> with Range headers and won't play a
// full-body 200 served from cache, so clips need the RangeRequestsPlugin.
registerRoute(
  ({ url }) => /\/(exercise-media|exercises)\/.+\.(jpe?g|png|gif|webp|mp4|webm)$/.test(url.pathname),
  new CacheFirst({
    cacheName: 'exercise-media',
    plugins: [
      new RangeRequestsPlugin(),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);
registerRoute(
  ({ url }) => /\/functions\/v1\/me-(today|plan|progress)$/.test(url.pathname),
  new StaleWhileRevalidate({
    cacheName: 'plan-json',
    plugins: [new ExpirationPlugin({ maxEntries: 5, maxAgeSeconds: 60 * 60 * 12 })],
  }),
);

self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string } = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  // Tell open app windows too, so they refresh the unread badge / thread now
  // instead of waiting for the next poll (see App.tsx).
  void self.clients.matchAll({ type: 'window' }).then((wins) => {
    for (const w of wins) w.postMessage({ type: 'push', tag: data.tag ?? null });
  });
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'ReCOVR', {
      body: data.body ?? '',
      tag: data.tag,
      dir: 'rtl',
      lang: 'he',
      icon: '/m/icons/icon-192.png',
      badge: '/m/icons/icon-192.png',
      data: { url: data.url ?? '/m/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/m/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        const client = w as WindowClient;
        if ('focus' in client) {
          void client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
