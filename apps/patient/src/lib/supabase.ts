// The patient app only uses Auth and Edge Functions, so it builds those two
// clients directly instead of pulling in @supabase/supabase-js, which also
// bundles PostgREST, Realtime and Storage clients this app never calls.
//
// Wired the same way createClient() does it (supabase-js SupabaseClient), so
// sessions already stored by the old client carry over:
//   - auth storage key `sb-<project ref>-auth-token`, same default options
//   - function calls send the session's access token as the bearer, falling
//     back to the anon key when signed out (never a new-format sb_ key)
import { AuthClient } from '@supabase/auth-js';
import { FunctionsClient } from '@supabase/functions-js';

const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY;

const base = new URL(SUPABASE_URL.endsWith('/') ? SUPABASE_URL : `${SUPABASE_URL}/`);

const auth = new AuthClient({
  url: new URL('auth/v1', base).href,
  headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
  storageKey: `sb-${base.hostname.split('.')[0]}-auth-token`,
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: true,
  flowType: 'implicit',
});

const keyAsBearer = !/^sb_/.test(SUPABASE_KEY);

async function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('apikey')) headers.set('apikey', SUPABASE_KEY);
  if (!headers.has('Authorization')) {
    const { data } = await auth.getSession();
    const bearer = data.session?.access_token ?? (keyAsBearer ? SUPABASE_KEY : null);
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  }
  return fetch(input, { ...init, headers });
}

export const supabase = {
  auth,
  functions: new FunctionsClient(new URL('functions/v1', base).href, { customFetch: fetchWithAuth }),
};
