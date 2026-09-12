-- T-27 — protocol library management (clinician CRUD for injury protocols).
--
-- Previously `app.protocol` / `protocol_phase` / `protocol_phase_exercise` /
-- `protocol_phase_criterion` were seed-only and reachable solely through the
-- read-only `protocol_options` RPC (add-patient wizard). This adds full
-- clinic-scoped CRUD: list/detail for a management screen, create, replace-
-- all update, archive/restore (soft delete, hard rule #6), and duplicate
-- (including for cloning a system protocol into an editable clinic copy).
--
-- Design notes:
--  * A patient's plan is a *snapshot* of a protocol at assignment time
--    (see app.create_patient_with_plan / create_patient_with_custom_plan) —
--    plan_phase/plan_exercise/plan_criterion are independent rows. So editing
--    or archiving a protocol template never touches an already-assigned
--    patient; it only changes what's offered for *future* assignments.
--    That means no protocol-level versioning/history is needed here (unlike
--    plan_version, which exists because plan edits are a clinical audit
--    trail for one patient) — an update simply replaces the phase/exercise/
--    criterion rows via delete+reinsert (ON DELETE CASCADE from
--    protocol_phase).
--  * System protocols (clinic_id IS NULL, source='system') are read-only;
--    a clinic can only edit/archive its own (source='clinic'). Attempting to
--    edit a system protocol returns 'forbidden' (it's a permission rule, not
--    tenant isolation — existence isn't secret). A protocol id belonging to
--    a *different* clinic returns 'not_found' (rule 4: 404, never 403).
--  * All of a phase's exercises/criteria are validated before any row is
--    written (matches app.create_patient_with_plan's validate-then-mutate
--    style), so a bad payload never leaves a half-written protocol behind.

-- Full nested detail for the management screen's editor (includes criteria,
-- which protocol_options omits since the add-patient wizard doesn't need
-- them).
CREATE OR REPLACE FUNCTION app.protocol_detail(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'region', pr.region, 'region_en', pr.region_en, 'source', pr.source,
    'version', pr.version, 'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'phases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'n', pp.n, 'name', pp.name, 'name_en', pp.name_en,
        'duration_days', pp.duration_days, 'goals', pp.goals,
        'exercises', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'exercise_id', ppe.exercise_id, 'name', e.name, 'name_en', e.name_en,
            'prescription', ppe.prescription, 'frequency', ppe.frequency,
            'order', ppe."order", 'notes', ppe.notes
          ) ORDER BY ppe."order")
          FROM app.protocol_phase_exercise ppe
          JOIN app.exercise e ON e.id = ppe.exercise_id
          WHERE ppe.protocol_phase_id = pp.id
        ), '[]'::jsonb),
        'criteria', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'type', c.type, 'label', c.label, 'label_en', c.label_en,
            'operator', c.operator, 'value', c.value, 'unit', c.unit, 'order', c."order"
          ) ORDER BY c."order")
          FROM app.protocol_phase_criterion c
          WHERE c.protocol_phase_id = pp.id
        ), '[]'::jsonb)
      ) ORDER BY pp.n)
      FROM app.protocol_phase pp WHERE pp.protocol_id = pr.id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM app.protocol pr
  WHERE pr.id = p_protocol_id AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL);

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Flat list (own clinic + system, active and archived) for the management
-- screen's index — unlike protocol_options this includes archived rows and
-- editability, but not the full nested phase content.
CREATE OR REPLACE FUNCTION app.protocol_library(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'region', pr.region, 'source', pr.source, 'version', pr.version,
    'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'phase_count', (SELECT count(*) FROM app.protocol_phase pp WHERE pp.protocol_id = pr.id),
    'updated_at', pr.updated_at
  ) ORDER BY pr.is_active DESC, pr.name), '[]'::jsonb)
  INTO v_result
  FROM app.protocol pr
  WHERE pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Pure validation pass over a create/update payload — no writes. Returns a
-- jsonb error object, or NULL if the whole payload is well-formed.
CREATE OR REPLACE FUNCTION app._protocol_validate_phases(p_clinic_id UUID, p_phases JSONB)
RETURNS JSONB AS $$
DECLARE
  v_phase JSONB;
  v_ex JSONB;
  v_crit JSONB;
