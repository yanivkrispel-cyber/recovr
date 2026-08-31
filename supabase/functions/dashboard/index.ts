// Edge Function: GET /dashboard
// KPI cards for the clinician dashboard. See app.dashboard_kpis in the
// migration for how active_patients/avg_adherence/attention_count/
// ready_count are actually computed.

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

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: kpis, error } = await service.schema('app').rpc('dashboard_kpis', {
    p_clinician_id: user.id,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (kpis?.error === 'forbidden') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  return new Response(JSON.stringify(kpis), {
    headers: { 'Content-Type': 'application/json' },
  });
});
