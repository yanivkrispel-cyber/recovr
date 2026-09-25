// Caller authentication for edge functions.
//
//   const user = await getAuthUser(req);
//   if (!user) return 401;
//
// Asymmetric access tokens (ES256/RS256 — the project's JWT signing keys) are
// verified locally against the project's JWKS, which jose caches in the
// isolate, so a request no longer waits on a round-trip to the Auth server.
// Tokens signed with the legacy shared secret (HS256) can't be verified
// without that secret, so they still go through auth.getUser(). That keeps
// this correct before, during and after the signing-key rotation.
//
// Trade-off of local verification: a token stays accepted until it expires
// (jwt_expiry, 1 h) even after sign-out — the standard Supabase getClaims()
// behaviour. Data access is still scoped by the id in the token.
//
// deno-lint-ignore-file no-explicit-any

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jsr:@panva/jose@6';
import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

export interface AuthUser {
  id: string;
  /** Authenticator assurance level of the presented session ('aal1' | 'aal2'). */
  aal: string | null;
  /** Only set when the Auth server was asked (legacy HS256 tokens). */
  factors?: any[];
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

export async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const token = bearerToken(req);
  if (!token) return null;

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return null;
  }

  if (alg && alg !== 'HS256') {
    try {
      const { payload } = await jwtVerify(token, JWKS, { audience: 'authenticated' });
      if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') return null;
      return { id: payload.sub, aal: typeof payload.aal === 'string' ? payload.aal : null };
    } catch {
      return null;
    }
  }

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return { id: user.id, aal: unverifiedAal(token), factors: user.factors ?? [] };
}

// The token was just validated by the Auth server, so reading the claim
// without re-checking the signature is safe.
function unverifiedAal(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    return JSON.parse(json).aal ?? null;
  } catch {
    return null;
  }
}
