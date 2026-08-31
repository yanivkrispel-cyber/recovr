// Edge Function: GET /patients?filter=all|attention|ready|inactive&q=
// Patient table rows for the dashboard. Pagination (`cursor` in
// API_CONTRACT.md) isn't implemented yet — fine at "loads in <1.5s with
// 200 patients" scale (T-05's own bar); revisit if the caseload grows
// past that. POST (create + assign protocol + invite) is T-06/T-07
// territory, not built here — see patient-invite for the minimal T-03
// invite-only path.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter') ?? 'all';
  const q = url.searchParams.get('q');

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: patients, error } = await service.schema('app').rpc('list_patients', {
    p_clinician_id: user.id,
    p_filter: filter,
    p_query: q,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (patients?.error === 'forbidden') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  return new Response(JSON.stringify(patients), {
    headers: { 'Content-Type': 'application/json' },
  });
});
