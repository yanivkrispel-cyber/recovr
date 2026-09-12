// Edge Function: assessment-visit grouping (T-09b).
//   POST  /patients/:id/assessment-visits   -> start a visit
//   PATCH /assessment-visits/:id/save       -> close + save it

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function errorStatus(code: string): number {
  if (code === 'forbidden') return 403;
  if (code === 'not_found') return 404;
  return 500;
}

Deno.serve(withCors(async (req) => {
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
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'POST') {
    // .../patients/:id/assessment-visits — id is second-to-last.
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const { data: result, error } = await service.schema('app').rpc('start_assessment_visit', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PATCH') {
    // .../assessment-visits/:id/save — id is second-to-last.
    const visitId = parts[parts.length - 2];
    const body: { patient_id?: string; note?: string } = await req.json();
    if (!visitId || !body.patient_id) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('save_assessment_visit', {
      p_clinician_id: user.id,
      p_patient_id: body.patient_id,
      p_visit_id: visitId,
      p_note: body.note ?? null,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}));
