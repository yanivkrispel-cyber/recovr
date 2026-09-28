-- ============================================================================
-- Clinic admins may edit system protocols (protocol-update stage 3).
--
-- Product decision 2026-09-28: any clinic admin (role = 'admin') can edit a
-- system protocol (clinic_id IS NULL) in the full editor. The change is seen
-- by every clinic. Patients already on the protocol are unaffected: since
-- 0057 a plan holds all of its phases and records the protocol_version it
-- was built from, so a template edit only changes what future assignments
-- get (and, in stage 4, what is offered for per-patient review).
--
-- Unchanged: archiving/restoring a system protocol stays forbidden, clinicians
-- still get read-only + Duplicate, and the "quick attach" path
-- (attach_exercise_to_protocol_phase) still copies for non-curators.
--
-- Rules for a system-protocol save:
--   * every exercise must be a system exercise (clinic_id IS NULL) and
--     approved — a clinic-private exercise would leak into other clinics'
--     protocols (and they couldn't open it).
--   * the new protocol_version records who made it (created_by), and the
--     edit is written to app.audit_log.
--
-- protocol_detail / protocol_library gain 'can_edit' (may save content).
-- 'is_editable' keeps its meaning — the clinic's own protocol — because it
-- also gates archive and the clinic-protocol filter in UsagePanel.
-- ============================================================================

-- Returns an error object if any exercise in the payload can't go into a
-- system protocol, else NULL. Run after _protocol_validate_phases.
CREATE OR REPLACE FUNCTION app._protocol_validate_system_exercises(p_phases JSONB)
RETURNS JSONB AS $$
DECLARE
  v_bad JSONB;
BEGIN
  SELECT jsonb_agg(DISTINCT e.name) INTO v_bad
  FROM jsonb_array_elements(p_phases) ph
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ph->'exercises', '[]'::jsonb)) x
  JOIN app.exercise e ON e.id = (x->>'exercise_id')::uuid
  WHERE e.clinic_id IS NOT NULL OR e.status <> 'approved';

  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'private_exercise', 'exercises', v_bad);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION app._protocol_validate_system_exercises(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._protocol_validate_system_exercises(JSONB) TO service_role;

-- Re-declared from 0030: adds can_edit.
CREATE OR REPLACE FUNCTION app.protocol_detail(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_admin BOOLEAN;
  v_result JSONB;
BEGIN
  SELECT clinic_id, role = 'admin' INTO v_clinic_id, v_is_admin
  FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'body_region', CASE WHEN br.id IS NOT NULL
      THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
      ELSE NULL END,
    'region_detail', pr.region_detail, 'region_detail_en', pr.region_detail_en,
    'source', pr.source,
    'version', pr.version, 'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'can_edit', ((pr.source = 'clinic' AND pr.clinic_id = v_clinic_id) OR (pr.clinic_id IS NULL AND v_is_admin)),
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
  LEFT JOIN app.body_region br ON br.id = pr.body_region_id
  WHERE pr.id = p_protocol_id AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL);

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Re-declared from 0030: adds can_edit.
CREATE OR REPLACE FUNCTION app.protocol_library(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_admin BOOLEAN;
  v_result JSONB;
BEGIN
  SELECT clinic_id, role = 'admin' INTO v_clinic_id, v_is_admin
  FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'body_region', CASE WHEN br.id IS NOT NULL
      THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
      ELSE NULL END,
    'source', pr.source, 'version', pr.version,
    'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'can_edit', ((pr.source = 'clinic' AND pr.clinic_id = v_clinic_id) OR (pr.clinic_id IS NULL AND v_is_admin)),
    'phase_count', (SELECT count(*) FROM app.protocol_phase pp WHERE pp.protocol_id = pr.id),
    'updated_at', pr.updated_at
  ) ORDER BY pr.is_active DESC, pr.name), '[]'::jsonb)
  INTO v_result
  FROM app.protocol pr
  LEFT JOIN app.body_region br ON br.id = pr.body_region_id
  WHERE pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Re-declared from 0030: admins may update system protocols; the new
-- protocol_version records its author; system edits are audited.
CREATE OR REPLACE FUNCTION app.protocol_update(
  p_clinician_id UUID,
  p_protocol_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_body_region_id UUID,
  p_region_detail TEXT,
  p_region_detail_en TEXT,
  p_phases JSONB
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_admin BOOLEAN;
  v_source TEXT;
  v_owner_clinic_id UUID;
  v_old_version TEXT;
  v_new_version TEXT;
  v_phase_error JSONB;
  v_is_system BOOLEAN;
  v_version_id UUID;
BEGIN
  SELECT clinic_id, role = 'admin' INTO v_clinic_id, v_is_admin
  FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT source, clinic_id, version INTO v_source, v_owner_clinic_id, v_old_version
  FROM app.protocol WHERE id = p_protocol_id
  FOR UPDATE;

  IF v_source IS NULL OR (v_owner_clinic_id IS NOT NULL AND v_owner_clinic_id != v_clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  v_is_system := v_owner_clinic_id IS NULL;
  IF v_is_system AND NOT v_is_admin THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT v_is_system AND v_source != 'clinic' THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required');
  END IF;

  IF p_body_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = p_body_region_id) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  v_phase_error := app._protocol_validate_phases(v_clinic_id, p_phases);
  IF v_phase_error IS NULL AND v_is_system THEN
    v_phase_error := app._protocol_validate_system_exercises(p_phases);
  END IF;
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
      body_region_id = p_body_region_id,
      region_detail = NULLIF(btrim(p_region_detail), ''), region_detail_en = NULLIF(btrim(p_region_detail_en), ''),
      version = v_new_version, updated_at = now()
  WHERE id = p_protocol_id;

  DELETE FROM app.protocol_phase WHERE protocol_id = p_protocol_id;
  PERFORM app._protocol_insert_phases(p_protocol_id, p_phases);

  -- _protocol_insert_phases took the snapshot; stamp its author if this save
  -- created it (an unchanged-content save returns the existing one).
  v_version_id := app.protocol_snapshot(p_protocol_id);
  UPDATE app.protocol_version SET created_by = p_clinician_id
  WHERE id = v_version_id AND created_by IS NULL;

  IF v_is_system THEN
    INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
    VALUES ('admin', p_clinician_id, 'system_protocol_update', 'protocol', p_protocol_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'id', p_protocol_id,
    'version', (SELECT version FROM app.protocol WHERE id = p_protocol_id),
    'protocol_version_id', v_version_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.protocol_detail(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.protocol_detail(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION app.protocol_library(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.protocol_library(UUID) TO service_role;
REVOKE ALL ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
