// Edge Function: GET /patients/:id — app.patient_overview (overview tab).
// History tab reuses the payload's recent_activity/phase_transitions — no
// separate call needed. The Assessments tab has its own dedicated
// `measurements` function (T-09b) — this no longer serves that.
//   POST /patients/:id/discharge  -> archive (non-destructive, reversible)
//   POST /patients/:id/reactivate -> undo a discharge

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'POST') {
    const action = parts[parts.length - 1];
    const patientId = parts[parts.length - 2];
    if (!patientId || (action !== 'discharge' && action !== 'reactivate')) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const rpcName = action === 'discharge' ? 'discharge_patient' : 'reactivate_patient';
    const { data: result, error } = await service.schema('app').rpc(rpcName, {
      p_clinician_id: user.id,
      p_patient_id: patientId,
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
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const patientId = parts[parts.length - 1];
  if (!patientId) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const { data: result, error } = await service.schema('app').rpc('patient_overview', {
    p_clinician_id: user.id,
    p_patient_id: patientId,
  });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (result?.error === 'forbidden') {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }
  // Per CLAUDE.md hard rule #4: cross-clinic/unknown ids are 404, not 403.
  if (result?.error === 'not_found') {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}));
