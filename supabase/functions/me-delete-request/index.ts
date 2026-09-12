// Edge Function: patient delete-my-data request (RULES §7). Erasure is
// clinician-actioned because clinical records carry a retention obligation, so
// this only records the request.
//   POST /me-delete-request  { reason? }

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(withCors(async (req) => {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: { reason?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* reason is optional */
  }

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await svc.schema('app').rpc('request_data_deletion', {
    p_patient_auth_id: user.id,
    p_reason: body.reason ?? null,
  });
  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (data?.error === 'unauthorized') {
    return new Response(JSON.stringify(data), { status: 401 });
  }
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}));
