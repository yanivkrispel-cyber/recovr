// Edge Function: POST /patients/:id/phase-transitions
// Approves or regresses a phase. Always writes an immutable phase_transition
// with a criteria snapshot. Approving with unmet criteria requires a reason.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface Input {
  to_phase_n: number;
  direction: 'forward' | 'back';
  override_reason?: string;
}

interface Criterion {
  id: string;
  type: string;
  operator: string;
  value: number;
  is_met: boolean;
  met_at: string | null;
}

Deno.serve(async (req) => {
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

  // Verify role
  const { data: roleRow } = await userClient
    .schema('app')
    .from('user')
    .select('role, clinic_id')
    .eq('id', user.id)
    .single();
  if (!roleRow || !['clinician', 'admin'].includes(roleRow.role)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const url = new URL(req.url);
  const patientId = url.pathname.split('/').filter(Boolean).slice(-2, -1)[0];
  const body: Input = await req.json();

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // The clinician's own clinic, expressed as a schema name — this is what
  // the patient's resolved schema must match. (Comparing a schema name to
  // roleRow.clinic_id directly, as the original code did, compares a
  // string like "clinic_demo" to a UUID and can never match.)
  const { data: clinicRow } = await service
    .schema('app')
    .from('clinic')
    .select('slug')
    .eq('id', roleRow.clinic_id)
    .single();
  const expectedSchema = clinicRow ? `clinic_${clinicRow.slug}` : null;

  const { data: patientSchema } = await service.schema('app').rpc('resolve_clinic_for_patient', {
    p_patient_id: patientId,
  });
  if (!patientSchema || !expectedSchema || patientSchema !== expectedSchema) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Load plan + current criteria snapshot
  const { data: planData } = await service
    .schema('app')
    .rpc('get_plan_for_phase_transition', { p_schema: patientSchema, p_patient_id: patientId });

  if (!planData) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const criteria: Criterion[] = planData.criteria ?? [];
  const unmet = criteria.filter((c) => !c.is_met);
  if (unmet.length > 0 && !body.override_reason) {
    return new Response(
      JSON.stringify({
        error: 'override_reason_required',
        message: 'override_reason required when criteria are not met',
        unmet,
      }),
      { status: 409 },
    );
  }

  // Write immutable transition + advance plan.current_phase_n
  const { data: transition, error: txErr } = await service
    .schema('app')
    .rpc('write_phase_transition', {
      p_schema: patientSchema,
      p_plan_id: planData.plan_id,
      p_from_phase_n: planData.current_phase_n,
      p_to_phase_n: body.to_phase_n,
      p_direction: body.direction,
      p_approved_by: user.id,
      p_criteria_snapshot: criteria,
      p_override_reason: body.override_reason ?? null,
    });

  if (txErr) {
    return new Response(JSON.stringify({ error: 'validation_failed', details: txErr }), { status: 422 });
  }

  return new Response(JSON.stringify({ transition }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
