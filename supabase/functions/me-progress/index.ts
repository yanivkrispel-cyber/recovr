// Edge Function: GET /me/progress?window=30
// Returns the current patient's adherence series, pain trend, phase
// timeline and milestones per API_CONTRACT.md.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(withCors(async (req) => {
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

  const { data: patientAuth } = await service
    .schema('app')
    .from('patient_auth')
    .select('patient_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!patientAuth) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const windowParam = new URL(req.url).searchParams.get('window');
  const windowDays = Math.min(365, Math.max(1, Number(windowParam) || 30));

  const { data: result, error: rpcErr } = await service
    .schema('app')
    .rpc('patient_progress', { p_patient_auth_id: user.id, p_window_days: windowDays });

  if (rpcErr) {
    return new Response(JSON.stringify({ error: 'internal_error', details: rpcErr.message }), { status: 500 });
  }
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}));
