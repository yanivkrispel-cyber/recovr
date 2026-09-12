import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { RouterProvider } from '@tanstack/react-router';
import { FullPageLoader } from 'ui';
import { t } from 'shared';
import type { User } from 'shared';
import Login from './pages/Login';
import { router } from './router';
import { syncPushSubscription } from './lib/push';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export const SupabaseContext = React.createContext(supabase);
export const AuthContext = React.createContext<{
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}>({ user: null, loading: true, signOut: async () => {} });

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    // Dev-only convenience: skip the login form by signing in with a seeded
    // account automatically, before the auth-state listener below picks up
    // whatever session results. `import.meta.env.DEV` is a Vite build-time
    // constant — this whole branch is dead-code-eliminated from production
    // bundles, so it can never ship live.
    if (import.meta.env.DEV && import.meta.env.VITE_DEV_AUTO_LOGIN === '1') {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) return;
        supabase.auth.signInWithPassword({
          email: import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL ?? 'clinician@demo.recoveryos.app',
          password: import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD ?? 'demo12345678',
        }).then(({ error }) => {
          if (error) console.warn('VITE_DEV_AUTO_LOGIN sign-in failed:', error.message);
        });
      });
    }

    // onAuthStateChange fires immediately with the current session on
    // subscribe (INITIAL_SESSION), in addition to future sign-in/out events —
    // so this alone drives both the first load and later changes. A separate
    // getSession()-triggered fetch here would just duplicate the same
    // request on every mount.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user) {
          supabase
            .schema('app')
            .from('user')
            .select('*')
            .eq('id', session.user.id)
            .single()
            .then(({ data }) => {
              setUser(data as User);
              setLoading(false);
            });
        } else {
          setUser(null);
          setLoading(false);
        }
      },
    );
    return () => subscription.unsubscribe();
  }, []);

  React.useEffect(() => {
    if (user) void syncPushSubscription();
  }, [user]);

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
  }

  if (loading) {
    return <FullPageLoader background="var(--sand)" label={t('loading.generic')} />;
  }

  return (
    <SupabaseContext.Provider value={supabase}>
      <AuthContext.Provider value={{ user, loading, signOut }}>
        {user ? <RouterProvider router={router} /> : <Login />}
      </AuthContext.Provider>
    </SupabaseContext.Provider>
  );
}
