// Edge Function: GET /clinician-me -> the signed-in clinician's profile.
//
// The clinician app used to read app."user" straight through PostgREST with
// the user's JWT. Client roles have no access to the app schema any more
// (0046/0047), and that `select('*')` also shipped password_hash/mfa_secret
// to the browser — so the profile comes from here, with an explicit column
// list. Non-clinician accounts (e.g. a patient signing in to /app) get 403.
// Also reports the caller's MFA state (see _shared/mfa.ts for the policy).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { mfaPolicyRefusal, mfaState } from '../_shared/mfa.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const PROFILE_COLUMNS = 'id, clinic_id, role, name, email, phone, last_login_at, status';

Deno.serve(withCors(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  // An admin without a factor is let through here (only here), so the app
  // can load the profile and walk them through enrollment.
  const mfa = await mfaState(req, user);
  const mfaRefusal = mfaPolicyRefusal(mfa, { allowUnenrolled: true });
  if (mfaRefusal) return mfaRefusal;

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile, error } = await svc
    .schema('app')
    .from('user')
    .select(PROFILE_COLUMNS)
    .eq('id', user.id)
    .in('role', ['clinician', 'admin'])
    .maybeSingle();

  if (error) {
    console.error('[clinician-me] profile lookup failed:', error.message);
    return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 });
  }
  if (!profile) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const body = {
    ...profile,
    mfa: {
      enrolled: mfa.enrolled,
      required: mfa.roleRequiresMfa,
      enrollment_required: mfa.roleRequiresMfa && !mfa.enrolled,
    },
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}));
