import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { t } from 'shared';
import AppShell, { type PatientTab } from './components/AppShell';
import Home from './pages/Home';
import ExerciseFlow from './pages/ExerciseFlow';
import Progress from './pages/Progress';
import Education from './pages/Education';
import Login from './pages/Login';
import InviteAccept from './pages/InviteAccept';
import HomeProgramPrint from './pages/HomeProgramPrint';
import { enablePush, syncPushSubscription, type EnablePushResult } from './lib/push';

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
      <InviteAccept
        token={inviteToken}
        onDone={() => {
          window.history.replaceState({}, '', '/m/');
          setInviteToken(null);
        }}
      />
    );
  }

  if (session === undefined) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--patient-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--patient-muted)', fontFamily: 'var(--font-ui)', direction: 'rtl' }}>
        {t('loading.generic')}
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  if (isPrintRoute()) {
    return <HomeProgramPrint onBack={() => window.location.assign('/m/')} />;
  }

  const activeTab: PatientTab = view === 'exercise' || view === 'completion' ? 'home' : (view === 'notifications' ? 'home' : (view as PatientTab));

  function handleTabChange(tab: PatientTab) {
    setView(tab);
  }

  return (
    <div style={{ direction: 'rtl' }}>
      <AppShell activeTab={activeTab} onTabChange={handleTabChange} onBellClick={() => setView('notifications')}>
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
        {view === 'messages' && <PlaceholderView title="הודעות" titleEn="Messages" onBack={() => setView('home')} />}
        {view === 'education' && <Education onBack={() => setView('home')} />}
        {view === 'notifications' && <NotificationsView onBack={() => setView('home')} />}
      </AppShell>
    </div>
  );
}

function PlaceholderView({ title, titleEn, onBack }: { title: string; titleEn: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right' }}>
        → חזרה · Back
      </button>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
          {title} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>{titleEn}</span>
        </div>
      </div>
      <div style={{ padding: '60px 10px', textAlign: 'center', color: 'var(--patient-muted)', fontSize: 13 }}>
        בקרוב <span style={{ opacity: 0.8 }}>· Coming soon</span>
      </div>
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
    ok: 'התראות הופעלו · Notifications on',
    denied: 'ההרשאה נדחתה — יש לאשר בהגדרות הדפדפן',
    unsupported: 'הדפדפן אינו תומך בהתראות',
    'no-key': 'התראות אינן מוגדרות בשרת',
    error: 'שגיאה בהפעלת התראות — נסה שוב',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--patient-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right' }}>
        → חזרה · Back
      </button>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, color: 'var(--patient-text)' }}>
        התראות <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--patient-muted)' }}>Notifications</span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--patient-muted)', lineHeight: 1.6, margin: 0 }}>
        קבל/י תזכורת יומית לאימון ועדכון כשהמטפל משנה את התוכנית. שעות שקט 21:30–07:30.
      </p>
      {permission === 'granted' ? (
        <div style={{ fontSize: 13, color: 'var(--patient-success)' }}>✓ התראות מופעלות בדפדפן זה</div>
      ) : (
        <button
          onClick={handleEnable}
          disabled={busy || permission === 'unsupported'}
          style={{ background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', border: 'none', borderRadius: 999, padding: 13, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busy || permission === 'unsupported' ? 0.6 : 1 }}
        >
          הפעל התראות · Enable notifications
        </button>
      )}
      {status && status !== 'ok' && (
        <div style={{ fontSize: 12, color: 'var(--patient-danger)' }}>{messages[status]}</div>
      )}
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
