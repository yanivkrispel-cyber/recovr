// Edge Function: POST /patients/:id/criteria/:criterionId
// Manual is_met toggle for criteria app.recompute_criteria can't evaluate
// (rom/strength/assessment/manual — time/pain are live-computed on every
// read and would just get overwritten, so there's no point exposing this
// for those types in the UI).

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface Input {
  is_met: boolean;
}

Deno.serve(withCors(async (req) => {
  if (req.method !== 'POST') {
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

  // .../patients/:id/criteria/:criterionId — id 3rd-from-last, criterionId last.
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const patientId = parts[parts.length - 3];
  const criterionId = parts[parts.length - 1];
  if (!patientId || !criterionId) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const body: Input = await req.json();
  if (typeof body.is_met !== 'boolean') {
    return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: result, error } = await service.schema('app').rpc('set_criterion_met', {
    p_clinician_id: user.id,
    p_patient_id: patientId,
    p_criterion_id: criterionId,
    p_is_met: body.is_met,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (result?.error === 'forbidden') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  if (result?.error === 'not_found') {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}));
