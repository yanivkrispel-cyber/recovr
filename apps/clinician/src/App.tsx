import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { RouterProvider } from '@tanstack/react-router';
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
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user && import.meta.env.DEV && import.meta.env.VITE_DEV_AUTO_LOGIN === '1') {
        // Dev-only convenience: skip the login form by signing in with a
        // seeded account automatically. `import.meta.env.DEV` is a Vite
        // build-time constant — this whole branch is dead-code-eliminated
        // from production bundles, so it can never ship live.
        const { error } = await supabase.auth.signInWithPassword({
          email: import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL ?? 'clinician@demo.recoveryos.app',
          password: import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD ?? 'demo12345678',
        });
        if (error) console.warn('VITE_DEV_AUTO_LOGIN sign-in failed:', error.message);
        const { data: { session: newSession } } = await supabase.auth.getSession();
        session = newSession;
      }

      if (session?.user) {
        // Load user metadata
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
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        if (session?.user) {
          const { data } = await supabase
            .schema('app')
            .from('user')
            .select('*')
            .eq('id', session.user.id)
            .single();
          setUser(data as User);
        } else {
          setUser(null);
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
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'var(--font-ui)',
          color: 'var(--muted)',
        }}
      >
        {t('loading.generic')}
      </div>
    );
  }

  return (
    <SupabaseContext.Provider value={supabase}>
      <AuthContext.Provider value={{ user, loading, signOut }}>
        {user ? <RouterProvider router={router} /> : <Login />}
      </AuthContext.Provider>
    </SupabaseContext.Provider>
  );
}
