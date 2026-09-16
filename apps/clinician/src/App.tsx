import React, { useState } from 'react';
import { createClient, FunctionsHttpError, type Session } from '@supabase/supabase-js';
import { RouterProvider } from '@tanstack/react-router';
import { FullPageLoader } from 'ui';
import { t } from 'shared';
import type { User } from 'shared';
import Login from './pages/Login';
import { MfaChallenge, MfaEnroll } from './components/Mfa';
import { router } from './router';
import { syncPushSubscription } from './lib/push';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

/** The signed-in clinician, as returned by the clinician-me edge function. */
export interface Profile extends User {
  mfa: { enrolled: boolean; required: boolean; enrollment_required: boolean };
}

export const SupabaseContext = React.createContext(supabase);
export const AuthContext = React.createContext<{
  user: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** Re-reads the profile (e.g. after an MFA change in Settings). */
  refreshUser: () => Promise<void>;
}>({ user: null, loading: true, signOut: async () => {}, refreshUser: async () => {} });

// What the app shows for the current session. The MFA gates come before the
// app itself: the server refuses clinician requests without aal2 when the
// policy requires it (supabase/functions/_shared/mfa.ts).
type Gate = 'loading' | 'signed-out' | 'mfa-challenge' | 'mfa-enroll' | 'ready';

async function errorCode(error: unknown): Promise<string | null> {
  if (!(error instanceof FunctionsHttpError)) return null;
  const body = await (error.context as Response).json().catch(() => null);
  return typeof body?.error === 'string' ? body.error : null;
}

export default function App() {
  const [user, setUser] = useState<Profile | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const resolveSeq = React.useRef(0);

  const resolveSession = React.useCallback(async (session: Session | null) => {
    const seq = ++resolveSeq.current;
    const current = () => seq === resolveSeq.current;

    if (!session?.user) {
      setUser(null);
      setGate('signed-out');
      return;
    }

    // A second factor exists but this session hasn't passed it yet.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!current()) return;
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      setGate('mfa-challenge');
      return;
    }

    // Profile comes from an edge function: the browser has no direct
    // access to the app schema.
    const { data, error } = await supabase.functions.invoke<Profile>('clinician-me', { method: 'GET' });
    if (!current()) return;
    if (error || !data) {
      const code = await errorCode(error);
      if (!current()) return;
      setUser(null);
      setGate(code === 'mfa_required' ? 'mfa-challenge' : 'signed-out');
      return;
    }
    setUser(data);
    setGate(data.mfa?.enrollment_required ? 'mfa-enroll' : 'ready');
  }, []);

  React.useEffect(() => {
    // Dev-only convenience: skip the login form by signing in with a seeded
    // account automatically, before the auth-state listener below picks up
    // whatever session results. `import.meta.env.DEV` is a Vite build-time
    // constant — this whole branch is dead-code-eliminated from production
    // bundles, so it can never ship live.
    const devAutoLogin = import.meta.env.DEV && import.meta.env.VITE_DEV_AUTO_LOGIN === '1';
    const autoSignIn = () => {
      supabase.auth.signInWithPassword({
        email: import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL ?? 'clinician@demo.recoveryos.app',
        password: import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD ?? 'demo12345678',
      }).then(({ error }) => {
        if (error) console.warn('VITE_DEV_AUTO_LOGIN sign-in failed:', error.message);
      });
    };
    if (devAutoLogin) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session?.user) autoSignIn();
      });
    }

    // onAuthStateChange fires immediately with the current session on
    // subscribe (INITIAL_SESSION), in addition to future sign-in/out events
    // (including MFA_CHALLENGE_VERIFIED) — so this alone drives both the
    // first load and later changes.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // Calling auth methods inside this callback can deadlock
        // supabase-js, so all follow-up work is deferred.
        setTimeout(() => {
          // A stored session can outlive its server-side record (e.g. a local
          // `supabase db reset` wipes auth sessions): the token still parses,
          // so the shell would render while every API call returns 401. Check
          // the restored session with the auth server once and drop it if dead,
          // which lands on Login.
          if (event === 'INITIAL_SESSION' && session) {
            supabase.auth.getUser().then(({ error }) => {
              if (error && (error.status === 401 || error.status === 403)) {
                void supabase.auth.signOut({ scope: 'local' }).then(() => {
                  if (devAutoLogin) autoSignIn();
                });
              }
            });
          }
          // Token refreshes don't change who's signed in or their AAL.
          if (event !== 'TOKEN_REFRESHED') void resolveSession(session);
        }, 0);
      },
    );
    return () => subscription.unsubscribe();
  }, [resolveSession]);

  React.useEffect(() => {
    if (gate === 'ready' && user) void syncPushSubscription();
  }, [gate, user]);

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
    setGate('signed-out');
  }

  async function refreshUser() {
    const { data: { session } } = await supabase.auth.getSession();
    await resolveSession(session);
  }

  if (gate === 'loading') {
    return <FullPageLoader background="var(--sand)" label={t('loading.generic')} />;
  }

  return (
    <SupabaseContext.Provider value={supabase}>
      <AuthContext.Provider value={{ user, loading: false, signOut, refreshUser }}>
        {gate === 'ready' && user ? (
          <RouterProvider router={router} />
        ) : gate === 'mfa-challenge' ? (
          <MfaChallenge onSignOut={() => void signOut()} />
        ) : gate === 'mfa-enroll' ? (
          <MfaEnroll required onSignOut={() => void signOut()} />
        ) : (
          <Login />
        )}
      </AuthContext.Provider>
    </SupabaseContext.Provider>
  );
}
