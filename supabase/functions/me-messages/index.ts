// Edge Function: patient message thread with the clinician.
//   GET  /me-messages            -> thread (marks clinician messages read)
//   GET  /me-messages?count=1    -> { unread } only, does not mark read
//   POST /me-messages  { body }  -> send a message

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
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (url.searchParams.get('count')) {
      const { data, error } = await svc.schema('app').rpc('messages_unread_patient', {
        p_patient_auth_id: user.id,
      });
      if (error) {
        return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
      }
      return new Response(JSON.stringify({ unread: data ?? 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await svc.schema('app').rpc('thread_for_patient', {
      p_patient_auth_id: user.id,
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error) {
      return new Response(JSON.stringify(data), { status: data.error === 'unauthorized' ? 401 : 400 });
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    let body: { body?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
    }
    const { data, error } = await svc.schema('app').rpc('send_message_patient', {
      p_patient_auth_id: user.id,
      p_body: body.body ?? '',
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'validation_failed') {
      return new Response(JSON.stringify(data), { status: 422 });
    }
    if (data?.error) {
      return new Response(JSON.stringify(data), { status: 401 });
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