BEGIN
  IF p_phases IS NULL OR jsonb_typeof(p_phases) != 'array' OR jsonb_array_length(p_phases) = 0 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'phases_required');
  END IF;

  FOR v_phase IN SELECT * FROM jsonb_array_elements(p_phases) LOOP
    IF NULLIF(btrim(v_phase->>'name'), '') IS NULL THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'phase_name_required');
    END IF;

    IF v_phase->'exercises' IS NOT NULL THEN
      FOR v_ex IN SELECT * FROM jsonb_array_elements(v_phase->'exercises') LOOP
        IF NOT EXISTS (
          SELECT 1 FROM app.exercise
          WHERE id = NULLIF(v_ex->>'exercise_id', '')::uuid
            AND is_active AND (clinic_id IS NULL OR clinic_id = p_clinic_id)
        ) THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'unknown_exercise');
        END IF;
      END LOOP;
    END IF;

    IF v_phase->'criteria' IS NOT NULL THEN
      FOR v_crit IN SELECT * FROM jsonb_array_elements(v_phase->'criteria') LOOP
        IF v_crit->>'type' NOT IN ('time', 'pain', 'rom', 'strength', 'assessment', 'manual') THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_criterion_type');
        END IF;
        IF v_crit->>'operator' NOT IN ('gte', 'lte', 'eq') THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_criterion_operator');
        END IF;
        IF NULLIF(btrim(v_crit->>'label'), '') IS NULL OR v_crit->>'value' IS NULL THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'criterion_incomplete');
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Writes phases/exercises/criteria for an already-validated payload. Caller
-- must have validated with _protocol_validate_phases first and must own
-- p_protocol_id.
CREATE OR REPLACE FUNCTION app._protocol_insert_phases(p_protocol_id UUID, p_phases JSONB)
RETURNS VOID AS $$
DECLARE
  v_phase JSONB;
  v_phase_n INT := 0;
  v_phase_id UUID;
  v_ex JSONB;
  v_crit JSONB;
BEGIN
  FOR v_phase IN SELECT * FROM jsonb_array_elements(p_phases) LOOP
    v_phase_n := v_phase_n + 1;

    INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, goals, "order")
    VALUES (
      p_protocol_id, v_phase_n, btrim(v_phase->>'name'), NULLIF(btrim(v_phase->>'name_en'), ''),
      NULLIF(v_phase->>'duration_days', '')::int, COALESCE(v_phase->'goals', '[]'::jsonb), v_phase_n
    )
    RETURNING id INTO v_phase_id;

    IF v_phase->'exercises' IS NOT NULL THEN
      FOR v_ex IN SELECT * FROM jsonb_array_elements(v_phase->'exercises') LOOP
        INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, frequency, "order", notes)
        VALUES (
          v_phase_id, (v_ex->>'exercise_id')::uuid, COALESCE(v_ex->'prescription', '{}'::jsonb),
          NULLIF(btrim(v_ex->>'frequency'), ''), COALESCE((v_ex->>'order')::int, 0),
          NULLIF(btrim(v_ex->>'notes'), '')
        );
      END LOOP;
    END IF;

    IF v_phase->'criteria' IS NOT NULL THEN
      FOR v_crit IN SELECT * FROM jsonb_array_elements(v_phase->'criteria') LOOP
        INSERT INTO app.protocol_phase_criterion (protocol_phase_id, type, label, label_en, operator, value, unit, "order")
        VALUES (
          v_phase_id, v_crit->>'type', btrim(v_crit->>'label'), NULLIF(btrim(v_crit->>'label_en'), ''),
          v_crit->>'operator', (v_crit->>'value')::numeric, NULLIF(btrim(v_crit->>'unit'), ''),
          COALESCE((v_crit->>'order')::int, 0)
        );
      END LOOP;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- POST /protocols — create a new clinic-owned protocol.
