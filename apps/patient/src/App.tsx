import type { Session } from '@supabase/auth-js';
import { Suspense, useEffect, useState } from 'react';
import { t } from 'shared';
import { Skeleton, FullPageLoader, lazyWithRetry } from 'ui';
import AppShell, { type PatientTab } from './components/AppShell';
import Home from './pages/Home';
import Login from './pages/Login';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { enablePush, pushSupport, syncPushSubscription, type EnablePushResult } from './lib/push';
import PushBanner, { IosPushHelp } from './components/PushBanner';
import { supabase } from './lib/supabase';
import { onQueueFlushed, sessionQueue } from './lib/sessionQueue';
import { TODAY_KEY } from './lib/today';

// Home + Login load with the shell; the rest split into their own chunks so
// first paint doesn't carry the whole app (T-24).
const ExerciseFlow = lazyWithRetry(() => import('./pages/ExerciseFlow'));
const Progress = lazyWithRetry(() => import('./pages/Progress'));
const Education = lazyWithRetry(() => import('./pages/Education'));
const Messages = lazyWithRetry(() => import('./pages/Messages'));
const InviteAccept = lazyWithRetry(() => import('./pages/InviteAccept'));
const HomeProgramPrint = lazyWithRetry(() => import('./pages/HomeProgramPrint'));
const Book = lazyWithRetry(() => import('./pages/Book'));
const ManageBooking = lazyWithRetry(() => import('./pages/ManageBooking'));
const Appointments = lazyWithRetry(() => import('./pages/Appointments'));

function ViewFallback() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
      <Skeleton width={160} height={19} />
      <Skeleton count={4} height={48} radius={12} />
    </div>
  );
}

// Pages import the client from here; it lives in lib/supabase.ts.
export { supabase };

type View = 'home' | 'exercise' | 'completion' | 'progress' | 'messages' | 'education' | 'notifications' | 'appointments';

// /m/invite/:token and /m/program/print — the only paths this app parses;
// everything else is local view state, matching the "no router" pattern.
function getInviteToken(): string | null {
  const match = window.location.pathname.match(/\/invite\/([^/]+)/);
  return match ? match[1] : null;
}

// The public booking page and the manage link from booking e-mails (T-35)
// need no session — a visitor booking a first visit isn't a patient yet.
function getBookSlug(): string | null {
  const match = window.location.pathname.match(/\/book\/([a-z0-9-]+)\/?$/);
  return match ? match[1] : null;
}

