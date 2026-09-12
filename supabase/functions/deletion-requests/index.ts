// Edge Function: clinician side of the delete-my-data flow (RULES §7).
//   GET  /deletion-requests            -> pending requests for the clinic
//   POST /deletion-requests { patient_id } -> erase (pseudonymise) that patient
//
// The erasure also removes the patient's Supabase auth user so the login is
// fully gone, not just unlinked.

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

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    const { data, error } = await svc.schema('app').rpc('list_deletion_requests', { p_clinician_id: user.id });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error) return new Response(JSON.stringify(data), { status: 403 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    let body: { patient_id?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
    }
    if (!body.patient_id) {
      return new Response(JSON.stringify({ error: 'bad_request', details: 'patient_id required' }), { status: 400 });
    }

    // The auth-user id for a patient is the id of their app.patient_auth row.
    const { data: pa } = await svc
      .schema('app')
      .from('patient_auth')
      .select('id')
      .eq('patient_id', body.patient_id)
      .maybeSingle();

    const { data, error } = await svc.schema('app').rpc('anonymize_patient', {
      p_clinician_id: user.id,
      p_patient_id: body.patient_id,
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'forbidden') return new Response(JSON.stringify(data), { status: 403 });
    if (data?.error === 'not_found') return new Response(JSON.stringify(data), { status: 404 });

    // best-effort: drop the auth user too (anonymize_patient already removed the
    // patient_auth link, so a stale auth user would otherwise linger)
    if (pa?.id) {
      try {
        await svc.auth.admin.deleteUser(pa.id);
      } catch {
        /* non-fatal */
      }
    }

    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
