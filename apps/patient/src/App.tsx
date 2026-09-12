import { createClient, type Session } from '@supabase/supabase-js';
import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from 'shared';
import { Skeleton, FullPageLoader } from 'ui';
import AppShell, { type PatientTab } from './components/AppShell';
import Home from './pages/Home';
import Login from './pages/Login';
import { useQuery } from '@tanstack/react-query';
import { enablePush, syncPushSubscription, type EnablePushResult } from './lib/push';

// Home + Login load with the shell; the rest split into their own chunks so
// first paint doesn't carry the whole app (T-24).
const ExerciseFlow = lazy(() => import('./pages/ExerciseFlow'));
const Progress = lazy(() => import('./pages/Progress'));
const Education = lazy(() => import('./pages/Education'));
const Messages = lazy(() => import('./pages/Messages'));
const InviteAccept = lazy(() => import('./pages/InviteAccept'));
const HomeProgramPrint = lazy(() => import('./pages/HomeProgramPrint'));

function ViewFallback() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
      <Skeleton width={160} height={19} />
      <Skeleton count={4} height={48} radius={12} />
    </div>
  );
}

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export { supabase };

type View = 'home' | 'exercise' | 'completion' | 'progress' | 'messages' | 'education' | 'notifications';

// /m/invite/:token and /m/program/print — the only paths this app parses;
// everything else is local view state, matching the "no router" pattern.
function getInviteToken(): string | null {
  const match = window.location.pathname.match(/\/invite\/([^/]+)/);
  return match ? match[1] : null;
}

function isPrintRoute(): boolean {
  return /\/program\/print\/?$/.test(window.location.pathname);
}

const ACTIVE_EXERCISE_KEY = 'rehab:activeView';

// Restores the exercise flow across a reload or an app restart mid-session —
// see T-11 "interrupting mid-session and returning restores exact position".
function loadActiveExercise(): { view: View; index: number } | null {
  try {
    const raw = localStorage.getItem(ACTIVE_EXERCISE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.view === 'exercise' && typeof saved.index === 'number') {
      return { view: 'exercise', index: saved.index };
    }
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [inviteToken, setInviteToken] = useState<string | null>(getInviteToken);
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined = still loading
  const [view, setView] = useState<View>(() => loadActiveExercise()?.view ?? 'home');
  const [activeExerciseIndex, setActiveExerciseIndex] = useState(() => loadActiveExercise()?.index ?? 0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) void syncPushSubscription();
  }, [session]);

  const { data: unread } = useQuery<{ unread: number }>({
    queryKey: ['me-messages-unread'],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-messages?count=1', { method: 'GET' });
      if (error) throw error;
      return data;
    },
    refetchInterval: 20_000,
  });

  useEffect(() => {
    try {
      if (view === 'exercise') {
        localStorage.setItem(ACTIVE_EXERCISE_KEY, JSON.stringify({ view, index: activeExerciseIndex }));
      } else {
        localStorage.removeItem(ACTIVE_EXERCISE_KEY);
      }
    } catch {
      // storage unavailable — position just won't be restored
    }
  }, [view, activeExerciseIndex]);

  if (inviteToken) {
    return (
      <Suspense fallback={<ViewFallback />}>
        <InviteAccept
          token={inviteToken}
          onDone={() => {
            window.history.replaceState({}, '', '/m/');
            setInviteToken(null);
          }}
        />
      </Suspense>
    );
  }

  if (session === undefined) {
    return <FullPageLoader tone="light" background="var(--patient-bg)" label={t('loading.generic')} />;
  }

  if (!session) {
    return <Login />;
  }

  if (isPrintRoute()) {
    return (
      <Suspense fallback={<ViewFallback />}>
        <HomeProgramPrint onBack={() => window.location.assign('/m/')} />
      </Suspense>
    );
  }

  const activeTab: PatientTab = view === 'exercise' || view === 'completion' ? 'home' : (view === 'notifications' ? 'home' : (view as PatientTab));

  function handleTabChange(tab: PatientTab) {
    setView(tab);
  }

  return (
    <div style={{ direction: 'rtl' }}>
      <AppShell activeTab={activeTab} onTabChange={handleTabChange} messagesUnread={unread?.unread} onBellClick={() => setView('notifications')}>
        <Suspense fallback={<ViewFallback />}>
          {view === 'home' && (
            <Home
              onStartExercise={(index) => {
                setActiveExerciseIndex(index);
                setView('exercise');
              }}
              onOpenProgress={() => setView('progress')}
              onOpenEducation={() => setView('education')}
            />
          )}
          {view === 'exercise' && (
            <ExerciseFlow
              key={activeExerciseIndex}
              index={activeExerciseIndex}
              onAdvance={(nextIndex) => setActiveExerciseIndex(nextIndex)}
              onComplete={() => setView('completion')}
              onCancel={() => setView('home')}
            />
          )}
          {view === 'completion' && <CompletionScreen onDone={() => setView('home')} />}
          {view === 'progress' && <Progress onBack={() => setView('home')} />}
          {view === 'messages' && <Messages onBack={() => setView('home')} />}
          {view === 'education' && <Education onBack={() => setView('home')} />}
          {view === 'notifications' && <NotificationsView onBack={() => setView('home')} />}
        </Suspense>
      </AppShell>
    </div>
  );
}

