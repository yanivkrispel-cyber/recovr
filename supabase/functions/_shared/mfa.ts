// MFA enforcement for clinician-facing edge functions.
//
// Policy: admins must use a second factor (TOTP); clinicians may opt in,
// and once a clinician has a verified factor it is enforced for them too.
// "Enforced" means the request's JWT must carry aal2 — a password-only
// session (aal1) is refused even though it's otherwise valid.
//
// Call right after getAuthUser() (auth.ts) succeeded:
//
//   const mfa = await requireMfa(req, user);
//   if (mfa) return mfa;
//
// Patients never match (no app."user" row, no factors), so shared
// endpoints (device-tokens) can call it unconditionally.
//
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import type { AuthUser } from './auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

export interface MfaState {
  /** The user has at least one verified second factor. */
  enrolled: boolean;
  /** The user's role requires a factor (admin). */
  roleRequiresMfa: boolean;
  /** The presented session is aal2. */
  aal2: boolean;
}

/**
 * Role + enrollment for the policy. `app.mfa_state` (0052) reads app."user"
 * and auth.mfa_factors in one query. Tokens verified by the Auth server
 * (legacy HS256, see auth.ts) already carry the factor list; if the RPC fails
 * we fall back to asking the Auth server rather than guessing.
 */
export async function mfaState(req: Request, user: AuthUser): Promise<MfaState> {
  const aal2 = user.aal === 'aal2';
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await svc.schema('app').rpc('mfa_state', { p_user_id: user.id });
  if (!error && data) {
    return { enrolled: data.enrolled === true, roleRequiresMfa: data.role === 'admin', aal2 };
  }

  let factors = user.factors;
  if (!factors) {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    factors = (await client.auth.getUser()).data.user?.factors ?? [];
  }
  const { data: row } = await svc.schema('app').from('user').select('role').eq('id', user.id).maybeSingle();
  return {
    enrolled: factors.some((f: any) => f.status === 'verified'),
    roleRequiresMfa: row?.role === 'admin',
    aal2,
  };
}

function refuse(error: 'mfa_required' | 'mfa_enrollment_required'): Response {
  return new Response(JSON.stringify({ error }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Returns a 403 Response when the request doesn't meet the MFA policy,
 * otherwise null. `allowUnenrolled` lets an admin who hasn't set up a
 * factor yet through (only clinician-me uses it, so the app can load the
 * profile and walk them through enrollment).
 */
export async function requireMfa(
  req: Request,
  user: AuthUser,
  opts: { allowUnenrolled?: boolean } = {},
): Promise<Response | null> {
  // An aal2 session has a verified factor by definition, which satisfies the
  // policy for every role — no lookup needed.
  if (user.aal === 'aal2') return null;
  return mfaPolicyRefusal(await mfaState(req, user), opts);
}

/** The policy itself, for callers that already have the state. */
export function mfaPolicyRefusal(state: MfaState, opts: { allowUnenrolled?: boolean } = {}): Response | null {
  if (state.enrolled) return state.aal2 ? null : refuse('mfa_required');
  if (state.roleRequiresMfa && !opts.allowUnenrolled) return refuse('mfa_enrollment_required');
  return null;
}
