// Edge Function: GET /me/today
// Returns the current patient's session for today in their local timezone.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  // Verify patient
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  // Get patient + clinic
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: patient } = await service
    .from('app.patient_auth')
    .select('patient_id')
    .eq('id', user.id)
    .single();

  if (!patient) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Resolve clinic schema from patient_id
  const { data: clinic } = await service
    .rpc('resolve_clinic_for_patient', { p_patient_id: patient.patient_id });

  if (!clinic) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }

  // Set search_path to the clinic schema
  await service.rpc('set_config', {
    setting: 'search_path',
    value: clinic,
    is_local: true,
  });

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', // override from patient.timezone
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Read or create today's session
  const { data: session } = await service
    .from('session')
    .select(`
      id, date, status, items_planned, items_done, completion_ratio,
      plan_version_id,
      plan_exercise:plan_exercise!inner(
        id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec, side, order,
        exercise:exercise!inner(name, name_en)
      )
    `)
    .eq('patient_id', patient.patient_id)
    .eq('date', today)
    .maybeSingle();

  // Audit log (cross-clinic)
  await service.from('app.audit_log').insert({
    actor_type: 'patient',
    actor_id: user.id,
    action: 'read',
    entity_type: 'session',
    entity_id: session?.id ?? patient.patient_id,
  });

  return new Response(JSON.stringify({ session, today }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
