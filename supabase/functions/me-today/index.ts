// Edge Function: GET /me/today
// Returns the current patient's session for today in their local timezone.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  // Verify patient
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // app.patient_auth lives in the exposed `app` schema, so this is a
  // direct table read — it's the clinic-scoped session lookup below that
  // needs the RPC (clinic_<slug> schemas aren't reachable via PostgREST
  // directly; see app.patient_today in the migration).
  const { data: patientAuth } = await service
    .schema('app')
    .from('patient_auth')
    .select('patient_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!patientAuth) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', // TODO: use the patient's own timezone once available here
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Creates today's session on first read if needed and returns
  // {session_id, date, phase, items, progress} per API_CONTRACT.md.
  const { data: result, error: rpcErr } = await service
    .schema('app')
    .rpc('patient_today', { p_patient_auth_id: user.id, p_today: today });

  if (rpcErr) {
    return new Response(JSON.stringify({ error: 'internal_error', details: rpcErr.message }), { status: 500 });
  }
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Turn the bucket-relative media paths (verified media only — the RPC already
  // filtered) into short-lived signed URLs; the private exercise-media bucket
  // isn't readable with a patient JWT.
  const items = Array.isArray(result.items) ? result.items : [];
  for (const it of items) {
    const media = Array.isArray(it?.exercise?.media) ? it.exercise.media : [];
    for (const m of media) {
      for (const field of ['url', 'thumb_url'] as const) {
        const path = m[field];
        if (typeof path === 'string' && path && !path.startsWith('http') && !path.startsWith('/storage/')) {
          const { data: signed } = await service.storage.from('exercise-media').createSignedUrl(path, 3600);
          if (signed?.signedUrl) m[field] = signed.signedUrl.replace(/^https?:\/\/[^/]+/, '');
        }
      }
    }
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
});
