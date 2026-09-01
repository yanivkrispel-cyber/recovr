// Edge Function: clinician side of the patient message thread.
//   GET  /messages?patient_id=X   -> thread (marks patient messages read)
//   GET  /messages?unread=1       -> { total, by_patient } unread map
//   POST /messages  { patient_id, body }  -> send a message

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
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
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('unread')) {
      const { data, error } = await svc.schema('app').rpc('messages_unread_clinician', {
        p_clinician_id: user.id,
      });
      if (error) {
        return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
      }
      if (data?.error) return new Response(JSON.stringify(data), { status: 403 });
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    }

    const patientId = url.searchParams.get('patient_id');
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'bad_request', details: 'patient_id required' }), { status: 400 });
    }
    const { data, error } = await svc.schema('app').rpc('thread_for_clinician', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'forbidden') return new Response(JSON.stringify(data), { status: 403 });
    if (data?.error === 'not_found') return new Response(JSON.stringify(data), { status: 404 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    let body: { patient_id?: string; body?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
    }
    if (!body.patient_id) {
      return new Response(JSON.stringify({ error: 'bad_request', details: 'patient_id required' }), { status: 400 });
    }
    const { data, error } = await svc.schema('app').rpc('send_message_clinician', {
      p_clinician_id: user.id,
      p_patient_id: body.patient_id,
      p_body: body.body ?? '',
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'validation_failed') return new Response(JSON.stringify(data), { status: 422 });
    if (data?.error === 'forbidden') return new Response(JSON.stringify(data), { status: 403 });
    if (data?.error === 'not_found') return new Response(JSON.stringify(data), { status: 404 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
});
