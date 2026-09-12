// Edge Function: POST /me/sessions/:id/items
// Batch, idempotent session item writes (offline queue flush).
// Server dedupes on session_item.id (client-generated UUIDv7).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface ItemInput {
  id: string;
  plan_exercise_id: string;
  sets_done?: number;
  reps_done?: number;
  load_used?: number;
  pain_score?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  skipped: boolean;
  skip_reason?: string;
  note?: string;
  logged_at: string;
}

Deno.serve(withCors(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  // Path is .../me/sessions/:id/items — id is second-to-last, not last.
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const sessionId = parts[parts.length - 2]!;
  const body: { items: ItemInput[] } = await req.json();

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve clinic + scope to clinic schema
  const { data: schema } = await service.schema('app').rpc('resolve_clinic_for_session', {
    p_session_id: sessionId,
  });
  if (!schema) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Upsert, recompute session status + adherence, and audit-log — all in
  // one atomic call. It also verifies the session actually belongs to the
  // calling patient (the original code never checked this).
  const { data: result, error: writeErr } = await service
    .schema('app')
    .rpc('write_session_items', {
      p_schema: schema,
      p_session_id: sessionId,
      p_items: body.items,
      p_actor_patient_auth_id: user.id,
    });

  if (writeErr) {
    return new Response(JSON.stringify({ error: 'validation_failed', details: writeErr }), { status: 422 });
  }
  // Per CLAUDE.md hard rule #4: an id belonging to someone else is 404,
  // never 403 — don't let the response distinguish "not yours" from
  // "doesn't exist".
  if (
    result?.error === 'forbidden' ||
    result?.error === 'not_found' ||
    result?.error === 'unauthorized'
  ) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const items = result.items ?? [];
  return new Response(
    JSON.stringify({ items, deduped: body.items.length !== items.length }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}));
