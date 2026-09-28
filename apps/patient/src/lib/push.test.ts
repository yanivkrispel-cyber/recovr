import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../App', () => ({ supabase: {} }));

const { pushSupport } = await import('./push');

const IPHONE_SAFARI_17 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_SAFARI_16_3 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';

function env(ua: string, opts: { standalone?: boolean; push?: boolean } = {}) {
  vi.stubGlobal('navigator', {
    userAgent: ua,
    platform: /iPhone/.test(ua) ? 'iPhone' : 'Linux',
    maxTouchPoints: 5,
    standalone: opts.standalone ?? false,
    ...(opts.push ? { serviceWorker: {} } : {}),
  });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: opts.standalone ?? false }),
    ...(opts.push ? { PushManager: class {} } : {}),
  });
  if (opts.push) vi.stubGlobal('Notification', { permission: 'default' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pushSupport', () => {
  it('asks iOS Safari (not installed) to add to the Home Screen', () => {
    env(IPHONE_SAFARI_17);
    expect(pushSupport()).toBe('ios-install');
  });

  it('flags iOS below 16.4 as too old', () => {
    env(IPHONE_SAFARI_16_3);
    expect(pushSupport()).toBe('ios-old');
  });

  it('sends in-app browsers on iOS to Safari first', () => {
    env(IPHONE_INSTAGRAM);
    expect(pushSupport()).toBe('ios-in-app');
  });

  it('allows push in the installed iOS app', () => {
    env(IPHONE_SAFARI_17, { standalone: true, push: true });
    expect(pushSupport()).toBe('supported');
  });

  it('allows push on Android Chrome', () => {
    env(ANDROID_CHROME, { push: true });
    expect(pushSupport()).toBe('supported');
  });

  it('reports browsers without the Push API as unsupported', () => {
    env(ANDROID_CHROME);
    expect(pushSupport()).toBe('unsupported');
  });
});
