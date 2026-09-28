import type { ReactNode } from 'react';
import { t } from 'shared';
import { Logo, useOnlineStatus } from 'ui';

export type PatientTab = 'home' | 'progress' | 'messages' | 'education';

const TABS: { v: PatientTab; icon: string; label: string }[] = [
  { v: 'home', icon: '⌂', label: 'בית' },
  { v: 'progress', icon: '◔', label: 'התקדמות' },
  { v: 'messages', icon: '✉', label: 'הודעות' },
  { v: 'education', icon: 'ℹ', label: 'מידע' },
];

const SAFE_TOP = 'env(safe-area-inset-top, 0px)';
const SAFE_LEFT = 'env(safe-area-inset-left, 0px)';
const SAFE_RIGHT = 'env(safe-area-inset-right, 0px)';

interface AppShellProps {
  activeTab: PatientTab;
  onTabChange: (tab: PatientTab) => void;
  unreadCount?: number;
  messagesUnread?: number;
  onBellClick: () => void;
  children: ReactNode;
}

export default function AppShell({ activeTab, onTabChange, unreadCount, messagesUnread, onBellClick, children }: AppShellProps) {
  const online = useOnlineStatus();
  return (
    // Pinned to the screen rather than sized with 100dvh: on iOS a dvh box is
    // re-measured a beat after a rotation, so the page briefly overflows,
    // scrolls, and snaps back. A fixed box also leaves the document with
    // nothing to scroll, so no stale offset survives the turn back to portrait.
    <div style={{ position: 'fixed', inset: 0, background: 'var(--patient-bg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-ui)' }}>
      {!online && (
        <div
          role="status"
          style={{
            flex: 'none', background: 'var(--patient-dim)', color: 'var(--patient-bg)',
            fontSize: 11, fontWeight: 700, textAlign: 'center', padding: '5px 10px', letterSpacing: '0.03em',
          }}
        >
          {t('offline.banner')}
        </div>
      )}
      {/* The status bar is translucent over the app (viewport-fit=cover), and in
          landscape the notch sits on a side — keep content clear of both. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `calc(${SAFE_TOP} + 16px) calc(${SAFE_RIGHT} + 20px) 2px calc(${SAFE_LEFT} + 20px)` }}>
        <div style={{ flex: 1 }}>
          <Logo tone="light" height={30} />
        </div>
        <button
          onClick={onBellClick}
          aria-label="התראות"
          style={{ width: 38, height: 38, borderRadius: 12, background: 'var(--patient-card)', border: '1px solid var(--patient-border)', color: 'var(--patient-muted)', fontSize: 15, cursor: 'pointer', position: 'relative', flex: 'none' }}
        >
          🔔
          {!!unreadCount && (
            <span
              style={{
                position: 'absolute', top: -4, insetInlineEnd: -4, background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)',
                fontSize: 10, fontWeight: 700, borderRadius: 'var(--radius-pill)', width: 16, height: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', overscrollBehavior: 'contain', padding: `18px calc(${SAFE_RIGHT} + 20px) 20px calc(${SAFE_LEFT} + 20px)`, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {children}
      </div>

      <div style={{ flex: 'none', display: 'flex', background: 'var(--patient-tabbar-bg)', borderTop: '1px solid rgba(201,162,75,.28)', padding: `10px calc(${SAFE_RIGHT} + 8px) calc(env(safe-area-inset-bottom, 0px) + 10px) calc(${SAFE_LEFT} + 8px)` }}>
        {TABS.map((tab) => {
          const on = tab.v === activeTab;
          const badge = tab.v === 'messages' ? messagesUnread : undefined;
          return (
            <button
              key={tab.v}
              onClick={() => onTabChange(tab.v)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '8px 4px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: on ? 'var(--patient-gold)' : 'var(--patient-dim)' }}
            >
              <span style={{ fontSize: 16, lineHeight: 1, position: 'relative' }}>
                {tab.icon}
                {!!badge && (
                  <span
                    style={{
                      position: 'absolute', top: -6, insetInlineEnd: -10, background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)',
                      fontSize: 9, fontWeight: 700, borderRadius: 'var(--radius-pill)', minWidth: 15, height: 15, padding: '0 3px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                    }}
                  >
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em' }}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
