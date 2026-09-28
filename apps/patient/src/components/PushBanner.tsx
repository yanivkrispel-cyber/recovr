import { useState } from 'react';
import { t } from 'shared';
import { enablePush, pushSupport, type PushSupport } from '../lib/push';

// Home-screen nudge towards notifications: on iOS outside the installed app it
// points at the install steps (push is impossible there until installed);
// elsewhere, while permission is still undecided, it turns push on in place.
// Dismissing hides it for two weeks.

const DISMISS_KEY = 'recovr.push-banner.dismissed-at';
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

type IosSupport = Exclude<PushSupport, 'supported' | 'unsupported'>;

/** Why push can't be turned on in this iOS context, and how to get there. */
export function IosPushHelp({ support }: { support: IosSupport }) {
  if (support === 'ios-old' || support === 'ios-in-app') {
    return (
      <div style={{ fontSize: 13, color: 'var(--patient-text)', lineHeight: 1.6, background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 12 }}>
        {t(support === 'ios-old' ? 'push.ios.old' : 'push.ios.in_app')}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 13, color: 'var(--patient-text)', lineHeight: 1.6, background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('push.ios.install.title')}</div>
      <ol style={{ margin: 0, paddingInlineStart: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>{t('push.ios.install.step1')}</li>
        <li>{t('push.ios.install.step2')}</li>
        <li>{t('push.ios.install.step3')}</li>
      </ol>
    </div>
  );
}

export default function PushBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const support = pushSupport();
  const [hidden, setHidden] = useState(
    () =>
      dismissedRecently() ||
      support === 'unsupported' ||
      (support === 'supported' && Notification.permission !== 'default'),
  );
  const [busy, setBusy] = useState(false);

  if (hidden) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage unavailable — it just comes back next launch */
    }
    setHidden(true);
  }

  async function handleEnable() {
    setBusy(true);
    const result = await enablePush();
    setBusy(false);
    // Anything but success needs the explanation on the settings screen.
    if (result === 'ok') setHidden(true);
    else onOpenSettings();
  }

  const isIos = support !== 'supported';

  return (
    <div
      role="status"
      style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--patient-card)', border: '1px solid var(--patient-border)', borderRadius: 14, padding: '10px 12px', marginBottom: 12 }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>🔔</span>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--patient-text)', lineHeight: 1.5 }}>
        {t(isIos ? 'push.banner.install' : 'push.banner.enable')}
      </div>
      <button
        onClick={isIos ? onOpenSettings : handleEnable}
        disabled={busy}
        style={{ background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', border: 'none', borderRadius: 999, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: busy ? 0.6 : 1 }}
      >
        {t(isIos ? 'push.banner.action' : 'push.banner.enable_action')}
      </button>
      <button
        onClick={dismiss}
        aria-label={t('push.banner.dismiss')}
        style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: 4 }}
      >
        ×
      </button>
    </div>
  );
}
