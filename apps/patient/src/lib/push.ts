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

/**
 * Whether this browser can turn on push right now, and if not, why.
 *
 * iOS only exposes Web Push (PushManager / Notification) to a PWA launched
 * from the Home Screen, on iOS 16.4+. In a Safari tab the APIs are simply
 * absent, so a plain feature check reads "unsupported" — the patient needs
 * install steps instead. In-app browsers (links opened from Instagram,
 * Facebook, Gmail…) can't add to the Home Screen at all; they have to go to
 * Safari first.
 */
export type PushSupport = 'supported' | 'ios-install' | 'ios-in-app' | 'ios-old' | 'unsupported';

function iosVersion(): number | null {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as desktop Safari ("Macintosh"); touch points give it away.
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIos) return null;
  const m = ua.match(/OS (\d+)_(\d+)/) ?? ua.match(/Version\/(\d+)\.(\d+)/);
  // major*100+minor, so 16.4 -> 1604 and 16.10 -> 1610 compare correctly; 0 = unknown.
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

export function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

export function pushSupport(): PushSupport {
  const ios = iosVersion();
  if (ios !== null && !isStandalone()) {
    if (ios > 0 && ios < 1604) return 'ios-old';
    // Safari and Chrome/Firefox/Edge on iOS carry a "Safari/" token and can
    // all add to the Home Screen (16.4+); embedded webviews don't.
    return /Safari\//.test(navigator.userAgent) ? 'ios-install' : 'ios-in-app';
  }
  if ('serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined') return 'supported';
  if (ios !== null && ios > 0 && ios < 1604) return 'ios-old';
  return 'unsupported';
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
