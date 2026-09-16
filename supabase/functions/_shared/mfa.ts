// MFA enforcement for clinician-facing edge functions.
//
// Policy: admins must use a second factor (TOTP); clinicians may opt in,
// and once a clinician has a verified factor it is enforced for them too.
// "Enforced" means the request's JWT must carry aal2 — a password-only
// session (aal1) is refused even though it's otherwise valid.
//
// Call right after auth.getUser() succeeded:
//
//   const mfa = await requireMfa(req, user);
//   if (mfa) return mfa;
//
// Patients never match (no app."user" row, no factors), so shared
// endpoints (device-tokens) can call it unconditionally.
//
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export interface MfaState {
  /** The user has at least one verified second factor. */
  enrolled: boolean;
  /** The user's role requires a factor (admin). */
  roleRequiresMfa: boolean;
  /** The presented session is aal2. */
  aal2: boolean;
}

/**
 * Assurance level from the bearer token. The token has already been
 * validated by auth.getUser() before this is called, so reading the claim
 * without re-verifying the signature is safe.
 */
function sessionAal(req: Request): string | null {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    return JSON.parse(json).aal ?? null;
  } catch {
    return null;
  }
}

export async function mfaState(req: Request, user: any): Promise<MfaState> {
  const enrolled = (user?.factors ?? []).some((f: any) => f.status === 'verified');
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data } = await svc.schema('app').from('user').select('role').eq('id', user.id).maybeSingle();
  return { enrolled, roleRequiresMfa: data?.role === 'admin', aal2: sessionAal(req) === 'aal2' };
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
  user: any,
  opts: { allowUnenrolled?: boolean } = {},
): Promise<Response | null> {
  return mfaPolicyRefusal(await mfaState(req, user), opts);
}

/** The policy itself, for callers that already have the state. */
export function mfaPolicyRefusal(state: MfaState, opts: { allowUnenrolled?: boolean } = {}): Response | null {
  if (state.enrolled) return state.aal2 ? null : refuse('mfa_required');
  if (state.roleRequiresMfa && !opts.allowUnenrolled) return refuse('mfa_enrollment_required');
  return null;
}
