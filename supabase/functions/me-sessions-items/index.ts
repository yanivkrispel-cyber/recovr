// Edge Function: POST /me/sessions/:id/items
// Batch, idempotent session item writes (offline queue flush).
// Server dedupes on session_item.id (client-generated UUIDv7).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

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

Deno.serve(async (req) => {
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

  const url = new URL(req.url);
  const sessionId = url.pathname.split('/').filter(Boolean).pop()!;
  const body: { items: ItemInput[] } = await req.json();
  const idempotencyKey = req.headers.get('Idempotency-Key');

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Resolve clinic + scope to clinic schema
  const { data: clinic } = await service.rpc('resolve_clinic_for_session', {
    p_session_id: sessionId,
  });
  if (!clinic) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  await service.rpc('set_config', {
    setting: 'search_path',
    value: clinic,
    is_local: true,
  });

  // Check idempotency: if same items arrive twice, server returns the same result
  // with no duplicates (session_item.id is the dedupe key).
  const itemsWithSession = body.items.map((it) => ({
    id: it.id,
    session_id: sessionId,
    plan_exercise_id: it.plan_exercise_id,
    sets_done: it.sets_done,
    reps_done: it.reps_done,
    load_used: it.load_used,
    pain_score: it.pain_score,
    difficulty: it.difficulty,
    skipped: it.skipped,
    skip_reason: it.skip_reason,
    note: it.note,
    logged_at: it.logged_at,
    synced_at: new Date().toISOString(),
  }));

  // upsert with onConflict: 'id' — re-insert of an existing id is a no-op
  const { data, error: insertErr } = await service
    .from('session_item')
    .upsert(itemsWithSession, { onConflict: 'id' })
    .select();

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: 'validation_failed', details: insertErr }),
      { status: 422 },
    );
  }

  // Recompute session status
  await service.rpc('recompute_session_status', { p_session_id: sessionId });

  // Audit log
  await service.from('app.audit_log').insert({
    actor_type: 'patient',
    actor_id: user.id,
    action: 'write',
    entity_type: 'session_item',
    entity_id: sessionId,
  });

  return new Response(JSON.stringify({ items: data, deduped: body.items.length !== data?.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