function getManageToken(): string | null {
  const match = window.location.pathname.match(/\/booking\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

function isPrintRoute(): boolean {
  return /\/program\/print\/?$/.test(window.location.pathname);
}

// 'sequence' walks through every exercise left today (the "start today's
// plan" button); 'single' is one exercise picked from the list, after which
// the patient goes straight back home.
export type ExerciseMode = 'single' | 'sequence';

// Opening the app always lands on Home — a cold launch starts there, and so
// does coming back after the app sat in the background this long. A shorter
// switch away (a text, a call mid-exercise) returns to where the patient was.
// Home's "continue" button picks up at the first unfinished exercise, so the
// old restore-exact-position behaviour (T-11) isn't needed.
const BACKGROUND_RESET_MS = 10 * 60_000;

// Where earlier builds saved the open exercise to restore it on launch.
const LEGACY_ACTIVE_EXERCISE_KEY = 'rehab:activeView';
try {
  localStorage.removeItem(LEGACY_ACTIVE_EXERCISE_KEY);
} catch {
  // storage unavailable — nothing to clean up
}

const CACHE_OWNER_KEY = 'rehab:cacheOwner';

// The service worker's plan-json cache is keyed by URL only (/me-today etc. —
// the Authorization header isn't part of the key), so on a shared device the
// next patient to sign in would briefly be served the previous one's plan.
// Drop it, and the in-memory query cache, whenever the signed-in user changes.
// Returns true when the owner changed.
async function claimCachesFor(userId: string | null): Promise<boolean> {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(CACHE_OWNER_KEY);
    if (userId) localStorage.setItem(CACHE_OWNER_KEY, userId);
    else localStorage.removeItem(CACHE_OWNER_KEY);
  } catch {
    // storage unavailable — fall through and clear to be safe
  }
  if (owner === userId) return false;
  try {
    if ('caches' in window) await caches.delete('plan-json');
  } catch {
    // Cache Storage unavailable (e.g. some private modes) — nothing to clear
  }
  return true;
}

export default function App() {
  const [inviteToken, setInviteToken] = useState<string | null>(getInviteToken);
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined = still loading
  const [view, setView] = useState<View>('home');
  const [activeExerciseIndex, setActiveExerciseIndex] = useState(0);
  const [exerciseMode, setExerciseMode] = useState<ExerciseMode>('sequence');
  // The plan item just finished in single mode — Home flashes its row.
  const [justCompletedId, setJustCompletedId] = useState<string | null>(null);
  const [bookOnOpen, setBookOnOpen] = useState(false);
  const [bookSlug] = useState(getBookSlug);
  const [manageToken] = useState(getManageToken);

  const queryClient = useQueryClient();

  useEffect(() => {
    // Clear before setSession so Home's first fetch can't hit the old cache.
    const apply = async (s: Session | null) => {
      if (await claimCachesFor(s?.user.id ?? null)) queryClient.clear();
      setSession(s);
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => void apply(s));
    return () => subscription.unsubscribe();
  }, [queryClient]);

  useEffect(() => {
    if (session) void syncPushSubscription();
  }, [session]);

  // Logs left in the offline queue by an earlier run go out on startup; once
  // any flush lands, the server's `done` flags are current, so refetch.
  useEffect(() => {
    if (session) sessionQueue.scheduleFlush(0);
  }, [session]);

  useEffect(
    () =>
      onQueueFlushed(() => {
        void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
        void queryClient.invalidateQueries({ queryKey: ['progress'] });
      }),
    [queryClient],
  );

  const { data: unread } = useQuery<{ unread: number }>({
    queryKey: ['me-messages-unread'],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('me-messages?count=1', { method: 'GET' });
      if (error) throw error;
      return data;
    },
    // Fallback only: a new message also arrives as a push, which the service
    // worker relays below, and React Query refetches on window focus.
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'push') return;
      void queryClient.invalidateQueries({ queryKey: ['me-messages-unread'] });
      void queryClient.invalidateQueries({ queryKey: ['me-messages'] });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [queryClient]);

  // The row flash belongs to the return from that one exercise only.
  useEffect(() => {
    if (view !== 'home') setJustCompletedId(null);
  }, [view]);

  // iOS keeps an installed PWA alive in the background, so reopening it from
  // the home screen is often a resume, not a fresh launch.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null) {
        if (Date.now() - hiddenAt >= BACKGROUND_RESET_MS) setView('home');
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (bookSlug || manageToken) {
    return (
      <Suspense fallback={<ViewFallback />}>
        {bookSlug ? <Book slug={bookSlug} /> : <ManageBooking token={manageToken!} />}
      </Suspense>
    );
  }

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

  const activeTab: PatientTab = view === 'exercise' || view === 'completion' || view === 'notifications' || view === 'appointments' ? 'home' : (view as PatientTab);

  function handleTabChange(tab: PatientTab) {
    setView(tab);
  }

  return (
    <div style={{ direction: 'rtl' }}>
      <AppShell activeTab={activeTab} onTabChange={handleTabChange} messagesUnread={unread?.unread} onBellClick={() => setView('notifications')}>
        <Suspense fallback={<ViewFallback />}>
          {view === 'home' && <PushBanner onOpenSettings={() => setView('notifications')} />}
          {view === 'home' && (
            <Home
              onStartExercise={(index, mode) => {
                setActiveExerciseIndex(index);
                setExerciseMode(mode);
                setJustCompletedId(null);
                setView('exercise');
              }}
              justCompletedId={justCompletedId}
              onOpenProgress={() => setView('progress')}
              onOpenEducation={() => setView('education')}
              onOpenAppointments={(book) => {
                setBookOnOpen(book);
                setView('appointments');
              }}
            />
          )}
          {view === 'appointments' && <Appointments onBack={() => setView('home')} startBooking={bookOnOpen} />}
          {view === 'exercise' && (
            <ExerciseFlow
              key={activeExerciseIndex}
              index={activeExerciseIndex}
              mode={exerciseMode}
              onAdvance={(nextIndex) => setActiveExerciseIndex(nextIndex)}
              onComplete={() => setView('completion')}
              onSingleDone={(itemId) => {
                setJustCompletedId(itemId);
                setView('home');
              }}
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
  const support = pushSupport();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    support !== 'supported' ? 'unsupported' : Notification.permission,
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
      {support !== 'supported' && support !== 'unsupported' ? (
        <IosPushHelp support={support} />
      ) : permission === 'granted' ? (
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
      {support === 'unsupported' && (
        <div style={{ fontSize: 12, color: 'var(--patient-muted)' }}>{messages.unsupported}</div>
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
