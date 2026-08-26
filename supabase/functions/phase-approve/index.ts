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
    .from('app.user')
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

  // Resolve clinic + scope
  const { data: clinic } = await service.rpc('resolve_clinic_for_patient', {
    p_patient_id: patientId,
  });
  if (!clinic || clinic !== roleRow.clinic_id) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  await service.rpc('set_config', {
    setting: 'search_path',
    value: clinic,
    is_local: true,
  });

  // Load plan + current criteria snapshot
  const { data: plan } = await service
    .from('plan')
    .select('id, current_phase_n')
    .eq('patient_id', patientId)
    .single();

  if (!plan) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  const { data: criteria } = await service
    .from('plan_criterion')
    .select('id, type, operator, value, is_met, met_at')
    .eq('plan_phase_id',
      // load phase → current plan_version
      (
        await service
          .from('plan_version')
          .select('id, plan_phase!inner(id)')
          .eq('plan_id', plan.id)
          .eq('is_current', true)
          .single()
      ).data?.plan_phase[0]?.id ?? '00000000-0000-0000-0000-000000000000'
    );

  const unmet = (criteria ?? []).filter((c) => !c.is_met);
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

  // Write immutable transition
  const { data: transition, error: txErr } = await service
    .from('phase_transition')
    .insert({
      plan_id: plan.id,
      from_phase_n: plan.current_phase_n,
      to_phase_n: body.to_phase_n,
      direction: body.direction,
      approved_by: user.id,
      criteria_snapshot: criteria,
      override_reason: body.override_reason,
    })
    .select()
    .single();

  if (txErr) {
    return new Response(JSON.stringify({ error: 'validation_failed', details: txErr }), { status: 422 });
  }

  // Update plan.current_phase_n
  await service
    .from('plan')
    .update({ current_phase_n: body.to_phase_n })
    .eq('id', plan.id);

  // Audit log
  await service.from('app.audit_log').insert({
    actor_type: 'clinician',
    actor_id: user.id,
    action: 'phase_transition',
    entity_type: 'plan',
    entity_id: plan.id,
  });

  return new Response(JSON.stringify({ transition }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
