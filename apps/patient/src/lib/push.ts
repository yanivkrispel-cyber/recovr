import { supabase } from '../App';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type EnablePushResult = 'ok' | 'unsupported' | 'denied' | 'no-key' | 'error';

// navigator.serviceWorker.ready never settles when no worker is registered
// (e.g. `vite dev`, where the PWA plugin doesn't register one), which left
// the enable button spinning forever. Treat that as "unsupported here".
function swReady(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  return av.every((x, i) => x === b[i]);
}

// A subscription is bound to the VAPID key it was created with; one made
// against another key (e.g. a dev build's) is rejected by the push service
// for every send, and getSubscription() would hand it back forever. Replace
// it with one for the current key — and drop the dead endpoint server-side.
// Permission is already granted by the time this runs, so no prompt.
async function currentSubscription(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  const keyBytes = base64UrlToBytes(key);
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, keyBytes)) return existing;
  if (existing) {
    const stale = existing.endpoint;
    await existing.unsubscribe();
    await supabase.functions.invoke('device-tokens', { method: 'DELETE', body: { endpoint: stale } });
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function register(sub: PushSubscription) {
  const json = sub.toJSON();
  return supabase.functions.invoke('device-tokens', {
    method: 'POST',
    body: { endpoint: json.endpoint, keys: json.keys, platform: 'web' },
  });
}

/** Ask for permission, subscribe to Web Push, and register the subscription. */
export async function enablePush(): Promise<EnablePushResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!VAPID_PUBLIC) return 'no-key';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const reg = await swReady();
    if (!reg) return 'unsupported';
    const { error } = await register(await currentSubscription(reg, VAPID_PUBLIC));
    return error ? 'error' : 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Re-register the subscription on app start when permission is already
 * granted — replacing it first if it was made with a different VAPID key.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted' || !VAPID_PUBLIC) return;
  try {
    const reg = await swReady();
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    await register(await currentSubscription(reg, VAPID_PUBLIC));
  } catch {
    /* best-effort */
  }
}
