-- ============================================================================
-- T-07 — clinician "Add patient" flow (SCREENS.md #13, API_CONTRACT POST
-- /patients: "create + assign protocol + optional exercise exclusions →
-- sends invite").
--
-- Two functions:
--   app.protocol_options(clinician)          — data for the wizard dropdowns
--   app.create_patient_with_plan(...)        — the atomic create
--
-- The plan/phase instantiation mirrors the forward-transition branch of
-- app.write_phase_transition (0001) so a plan created here is identical to
-- one whose first phase was reached by approval.
-- ============================================================================

-- Protocols available to this clinician's clinic (own + system), each with
-- its phases and the phase's protocol exercises — everything the 3-step
-- wizard needs without a second round-trip.
CREATE OR REPLACE FUNCTION app.protocol_options(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id UUID;
  v_result    JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(p ORDER BY p->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', pr.id,
      'slug', pr.slug,
      'name', pr.name,
      'name_en', pr.name_en,
      'region', pr.region,
      'phases', (
        SELECT COALESCE(jsonb_agg(ph ORDER BY (ph->>'n')::int), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'n', pp.n,
            'name', pp.name,
            'name_en', pp.name_en,
            'duration_days', pp.duration_days,
            'exercises', (
              SELECT COALESCE(jsonb_agg(ex ORDER BY (ex->>'order')::int), '[]'::jsonb)
              FROM (
                SELECT jsonb_build_object(
                  'exercise_id', ppe.exercise_id,
                  'name', e.name,
                  'name_en', e.name_en,
                  'order', ppe."order",
                  'prescription', ppe.prescription
                ) AS ex
                FROM app.protocol_phase_exercise ppe
                JOIN app.exercise e ON e.id = ppe.exercise_id
                WHERE ppe.protocol_phase_id = pp.id
              ) exq
            )
          ) AS ph
          FROM app.protocol_phase pp
          WHERE pp.protocol_id = pr.id
        ) phq
      )
    ) AS p
    FROM app.protocol pr
    WHERE pr.is_active
      AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL)
  ) pq;

  RETURN v_result;
END;
$fn$;

-- Create a patient, assign a protocol, instantiate the chosen starting phase
-- (minus any excluded exercises), and issue an invite token. All-or-nothing.
CREATE OR REPLACE FUNCTION app.create_patient_with_plan(
  p_clinician_id          UUID,
  p_name                  TEXT,
  p_email                 TEXT,
  p_protocol_id           UUID,
  p_start_phase_n         INT DEFAULT 1,
  p_excluded_exercise_ids UUID[] DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id  UUID;
  v_schema     TEXT;
  v_patient_id UUID;
  v_plan_id    UUID;
  v_version_id UUID;
  v_phase_id   UUID;
  v_pp         RECORD;
  v_token      TEXT;
  v_excluded   UUID[] := COALESCE(p_excluded_exercise_ids, '{}'::uuid[]);
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema
  FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Protocol must belong to this clinic (or be a system protocol).
  IF NOT EXISTS (
    SELECT 1 FROM app.protocol
    WHERE id = p_protocol_id AND is_active
      AND (clinic_id = v_clinic_id OR clinic_id IS NULL)
  ) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_pp
  FROM app.protocol_phase
  WHERE protocol_id = p_protocol_id AND n = COALESCE(p_start_phase_n, 1);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'phase_not_found');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  INSERT INTO patient (clinic_id, primary_clinician_id, name, email, status)
  VALUES (v_clinic_id, p_clinician_id, btrim(p_name), btrim(p_email), 'invited')
  RETURNING id INTO v_patient_id;

  INSERT INTO plan (patient_id, protocol_id, started_at, current_phase_n, status)
  VALUES (v_patient_id, p_protocol_id, now(), v_pp.n, 'active')
  RETURNING id INTO v_plan_id;

  INSERT INTO plan_version (plan_id, version, created_by, is_current, note)
  VALUES (v_plan_id, 1, p_clinician_id, true, 'Initial plan')
  RETURNING id INTO v_version_id;

  INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at)
  VALUES (v_version_id, v_pp.n, v_pp.name, v_pp.duration_days, now())
  RETURNING id INTO v_phase_id;

  INSERT INTO plan_exercise (
    plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec, side, "order", source
  )
  SELECT
    v_phase_id, ppe.exercise_id,
    (ppe.prescription->>'sets')::int, (ppe.prescription->>'reps')::int,
    (ppe.prescription->>'load')::numeric, ppe.prescription->>'load_unit',
    ppe.prescription->>'tempo', (ppe.prescription->>'hold_sec')::int, (ppe.prescription->>'rest_sec')::int,
    ppe.prescription->>'side', ppe."order", 'protocol'
  FROM app.protocol_phase_exercise ppe
  WHERE ppe.protocol_phase_id = v_pp.id
    AND ppe.exercise_id <> ALL (v_excluded);

  INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order")
  SELECT v_phase_id, ppc.type, ppc.label, ppc.label_en, ppc.operator, ppc.value, ppc.unit, ppc."order"
  FROM app.protocol_phase_criterion ppc
  WHERE ppc.protocol_phase_id = v_pp.id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO app.patient_auth (patient_id, invite_token, invite_expires_at, password_hash, status)
  VALUES (v_patient_id, v_token, now() + INTERVAL '7 days', '', 'invited');

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'invite', 'patient', v_patient_id);

  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'plan_id', v_plan_id,
    'invite_token', v_token,
    'exercises', (SELECT count(*) FROM plan_exercise WHERE plan_phase_id = v_phase_id)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app.protocol_options(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_patient_with_plan(UUID, TEXT, TEXT, UUID, INT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.protocol_options(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.create_patient_with_plan(UUID, TEXT, TEXT, UUID, INT, UUID[]) TO authenticated, service_role;
