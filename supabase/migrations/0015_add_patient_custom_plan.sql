-- ============================================================================
-- Custom ("Other") injury path for the clinician "Add patient" wizard.
--
-- When the clinician picks injury = "Other" there is no protocol to assign:
-- they type a free-text condition and hand-pick exercises. Rather than make
-- app.plan.protocol_id nullable (the phase / criteria / adherence engine all
-- join through a protocol), "Other" builds a hidden, clinic-owned single-phase
-- protocol from the picked exercises and then runs the normal
-- app.create_patient_with_plan (0014) against it — so the resulting plan is
-- byte-for-byte a normal one.
--
-- is_template separates real library protocols (offered in the wizard's injury
-- dropdown) from these per-patient ad-hoc ones (hidden everywhere the picker
-- lists protocols).
-- ============================================================================

ALTER TABLE app.protocol
  ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT true;

-- Re-declared from 0014 with the `is_template` filter: only library protocols
-- belong in the "Add patient" injury dropdown.
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
      AND pr.is_template
      AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL)
  ) pq;

  RETURN v_result;
END;
$fn$;

-- Create a patient on the "Other" path: build a hidden single-phase protocol
-- named after the free-text condition, seed it with the picked exercises at a
-- default 3x10 / 60s prescription, then delegate to create_patient_with_plan.
CREATE OR REPLACE FUNCTION app.create_patient_with_custom_plan(
  p_clinician_id  UUID,
  p_name          TEXT,
  p_email         TEXT,
  p_condition     TEXT,
  p_exercise_ids  UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id   UUID;
  v_protocol_id UUID;
  v_phase_id    UUID;
  v_ids         UUID[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_exercise_ids, '{}'::uuid[])));
  v_valid_count INT;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = ''
     OR p_email IS NULL OR btrim(p_email) = ''
     OR p_condition IS NULL OR btrim(p_condition) = ''
     OR cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT clinic_id INTO v_clinic_id FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Every picked exercise must be active and visible to this clinic.
  SELECT count(*) INTO v_valid_count
  FROM app.exercise
  WHERE id = ANY (v_ids)
    AND is_active
    AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
  IF v_valid_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, source, is_active, is_template)
  VALUES (
    v_clinic_id,
    'custom-' || replace(gen_random_uuid()::text, '-', ''),
    btrim(p_condition),
    NULL, 'clinic', true, false
  )
  RETURNING id INTO v_protocol_id;

  INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, "order")
  VALUES (v_protocol_id, 1, 'התאמה אישית', 'Custom', NULL, 1)
  RETURNING id INTO v_phase_id;

  INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, "order")
  SELECT v_phase_id, x.exercise_id,
         jsonb_build_object('sets', 3, 'reps', 10, 'rest_sec', 60),
         x.ord
  FROM unnest(v_ids) WITH ORDINALITY AS x(exercise_id, ord);

  RETURN app.create_patient_with_plan(
    p_clinician_id, p_name, p_email, v_protocol_id, 1, '{}'::uuid[]
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app.create_patient_with_custom_plan(UUID, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_patient_with_custom_plan(UUID, TEXT, TEXT, TEXT, UUID[]) TO authenticated, service_role;
