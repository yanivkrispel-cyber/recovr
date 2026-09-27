import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { t } from 'shared';
import type { User } from 'shared';
import { Logo, useOnlineStatus } from 'ui';
import { SupabaseContext } from '../App';

// Phone layout of the clinician shell (<768px, see useIsPhone): slim top bar,
// content, and a bottom tab bar. Secondary sections (protocols, library,
// settings, sign-out) live in the "More" sheet — on a phone the clinician is
// mostly following patients, chatting, and adjusting plans.

const TAB_BAR_HEIGHT = 60;

type IconName = 'dashboard' | 'patients' | 'messages' | 'more';

function NavIcon({ name }: { name: IconName }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'patients':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
          <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
          <path d="M21.5 20c0-2.8-1.6-4.9-4-5.7" />
        </svg>
      );
    case 'messages':
      return (
        <svg {...common}>
          <path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.4A8.5 8.5 0 1 1 20.5 11.5z" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.2" fill="currentColor" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
          <circle cx="19" cy="12" r="1.2" fill="currentColor" />
        </svg>
      );
  }
}

const tabStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  minHeight: TAB_BAR_HEIGHT,
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'inherit',
  color: 'var(--nav-inactive-text)',
  textDecoration: 'none',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  WebkitTapHighlightColor: 'transparent',
};

const tabActive: CSSProperties = { ...tabStyle, color: 'var(--gold-deep)' };

function TabLink({ to, icon, label, badge }: { to: string; icon: IconName; label: string; badge?: number }) {
  return (
    <Link to={to} style={tabStyle} activeProps={{ style: tabActive, 'aria-current': 'page' }}>
      <span style={{ position: 'relative', display: 'flex' }}>
        <NavIcon name={icon} />
        {badge ? (
          <span
            aria-label={t('clinician.messages.unread', { count: badge })}
            style={{
              position: 'absolute', top: -5, insetInlineStart: 13, minWidth: 17, height: 17, padding: '0 4px', boxSizing: 'border-box',
              borderRadius: 9, background: 'var(--flag-red)', color: 'var(--cream)', fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--shell-sidebar-bg)',
            }}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
      {label}
    </Link>
  );
}

const MORE_ROUTES = ['/protocols', '/exercises', '/settings'];

const sheetItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '15px 18px',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--ink)',
  textDecoration: 'none',
  borderTop: '1px solid var(--shell-border-soft)',
};

function MoreSheet({ user, onClose }: { user: User; onClose: () => void }) {
  const supabase = useContext(SupabaseContext);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const item = (to: string, label: string, labelEn: string) => (
    <Link to={to} style={sheetItem} onClick={onClose}>
      {label}
      <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>{labelEn}</span>
    </Link>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-overlay)', background: 'rgba(27,33,64,.42)', display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('clinician.nav.menu')}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: 'var(--shell-sidebar-bg)',
          borderRadius: '16px 16px 0 0',
          boxShadow: 'var(--shadow-modal)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--shell-border)', margin: '10px auto 6px' }} />
        {item('/protocols', t('clinician.protocol.nav'), t('clinician.protocol.nav_en'))}
        {item('/exercises', t('clinician.exercise.nav'), t('clinician.exercise.nav_en'))}
        {item('/settings', t('clinician.settings.nav'), t('clinician.settings.nav_en'))}
        <div style={{ ...sheetItem, fontWeight: 400 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--flag-red)', fontFamily: 'inherit' }}
          >
            {t('auth.logout')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PhoneShell({ user, children }: { user: User; children: ReactNode }) {
  const supabase = useContext(SupabaseContext);
  const online = useOnlineStatus();
  const { data: unread } = useQuery({
    queryKey: ['messages-unread'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('messages?unread=1', { method: 'GET' });
      if (error) throw error;
      return (data as { total: number }).total;
    },
    refetchInterval: 30_000,
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inMore = MORE_ROUTES.some((r) => pathname.endsWith(r) || pathname.includes(`${r}/`));

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--shell-content-bg)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 'var(--z-sticky)',
          background: 'var(--shell-sidebar-bg)',
          borderBottom: '1px solid var(--shell-border)',
          padding: 'calc(8px + env(safe-area-inset-top)) 16px 8px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Logo height={34} />
      </header>
      {!online && (
        <div role="status" style={{ background: 'var(--flag-red)', color: 'var(--cream)', fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '6px 12px' }}>
          {t('offline.banner.clinician')}
        </div>
      )}

      <main style={{ flex: 1, minWidth: 0, padding: `16px 16px calc(${TAB_BAR_HEIGHT + 20}px + env(safe-area-inset-bottom))`, boxSizing: 'border-box' }}>
        {children}
      </main>

      <nav
        aria-label={t('clinician.nav.menu')}
        style={{
          position: 'fixed',
          insetInline: 0,
          bottom: 0,
          zIndex: 'var(--z-sticky)',
          display: 'flex',
          background: 'var(--shell-sidebar-bg)',
          borderTop: '1px solid var(--shell-border)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <TabLink to="/dashboard" icon="dashboard" label={t('clinician.dashboard.title')} />
        <TabLink to="/patients" icon="patients" label={t('clinician.patients.title')} />
        <TabLink to="/messages" icon="messages" label={t('clinician.messages.title')} badge={unread} />
        <button
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          style={inMore ? tabActive : tabStyle}
        >
          <NavIcon name="more" />
          {t('clinician.nav.more')}
        </button>
      </nav>

      {moreOpen && <MoreSheet user={user} onClose={() => setMoreOpen(false)} />}
    </div>
  );
}
