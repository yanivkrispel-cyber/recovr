import { supabase } from '../App';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type EnablePushResult = 'ok' | 'unsupported' | 'denied' | 'no-key' | 'error';

/** Ask for permission, subscribe to Web Push, and register the subscription. */
export async function enablePush(): Promise<EnablePushResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  if (!VAPID_PUBLIC) return 'no-key';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const reg = await navigator.serviceWorker.ready;
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

/** Re-register an existing subscription (call on app start when already granted). */
export async function syncPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
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