CREATE OR REPLACE FUNCTION app.protocol_create(
  p_clinician_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_region TEXT,
  p_region_en TEXT,
  p_phases JSONB
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_base_slug TEXT;
  v_slug TEXT;
  v_suffix INT := 1;
  v_protocol_id UUID;
  v_phase_error JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required');
  END IF;

  v_phase_error := app._protocol_validate_phases(v_clinic_id, p_phases);
  IF v_phase_error IS NOT NULL THEN
    RETURN v_phase_error;
  END IF;

  v_base_slug := lower(regexp_replace(COALESCE(NULLIF(btrim(p_name_en), ''), p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := btrim(v_base_slug, '-');
  IF v_base_slug IS NULL OR v_base_slug = '' THEN
    v_base_slug := 'protocol';
  END IF;
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM app.protocol WHERE clinic_id = v_clinic_id AND slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, region, region_en, source, version, is_active)
  VALUES (v_clinic_id, v_slug, btrim(p_name), NULLIF(btrim(p_name_en), ''), NULLIF(btrim(p_region), ''), NULLIF(btrim(p_region_en), ''), 'clinic', '1.0', true)
  RETURNING id INTO v_protocol_id;

  PERFORM app._protocol_insert_phases(v_protocol_id, p_phases);

  RETURN jsonb_build_object('ok', true, 'id', v_protocol_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- PATCH /protocols/:id — replace-all update of a clinic-owned protocol.
CREATE OR REPLACE FUNCTION app.protocol_update(
  p_clinician_id UUID,
  p_protocol_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_region TEXT,
  p_region_en TEXT,
  p_phases JSONB
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_source TEXT;
  v_owner_clinic_id UUID;
  v_old_version TEXT;
  v_new_version TEXT;
  v_phase_error JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT source, clinic_id, version INTO v_source, v_owner_clinic_id, v_old_version
  FROM app.protocol WHERE id = p_protocol_id;

  IF v_source IS NULL OR (v_owner_clinic_id IS NOT NULL AND v_owner_clinic_id != v_clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_source != 'clinic' OR v_owner_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required');
  END IF;

  v_phase_error := app._protocol_validate_phases(v_clinic_id, p_phases);
  IF v_phase_error IS NOT NULL THEN
    RETURN v_phase_error;
  END IF;

  BEGIN
    v_new_version := (COALESCE(v_old_version, '1.0')::numeric + 0.1)::text;
  EXCEPTION WHEN OTHERS THEN
    v_new_version := '1.1';
  END;

  UPDATE app.protocol
  SET name = btrim(p_name), name_en = NULLIF(btrim(p_name_en), ''),
      region = NULLIF(btrim(p_region), ''), region_en = NULLIF(btrim(p_region_en), ''),
      version = v_new_version, updated_at = now()
  WHERE id = p_protocol_id;

  DELETE FROM app.protocol_phase WHERE protocol_id = p_protocol_id;
  PERFORM app._protocol_insert_phases(p_protocol_id, p_phases);

  RETURN jsonb_build_object('ok', true, 'id', p_protocol_id, 'version', v_new_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DELETE /protocols/:id (archive) and POST /protocols/:id/restore both call
-- this with p_is_active false/true. Soft delete only (hard rule #6) — hiding
-- from future assignment, never touching already-assigned patient plans
-- (see snapshot note above).
CREATE OR REPLACE FUNCTION app.protocol_set_active(p_clinician_id UUID, p_protocol_id UUID, p_is_active BOOLEAN)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_source TEXT;
  v_owner_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT source, clinic_id INTO v_source, v_owner_clinic_id FROM app.protocol WHERE id = p_protocol_id;
  IF v_source IS NULL OR (v_owner_clinic_id IS NOT NULL AND v_owner_clinic_id != v_clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_source != 'clinic' OR v_owner_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  UPDATE app.protocol SET is_active = p_is_active, updated_at = now() WHERE id = p_protocol_id;

  RETURN jsonb_build_object('ok', true, 'id', p_protocol_id, 'is_active', p_is_active);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- POST /protocols/:id/duplicate — clone any protocol visible to the clinic
-- (system or its own) into a new clinic-owned, independently editable copy.
CREATE OR REPLACE FUNCTION app.protocol_duplicate(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_src RECORD;
  v_base_slug TEXT;
  v_slug TEXT;
  v_suffix INT := 1;
  v_new_id UUID;
  v_src_phase RECORD;
  v_new_phase_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_src FROM app.protocol
  WHERE id = p_protocol_id AND is_active AND (clinic_id = v_clinic_id OR clinic_id IS NULL);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_base_slug := v_src.slug || '-copy';
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM app.protocol WHERE clinic_id = v_clinic_id AND slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, region, region_en, source, version, is_active)
  VALUES (v_clinic_id, v_slug, v_src.name || ' (עותק)', v_src.name_en, v_src.region, v_src.region_en, 'clinic', '1.0', true)
  RETURNING id INTO v_new_id;

  FOR v_src_phase IN SELECT * FROM app.protocol_phase WHERE protocol_id = v_src.id ORDER BY n LOOP
    INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, goals, "order")
    VALUES (v_new_id, v_src_phase.n, v_src_phase.name, v_src_phase.name_en, v_src_phase.duration_days, v_src_phase.goals, v_src_phase."order")
    RETURNING id INTO v_new_phase_id;

    INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, frequency, "order", notes)
    SELECT v_new_phase_id, exercise_id, prescription, frequency, "order", notes
    FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_src_phase.id;

    INSERT INTO app.protocol_phase_criterion (protocol_phase_id, type, label, label_en, operator, value, unit, "order")
    SELECT v_new_phase_id, type, label, label_en, operator, value, unit, "order"
    FROM app.protocol_phase_criterion WHERE protocol_phase_id = v_src_phase.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.protocol_detail(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protocol_library(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app._protocol_validate_phases(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app._protocol_insert_phases(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protocol_create(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protocol_set_active(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protocol_duplicate(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.protocol_detail(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.protocol_library(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.protocol_create(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.protocol_set_active(UUID, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.protocol_duplicate(UUID, UUID) TO authenticated, service_role;