function NotificationsView({ onBack }: { onBack: () => void }) {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [status, setStatus] = useState<EnablePushResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleEnable() {
    setBusy(true);
    const result = await enablePush();
    setStatus(result);
    if (typeof Notification !== 'undefined') setPermission(Notification.permission);
    setBusy(false);
  }

  const messages: Record<EnablePushResult, string> = {
    ok: t('push.result.ok'),
    denied: t('push.result.denied'),
    unsupported: t('push.result.unsupported'),
    'no-key': t('push.result.no_key'),
    error: t('push.result.error'),
  };

  const [privacyBusy, setPrivacyBusy] = useState<'' | 'export' | 'delete'>('');
  const [privacyMsg, setPrivacyMsg] = useState<string | null>(null);

  async function handleExport() {
    setPrivacyBusy('export');
    setPrivacyMsg(null);
    const { data, error } = await supabase.functions.invoke('me-export', { method: 'GET' });
    setPrivacyBusy('');
    if (error || (data as { error?: string })?.error) {
      setPrivacyMsg(t('error.action.retry'));
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovr-my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeleteRequest() {
    if (!window.confirm(`${t('confirm.delete_account.title')}\n${t('confirm.delete_account.body')}`)) return;
    setPrivacyBusy('delete');
    setPrivacyMsg(null);
    const { data, error } = await supabase.functions.invoke('me-delete-request', { method: 'POST', body: {} });
    setPrivacyBusy('');
    setPrivacyMsg(
      error || (data as { error?: string })?.error
        ? t('error.action.retry')
        : t('privacy.delete_request.sent'),
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right' }}>
        → חזרה · Back
      </button>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
        {t('clinician.alerts.title')}
      </div>
      <p style={{ fontSize: 13, color: 'var(--patient-muted)', lineHeight: 1.6, margin: 0 }}>
        {t('push.hint')}
      </p>
      {permission === 'granted' ? (
        <div style={{ fontSize: 13, color: 'var(--patient-success)' }}>✓ {t('push.on')}</div>
      ) : (
        <button
          onClick={handleEnable}
          disabled={busy || permission === 'unsupported'}
          style={{ background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', border: 'none', borderRadius: 999, padding: 13, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busy || permission === 'unsupported' ? 0.6 : 1 }}
        >
          {t('push.enable')}
        </button>
      )}
      {status && status !== 'ok' && (
        <div style={{ fontSize: 12, color: 'var(--patient-danger)' }}>{messages[status]}</div>
      )}

      <div style={{ borderTop: '1px solid var(--patient-border)', paddingTop: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--patient-text)' }}>
          {t('privacy.title')}
        </div>
        <button
          onClick={handleExport}
          disabled={privacyBusy !== ''}
          style={{ background: 'transparent', border: '1px solid var(--patient-border)', borderRadius: 12, padding: '11px 14px', color: 'var(--patient-text)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'right', opacity: privacyBusy ? 0.6 : 1 }}
        >
          {privacyBusy === 'export' ? t('privacy.export.busy') : t('privacy.export')}
        </button>
        <button
          onClick={handleDeleteRequest}
          disabled={privacyBusy !== ''}
          style={{ background: 'transparent', border: '1px solid var(--patient-danger)', borderRadius: 12, padding: '11px 14px', color: 'var(--patient-danger)', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'right', opacity: privacyBusy ? 0.6 : 1 }}
        >
          {privacyBusy === 'delete' ? t('privacy.delete_request.busy') : t('privacy.delete_request')}
        </button>
        {privacyMsg && <div style={{ fontSize: 12, color: 'var(--patient-muted)' }}>{privacyMsg}</div>}
      </div>
    </div>
  );
}

function CompletionScreen({ onDone }: { onDone: () => void }) {
  return (
    <div style={{ padding: '80px 0 0', textAlign: 'center' }}>
      <div
        style={{
          width: 80,
          height: 80,
          margin: '0 auto 24px',
          borderRadius: '50%',
          background: 'var(--patient-success)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <path d="M10 20l7 7 13-15" stroke="var(--cream)" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </div>
      <h1
        style={{
          margin: '0 0 8px',
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--patient-text)',
          fontFamily: 'var(--font-display)',
        }}
      >
        סיימת להיום
      </h1>
      <p style={{ margin: '0 0 32px', fontSize: 15, color: 'var(--patient-muted)' }}>
        נתראה באימון הבא
      </p>
      <button
        onClick={onDone}
        style={{
          background: 'var(--patient-gold)',
          color: 'var(--patient-gold-ink)',
          border: 'none',
          borderRadius: 999,
          padding: '14px 32px',
          fontSize: 15,
          fontWeight: 700,
          fontFamily: 'var(--font-ui)',
          cursor: 'pointer',
        }}
      >
        חזרה לדף הבית
      </button>
    </div>
  );
}
