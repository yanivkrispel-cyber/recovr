// Edge Function: per-clinic settings (T-20).
//   GET   /settings          -> current effective settings for the caller's clinic
//   PATCH /settings  { ... }  -> partial update; returns the new effective settings
//
// Body keys (all optional): adherence_threshold (50-95 step 5), units
// (metric|imperial), assessment_interval_days (7-180), alerts { <type>: bool },
// weekly_digest (bool, this clinician's opt-in).

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
    const { data, error } = await svc.schema('app').rpc('get_clinic_settings', { p_clinician_id: user.id });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'forbidden') return new Response(JSON.stringify(data), { status: 403 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    let patch: Record<string, unknown>;
    try {
      patch = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 });
    }
    const { data, error } = await svc.schema('app').rpc('update_clinic_settings', {
      p_clinician_id: user.id,
      p_patch: patch,
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (data?.error === 'forbidden') return new Response(JSON.stringify(data), { status: 403 });
    if (data?.error === 'validation_failed') return new Response(JSON.stringify(data), { status: 422 });
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
