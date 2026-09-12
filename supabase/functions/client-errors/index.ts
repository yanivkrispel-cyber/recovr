// Edge Function: client error sink (T-24). The ui ErrorBoundary POSTs here.
// verify_jwt is off — a crash can happen before login — but a JWT, when
// present, is decoded for the actor id. Payloads are capped hard; this is a
// public write path, so a real deployment should also rate-limit it at the
// edge (Kong).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const MAX_BYTES = 32 * 1024;

function log(level: string, msg: string, ctx: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, fn: 'client-errors', msg, ...ctx }));
}

Deno.serve(withCors(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return new Response(null, { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  let actor: string | null = null;
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    try {
      const u = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data } = await u.auth.getUser();
      actor = data.user?.id ?? null;
    } catch {
      /* anonymous is fine */
    }
  }

  try {
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error } = await svc.schema('app').rpc('record_client_error', { p: payload, p_actor: actor });
    if (error) {
      log('error', 'record failed', { details: error.message });
      return new Response(null, { status: 500 });
    }
  } catch (e) {
    log('error', 'sink exception', { details: String(e instanceof Error ? e.message : e) });
    return new Response(null, { status: 500 });
  }

  log('info', 'client error recorded', { app: String(payload.app ?? ''), kind: String(payload.kind ?? '') });
  return new Response(null, { status: 204 });
}));
