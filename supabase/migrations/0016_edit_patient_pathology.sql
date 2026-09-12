-- ============================================================================
-- Edit a patient's pathology (the free-text condition typed on the "אחר · Other"
-- path of the Add-patient wizard, migration 0015).
--
-- The "Other" path builds a hidden, clinic-owned single-phase protocol
-- (is_template = false) named after the condition and points the plan at it.
-- That name is what the patient card shows as the pathology. A clinician who
-- mistyped it had no way to fix it — this adds one.
--
-- Only per-patient custom protocols (is_template = false AND clinic_id set) are
-- renameable here. Library protocols are shared across patients, so renaming one
-- from a single patient's card is rejected (not_custom).
--
--   app.get_plan(...)                  — now also returns `pathology`
--   app.rename_patient_pathology(...)  — the rename, PATCH /patients/:id/plan
-- ============================================================================

-- Re-declared from 0001 with a `pathology` object added to the payload so the
-- Edit-plan drawer can show the current name and whether it is editable.
CREATE OR REPLACE FUNCTION app.get_plan(p_clinician_id UUID, p_patient_id UUID, p_version INT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'plan_id', pl.id, 'version', pv.version, 'is_current', pv.is_current,
    'created_at', pv.created_at, 'note', pv.note, 'current_phase_n', pl.current_phase_n,
    'pathology', jsonb_build_object(
      'protocol_id', pr.id,
      'name', pr.name,
      'is_custom', (pr.is_template = false AND pr.clinic_id IS NOT NULL)
    ),
    'phases', COALESCE(phase_agg.items, '[]'::jsonb),
    -- Every phase the protocol defines, for the timeline — plan_phase only
    -- has rows for phases actually reached so far.
    'protocol_phases', COALESCE(protocol_phase_agg.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id
    AND ((p_version IS NULL AND pv.is_current = true) OR pv.version = p_version)
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', pp.id, 'n', pp.n, 'name', pp.name, 'duration_days', pp.duration_days,
      'started_at', pp.started_at, 'completed_at', pp.completed_at,
      'exercises', COALESCE(ex_agg.items, '[]'::jsonb),
      'criteria', COALESCE(crit_agg.items, '[]'::jsonb)
    ) ORDER BY pp.n) AS items
    FROM plan_phase pp
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', pe.id, 'exercise_id', pe.exercise_id, 'name', ex.name, 'name_en', ex.name_en,
        'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit, 'tempo', pe.tempo,
        'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
        'frequency_days_per_week', pe.frequency_days_per_week, 'schedule', pe.schedule,
        'order', pe."order", 'clinician_note', pe.clinician_note, 'source', pe.source,
        'removed_reason', pe.removed_reason, 'deleted_at', pe.deleted_at
      ) ORDER BY pe."order") AS items
      FROM plan_exercise pe JOIN app.exercise ex ON ex.id = pe.exercise_id
      WHERE pe.plan_phase_id = pp.id
    ) ex_agg ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', pc.id, 'type', pc.type, 'label', pc.label, 'label_en', pc.label_en,
        'operator', pc.operator, 'value', pc.value, 'unit', pc.unit,
        'is_met', pc.is_met, 'met_at', pc.met_at
      ) ORDER BY pc."order") AS items
      FROM plan_criterion pc
      WHERE pc.plan_phase_id = pp.id
    ) crit_agg ON true
    WHERE pp.plan_version_id = pv.id
  ) phase_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'n', prpp.n, 'name', prpp.name, 'duration_days', prpp.duration_days, 'goals', prpp.goals
    ) ORDER BY prpp.n) AS items
    FROM app.protocol_phase prpp WHERE prpp.protocol_id = pl.protocol_id
  ) protocol_phase_agg ON true
  WHERE pl.patient_id = p_patient_id;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Rename the pathology (protocol name) of a patient's custom "Other"-path
-- protocol. Rejects library protocols (not_custom) — those are shared.
CREATE OR REPLACE FUNCTION app.rename_patient_pathology(
  p_clinician_id UUID,
  p_patient_id   UUID,
  p_name         TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id   UUID;
  v_schema      TEXT;
  v_name        TEXT := btrim(COALESCE(p_name, ''));
  v_protocol_id UUID;
  v_rows        INT;
BEGIN
  IF v_name = '' OR char_length(v_name) > 120 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema
  FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT protocol_id INTO v_protocol_id
  FROM plan
  WHERE patient_id = p_patient_id;
  IF v_protocol_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  UPDATE app.protocol
  SET name = v_name
  WHERE id = v_protocol_id
    AND is_template = false
    AND clinic_id = v_clinic_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('error', 'not_custom');
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'update', 'protocol', v_protocol_id);

  RETURN jsonb_build_object('protocol_id', v_protocol_id, 'name', v_name);
END;
$fn$;

REVOKE ALL ON FUNCTION app.rename_patient_pathology(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rename_patient_pathology(UUID, UUID, TEXT) TO authenticated, service_role;
