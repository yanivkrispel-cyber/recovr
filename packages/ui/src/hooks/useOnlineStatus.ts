import { useSyncExternalStore } from 'react';

function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * `true` while the browser reports a network connection. SSR/first paint
 * assume online. Backs the offline banners (T-21) — it is not a substitute
 * for handling a failed fetch, since `navigator.onLine` only means "the
 * device has *a* link", not "the server is reachable".
 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
