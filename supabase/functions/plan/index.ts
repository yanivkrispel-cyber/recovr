// Edge Function: patient plan (T-07).
//   GET   /patients/:id/plan?version=N   -> app.get_plan (N omitted = current)
//   POST  /patients/:id/plan/versions    -> app.save_plan_version, atomic
//   PATCH /patients/:id/plan             -> app.rename_patient_pathology

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface SaveInput {
  base_version: number;
  phase_n: number;
  exercises: unknown[];
  removal_reasons?: Record<string, string>;
  note?: string;
  criteria?: unknown[];
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

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  if (req.method === 'GET') {
    // .../patients/:id/plan — id is second-to-last segment.
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }
    const versionParam = url.searchParams.get('version');

    const { data: result, error } = await service.schema('app').rpc('get_plan', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_version: versionParam ? Number(versionParam) : null,
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

    // RULES §7: a clinician read of a patient record is audited.
    await service.schema('app').rpc('audit_read', {
      p_actor_type: 'clinician',
      p_actor_id: user.id,
      p_entity_type: 'plan',
      p_entity_id: patientId,
    });

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    // .../patients/:id/plan/versions — id is 3rd-from-last segment.
    const patientId = parts[parts.length - 3];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body: SaveInput = await req.json();
    if (
      typeof body.base_version !== 'number' ||
      typeof body.phase_n !== 'number' ||
      !Array.isArray(body.exercises)
    ) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('save_plan_version', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_base_version: body.base_version,
      p_phase_n: body.phase_n,
      p_exercises: body.exercises,
      p_removal_reasons: body.removal_reasons ?? {},
      p_note: body.note ?? null,
      p_criteria: body.criteria ?? null,
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
    if (result?.error === 'plan_version_conflict') {
      return new Response(
        JSON.stringify({ error: 'plan_version_conflict', current_version: result.current_version }),
        { status: 409 },
      );
    }
    if (result?.error === 'validation_failed') {
      return new Response(JSON.stringify({ error: 'validation_failed', message: result.message }), { status: 422 });
    }

    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'PATCH') {
    // .../patients/:id/plan — id is second-to-last segment.
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    const body = await req.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('rename_patient_pathology', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_name: body.name,
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
    if (result?.error === 'not_custom') {
      return new Response(JSON.stringify({ error: 'not_custom' }), { status: 422 });
    }
    if (result?.error === 'validation_failed') {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405 });
}));
