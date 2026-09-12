// Edge Function: measurement module (T-09b, see ROM_MEASUREMENT.md).
//   GET    /patients/:id/measurements?joint=ankle  -> rows + definitions + history
//   POST   /patients/:id/measurements               -> record one measurement
//   PATCH  /measurements/:id                        -> edit (supersedes, never mutates)
//   DELETE /measurements/:id                        -> soft delete
// PATCH/DELETE don't carry a patient id in the path (API_CONTRACT.md), so
// the body must include patient_id.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface WriteInput {
  patient_id: string;
  measure_code: string;
  side: 'involved' | 'healthy' | 'bilateral';
  value: number;
  value_secondary?: number | null;
  pass?: boolean | null;
  compensations?: string[] | null;
  attempts?: number[] | null;
  governing_source?: string | null;
  pain?: number | null;
  end_feel?: string | null;
  swelling?: string | null;
  note?: string | null;
  visit_id?: string | null;
}

function errorStatus(code: string): number {
  if (code === 'forbidden') return 403;
  if (code === 'not_found') return 404;
  if (code === 'measure_side_invalid' || code === 'validation_failed') return 422;
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

  if (req.method === 'GET' && url.pathname.endsWith('/measure-definitions')) {
    const { data: result, error } = await service.schema('app').rpc('measure_definitions', {
      p_clinician_id: user.id,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'GET' && url.pathname.endsWith('/assessment-status')) {
    // .../patients/:id/assessment-status — id is second-to-last (T-20).
    const patientId = parts[parts.length - 2];
    if (!patientId) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }
    const { data: result, error } = await service.schema('app').rpc('assessment_status', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
    });
    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'GET') {
    // .../patients/:id/measurements — id is second-to-last.
    const patientId = parts[parts.length - 2];
    const joint = url.searchParams.get('joint');
    if (!patientId || !joint) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('get_measurements_for_joint', {
      p_clinician_id: user.id,
      p_patient_id: patientId,
      p_joint: joint,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }

    // RULES §7: a clinician read of a patient record is audited.
    await service.schema('app').rpc('audit_read', {
      p_actor_type: 'clinician',
      p_actor_id: user.id,
      p_entity_type: 'measurement',
      p_entity_id: patientId,
    });

    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body: WriteInput & Record<string, unknown> = await req.json();
    if (!body.patient_id || !body.measure_code || !body.side || typeof body.value !== 'number') {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    // .../measurements/:id for PATCH — id is the last segment.
    const supersedesId = req.method === 'PATCH' ? parts[parts.length - 1] : null;

    const { data: result, error } = await service.schema('app').rpc('write_measurement', {
      p_clinician_id: user.id,
      p_patient_id: body.patient_id,
      p_measure_code: body.measure_code,
      p_side: body.side,
      p_value: body.value,
      p_value_secondary: body.value_secondary ?? null,
      p_secondary_provided: 'value_secondary' in body,
      p_pass: body.pass ?? null,
      p_compensations: body.compensations ?? null,
      p_compensations_provided: 'compensations' in body,
      p_attempts: body.attempts ?? null,
      p_governing_source: body.governing_source ?? null,
      p_pain: body.pain ?? null,
      p_end_feel: body.end_feel ?? null,
      p_swelling: body.swelling ?? null,
      p_note: body.note ?? null,
      p_visit_id: body.visit_id ?? null,
      p_supersedes_id: supersedesId,
    });

    if (error) {
      return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
    }
    if (result?.error) {
      return new Response(JSON.stringify({ error: result.error }), { status: errorStatus(result.error) });
    }

    return new Response(JSON.stringify(result), {
      status: req.method === 'POST' ? 201 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'DELETE') {
    const measurementId = parts[parts.length - 1];
    const body: { patient_id?: string } = await req.json().catch(() => ({}));
    if (!measurementId || !body.patient_id) {
      return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
    }

    const { data: result, error } = await service.schema('app').rpc('delete_measurement', {
      p_clinician_id: user.id,
      p_patient_id: body.patient_id,
      p_measurement_id: measurementId,
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
