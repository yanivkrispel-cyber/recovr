import { supabase } from '../App';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type EnablePushResult = 'ok' | 'unsupported' | 'denied' | 'no-key' | 'error';

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/app/sw.js');
  } catch {
    return null;
  }
}

/** Ask permission, subscribe to Web Push, register the subscription. */
export async function enablePush(): Promise<EnablePushResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!VAPID_PUBLIC) return 'no-key';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const reg = (await registration()) ?? (await navigator.serviceWorker.ready);
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC,
      }));

    const json = sub.toJSON();
    const { error } = await supabase.functions.invoke('device-tokens', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: json.keys, platform: 'web' },
    });
    return error ? 'error' : 'ok';
  } catch {
    return 'error';
  }
}

/** On app start: if already granted, make sure the SW + subscription are live. */
export async function syncPushSubscription(): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const reg = await registration();
  if (!reg) return;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const json = sub.toJSON();
    await supabase.functions.invoke('device-tokens', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: json.keys, platform: 'web' },
    });
  } catch {
    /* best-effort */
  }
}
