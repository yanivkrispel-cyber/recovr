import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { t } from 'shared';
import type { User } from 'shared';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

const supabase = createClient(
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
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        // Load user metadata
        supabase
          .from('app.user')
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
            .from('app.user')
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
        {user ? <Dashboard user={user} /> : <Login />}
      </AuthContext.Provider>
    </SupabaseContext.Provider>
  );
}
