import { useContext, type CSSProperties, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { t } from 'shared';
import type { User } from 'shared';
import { Logo, useOnlineStatus } from 'ui';
import { SupabaseContext } from '../App';

interface AppShellProps {
  user: User;
  children: ReactNode;
}

// Matches Rehab Platform Prototype.dc.html's ACTIVE_NAV / INACTIVE_NAV exactly.
const navBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  fontSize: 14,
  cursor: 'pointer',
  border: 'none',
  fontFamily: 'inherit',
  textAlign: 'start',
  width: '100%',
  textDecoration: 'none',
  boxSizing: 'border-box',
};

const navInactive: CSSProperties = {
  ...navBase,
  borderRadius: 10,
  background: 'transparent',
  color: 'var(--nav-inactive-text)',
  fontWeight: 500,
  borderInlineStart: '2px solid transparent',
};

const navActive: CSSProperties = {
  ...navBase,
  borderRadius: 8,
  background: 'var(--nav-active-bg)',
  color: 'var(--gold-deep)',
  fontWeight: 700,
  borderInlineStart: '2px solid var(--gold-deep)',
};

function NavItem({ to, label, labelEn }: { to: string; label: string; labelEn: string }) {
  return (
    <Link to={to} style={navInactive} activeProps={{ style: navActive }}>
      {label} <span style={{ opacity: 0.65, fontWeight: 400, fontSize: 12 }}>{labelEn}</span>
    </Link>
  );
}

export default function AppShell({ user, children }: AppShellProps) {
  const supabase = useContext(SupabaseContext);
  const online = useOnlineStatus();
  const initials = user.name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('');

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--shell-content-bg)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>
      {!online && (
        <div
          role="status"
          style={{
            flex: 'none', background: 'var(--flag-red)', color: 'var(--cream)',
            fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '6px 12px',
          }}
        >
          {t('offline.banner.clinician')}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside
        style={{
          width: 212,
          flex: 'none',
          background: 'var(--shell-sidebar-bg)',
          borderInlineEnd: '1px solid var(--shell-border)',
          padding: '22px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px 22px' }}>
          <Logo height={62} />
        </div>

        <NavItem to="/dashboard" label={t('clinician.dashboard.title')} labelEn={t('clinician.dashboard.nav_en')} />
        <NavItem to="/patients" label={t('clinician.patients.title')} labelEn={t('clinician.patients.nav_en')} />
        <NavItem to="/protocols" label={t('clinician.protocol.nav')} labelEn={t('clinician.protocol.nav_en')} />
        <NavItem to="/exercises" label={t('clinician.exercise.nav')} labelEn={t('clinician.exercise.nav_en')} />
        <NavItem to="/settings" label={t('clinician.settings.nav')} labelEn={t('clinician.settings.nav_en')} />

        <div
          style={{
            marginTop: 'auto',
            paddingTop: 12,
            borderTop: '1px solid var(--shell-border-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              flex: 'none',
              borderRadius: '50%',
              background: 'var(--nav-active-bg)',
              border: '1px solid var(--shell-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 12,
              color: 'var(--gold-deep)',
            }}
          >
            {initials}
          </div>
          <div style={{ lineHeight: 1.25, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.name}
            </div>
            <button
              onClick={() => supabase.auth.signOut()}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10, color: 'var(--nav-inactive-text)', textDecoration: 'underline' }}
            >
              {t('auth.logout')}
            </button>
          </div>
        </div>
      </aside>

        <main style={{ flex: 1, overflow: 'auto', padding: '26px 30px', boxSizing: 'border-box' }}>{children}</main>
      </div>
    </div>
  );
}
