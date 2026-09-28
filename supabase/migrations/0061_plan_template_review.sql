-- ============================================================================
-- Offering protocol template changes to patients already on it
-- (protocol-update stage 4).
--
-- Decided 2026-09-28: never automatic, reviewed per patient. A 3-way diff:
--   base   = the protocol_version the plan was built from / last reviewed
--            against (plan.base_protocol_version_id, 0057)
--   latest = the protocol's current content (app.protocol_snapshot)
--   plan   = the patient's current plan_version
-- matched by (phase n, exercise_id), over the current and future phases only
-- (completed phases are never rewritten). A change the template made where
-- the plan still matches base is offered pre-selected; where the clinician
-- already changed that item for this patient it's a conflict, and the
-- personal edit wins unless the clinician picks the template value.
--
-- Reviewing moves the plan's base to latest whether or not anything was
-- accepted, so skipped changes are not offered again; accepted ones are
-- written as ONE new plan_version through save_plan_version_phases (same
-- versioning, removal-reason and plan_updated rules as a manual edit).
--
-- Not covered: template phase renames/duration changes and phases the
-- template removed (the plan keeps its own); a phase the template added is
-- offered as a whole ('phase' change).
--
-- Also: get_plan.protocol_phases and patient_progress.phase_timeline now
-- come from the patient's own plan_phase rows (every phase exists since
-- 0057), not the live template. Goals/name_en still come from the template
-- (plan_phase has no columns for them).
-- ============================================================================

-- Prescription fields a plan row copies from a template prescription, in one
-- comparable shape. NULL input -> NULL (item absent).
CREATE OR REPLACE FUNCTION app._rx_from_prescription(p JSONB)
RETURNS JSONB AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE jsonb_build_object(
    'sets', (p->>'sets')::int, 'reps', (p->>'reps')::int,
    'load', (p->>'load')::numeric, 'load_unit', NULLIF(p->>'load_unit', ''),
    'tempo', NULLIF(p->>'tempo', ''), 'hold_sec', (p->>'hold_sec')::int,
    'rest_sec', (p->>'rest_sec')::int, 'side', NULLIF(p->>'side', '')
  ) END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION app._rx_from_plan(
  p_sets INT, p_reps INT, p_load NUMERIC, p_load_unit TEXT, p_tempo TEXT,
  p_hold_sec INT, p_rest_sec INT, p_side TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'sets', p_sets, 'reps', p_reps, 'load', p_load, 'load_unit', NULLIF(p_load_unit, ''),
    'tempo', NULLIF(p_tempo, ''), 'hold_sec', p_hold_sec, 'rest_sec', p_rest_sec, 'side', NULLIF(p_side, '')
  );
$$ LANGUAGE sql IMMUTABLE;

-- Criteria list in one comparable shape (order-insensitive to ids/met state).
CREATE OR REPLACE FUNCTION app._criteria_norm(p JSONB)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type', c->>'type', 'label', c->>'label', 'label_en', NULLIF(c->>'label_en', ''),
    'operator', c->>'operator', 'value', (c->>'value')::numeric, 'unit', NULLIF(c->>'unit', '')
  ) ORDER BY COALESCE((c->>'order')::int, 0), c->>'label'), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p, '[]'::jsonb)) c;
$$ LANGUAGE sql IMMUTABLE;

REVOKE ALL ON FUNCTION app._rx_from_prescription(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._rx_from_plan(INT, INT, NUMERIC, TEXT, TEXT, INT, INT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app._criteria_norm(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._rx_from_prescription(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION app._rx_from_plan(INT, INT, NUMERIC, TEXT, TEXT, INT, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app._criteria_norm(JSONB) TO service_role;

-- The diff itself. Caller has search_path set to the clinic schema.
-- Returns [{key, phase_n, phase_name, is_current, type, kind, exercise_id,
--           name, name_en, template_before, template_after, plan,
--           plan_exercise_id, conflict, default_accept}]
--   type 'exercise': kind add | remove | update
--   type 'criteria': kind replace (template_* / plan are criteria lists)
--   type 'phase'   : kind add (a phase the template gained; template_after = its snapshot)
CREATE OR REPLACE FUNCTION app._plan_template_changes(
  p_plan_id UUID,
  p_base JSONB,
  p_latest JSONB
) RETURNS JSONB AS $$
DECLARE
  v_version_id UUID;
  v_current_n INT;
  v_ph RECORD;
  v_bph JSONB;
  v_lph JSONB;
  v_ex_id UUID;
  v_b JSONB;
  v_l JSONB;
  v_p JSONB;
  v_p_id UUID;
  v_kind TEXT;
  v_conflict BOOLEAN;
  v_bc JSONB;
  v_lc JSONB;
  v_pc JSONB;
  v_out JSONB := '[]'::jsonb;
BEGIN
  SELECT pv.id, pl.current_phase_n INTO v_version_id, v_current_n
  FROM plan pl JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
  WHERE pl.id = p_plan_id;

  FOR v_ph IN
    SELECT id, n, name FROM plan_phase
    WHERE plan_version_id = v_version_id AND n >= v_current_n AND completed_at IS NULL
    ORDER BY n
  LOOP
    SELECT ph INTO v_lph FROM jsonb_array_elements(p_latest) ph WHERE (ph->>'n')::int = v_ph.n;
    CONTINUE WHEN v_lph IS NULL;  -- template dropped this phase: the plan keeps its own
    SELECT ph INTO v_bph FROM jsonb_array_elements(p_base) ph WHERE (ph->>'n')::int = v_ph.n;

    FOR v_ex_id IN
      SELECT DISTINCT (x->>'exercise_id')::uuid
      FROM jsonb_array_elements(COALESCE(v_bph->'exercises', '[]'::jsonb) || COALESCE(v_lph->'exercises', '[]'::jsonb)) x
    LOOP
      SELECT app._rx_from_prescription(COALESCE(x->'prescription', '{}'::jsonb)) INTO v_b
      FROM jsonb_array_elements(COALESCE(v_bph->'exercises', '[]'::jsonb)) x
      WHERE (x->>'exercise_id')::uuid = v_ex_id
      ORDER BY (x->>'order')::int LIMIT 1;
      IF NOT FOUND THEN v_b := NULL; END IF;

      SELECT app._rx_from_prescription(COALESCE(x->'prescription', '{}'::jsonb)) INTO v_l
      FROM jsonb_array_elements(v_lph->'exercises') x
      WHERE (x->>'exercise_id')::uuid = v_ex_id
      ORDER BY (x->>'order')::int LIMIT 1;
      IF NOT FOUND THEN v_l := NULL; END IF;

      CONTINUE WHEN v_b IS NOT DISTINCT FROM v_l;  -- template didn't change this item

      SELECT pe.id, app._rx_from_plan(pe.sets, pe.reps, pe.load, pe.load_unit, pe.tempo, pe.hold_sec, pe.rest_sec, pe.side)
      INTO v_p_id, v_p
      FROM plan_exercise pe
      WHERE pe.plan_phase_id = v_ph.id AND pe.exercise_id = v_ex_id AND pe.deleted_at IS NULL
      ORDER BY pe."order" LIMIT 1;
      IF NOT FOUND THEN v_p_id := NULL; v_p := NULL; END IF;

      IF v_b IS NULL THEN
        -- template added it
        IF v_p_id IS NULL THEN
          v_kind := 'add';
          -- the clinician removed it from this patient before: that decision stands by default
          v_conflict := EXISTS (
            SELECT 1 FROM plan_exercise pe
            WHERE pe.plan_phase_id = v_ph.id AND pe.exercise_id = v_ex_id AND pe.deleted_at IS NOT NULL
          );
        ELSIF v_p = v_l THEN
          CONTINUE;
        ELSE
          v_kind := 'update'; v_conflict := true;
        END IF;
      ELSIF v_l IS NULL THEN
        -- template removed it
        IF v_p_id IS NULL THEN
          CONTINUE;
        END IF;
        v_kind := 'remove'; v_conflict := v_p IS DISTINCT FROM v_b;
      ELSE
        -- template changed the prescription
        IF v_p_id IS NULL THEN
          v_kind := 'add'; v_conflict := true;  -- removed for this patient
        ELSIF v_p = v_l THEN
          CONTINUE;
        ELSE
          v_kind := 'update'; v_conflict := v_p IS DISTINCT FROM v_b;
        END IF;
      END IF;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', 'ex:' || v_ph.n || ':' || v_ex_id,
        'phase_n', v_ph.n, 'phase_name', v_ph.name, 'is_current', v_ph.n = v_current_n,
        'type', 'exercise', 'kind', v_kind,
        'exercise_id', v_ex_id,
        'name', (SELECT name FROM app.exercise WHERE id = v_ex_id),
        'name_en', (SELECT name_en FROM app.exercise WHERE id = v_ex_id),
        'template_before', v_b, 'template_after', v_l, 'plan', v_p,
        'plan_exercise_id', v_p_id,
        'conflict', v_conflict, 'default_accept', NOT v_conflict
      ));
    END LOOP;

    v_bc := app._criteria_norm(v_bph->'criteria');
    v_lc := app._criteria_norm(v_lph->'criteria');
    IF v_bc IS DISTINCT FROM v_lc THEN
      SELECT app._criteria_norm(jsonb_agg(to_jsonb(c))) INTO v_pc
      FROM plan_criterion c WHERE c.plan_phase_id = v_ph.id;
      IF v_pc IS DISTINCT FROM v_lc THEN
        v_conflict := v_pc IS DISTINCT FROM v_bc;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'key', 'crit:' || v_ph.n,
          'phase_n', v_ph.n, 'phase_name', v_ph.name, 'is_current', v_ph.n = v_current_n,
          'type', 'criteria', 'kind', 'replace',
          'template_before', v_bc, 'template_after', v_lc, 'plan', v_pc,
          'conflict', v_conflict, 'default_accept', NOT v_conflict
        ));
      END IF;
    END IF;
  END LOOP;

  -- Phases the template gained that the plan doesn't have yet.
  FOR v_lph IN
    SELECT ph FROM jsonb_array_elements(p_latest) ph
    WHERE (ph->>'n')::int > v_current_n
      AND NOT EXISTS (SELECT 1 FROM plan_phase WHERE plan_version_id = v_version_id AND n = (ph->>'n')::int)
    ORDER BY (ph->>'n')::int
  LOOP
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', 'phase:' || (v_lph->>'n'),
      'phase_n', (v_lph->>'n')::int, 'phase_name', v_lph->>'name', 'is_current', false,
      'type', 'phase', 'kind', 'add',
      'template_after', jsonb_build_object(
        'duration_days', v_lph->'duration_days',
        'exercises', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'exercise_id', x->>'exercise_id', 'name', e.name, 'name_en', e.name_en,
            'rx', app._rx_from_prescription(COALESCE(x->'prescription', '{}'::jsonb))
          ) ORDER BY (x->>'order')::int), '[]'::jsonb)
          FROM jsonb_array_elements(v_lph->'exercises') x
          LEFT JOIN app.exercise e ON e.id = (x->>'exercise_id')::uuid
        ),
        'criteria', app._criteria_norm(v_lph->'criteria')
      ),
      'conflict', false, 'default_accept', true
    ));
  END LOOP;

  RETURN v_out;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app._plan_template_changes(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._plan_template_changes(UUID, JSONB, JSONB) TO service_role;

-- GET /patients/:id/plan/template-diff
CREATE OR REPLACE FUNCTION app.plan_template_diff(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_plan RECORD;
  v_latest_id UUID;
  v_base JSONB;
  v_base_version TEXT;
  v_latest JSONB;
  v_latest_version TEXT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT pl.id, pl.protocol_id, pl.base_protocol_version_id, pl.current_phase_n, pv.version AS plan_version
  INTO v_plan
  FROM patient p
  JOIN plan pl ON pl.patient_id = p.id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
  WHERE p.id = p_patient_id AND p.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_latest_id := app.protocol_snapshot(v_plan.protocol_id);
  SELECT snapshot, version INTO v_latest, v_latest_version FROM app.protocol_version WHERE id = v_latest_id;
  SELECT snapshot, version INTO v_base, v_base_version FROM app.protocol_version WHERE id = v_plan.base_protocol_version_id;

  RETURN jsonb_build_object(
    'plan_version', v_plan.plan_version,
    'current_phase_n', v_plan.current_phase_n,
    'base', CASE WHEN v_base IS NULL THEN NULL
      ELSE jsonb_build_object('id', v_plan.base_protocol_version_id, 'version', v_base_version) END,
    'latest', jsonb_build_object('id', v_latest_id, 'version', v_latest_version),
    'up_to_date', v_base IS NULL OR v_plan.base_protocol_version_id = v_latest_id,
    'changes', CASE WHEN v_base IS NULL OR v_plan.base_protocol_version_id = v_latest_id THEN '[]'::jsonb
      ELSE app._plan_template_changes(v_plan.id, v_base, v_latest) END
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- POST /patients/:id/plan/template-update
-- p_accept: change keys from plan_template_diff to apply; the rest are
-- skipped. Always marks the plan reviewed against p_target_version_id.
CREATE OR REPLACE FUNCTION app.apply_plan_template_update(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_base_version INT,
  p_target_version_id UUID,
  p_accept TEXT[],
  p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_plan RECORD;
  v_latest_id UUID;
  v_base JSONB;
  v_latest JSONB;
  v_changes JSONB;
  v_accept TEXT[] := COALESCE(p_accept, ARRAY[]::text[]);
  v_unknown TEXT;
  v_phase_ns INT[];
  v_n INT;
  v_edits JSONB := '[]'::jsonb;
  v_exercises JSONB;
  v_removals JSONB;
  v_criteria JSONB;
  v_ch JSONB;
  v_next_order INT;
  v_save JSONB;
  v_version INT;
  v_version_id UUID;
  v_added_ids UUID[] := ARRAY[]::uuid[];
  v_new_phases INT[];
  v_reason TEXT := 'עדכון פרוטוקול · Protocol update';
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT pl.id, pl.protocol_id, pl.base_protocol_version_id, pv.id AS version_id, pv.version AS plan_version
  INTO v_plan
  FROM patient p
  JOIN plan pl ON pl.patient_id = p.id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
  WHERE p.id = p_patient_id AND p.deleted_at IS NULL
  FOR UPDATE OF pl;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_plan.plan_version IS DISTINCT FROM p_base_version THEN
    RETURN jsonb_build_object('error', 'plan_version_conflict', 'current_version', v_plan.plan_version);
  END IF;

  v_latest_id := app.protocol_snapshot(v_plan.protocol_id);
  IF v_latest_id IS DISTINCT FROM p_target_version_id THEN
    -- the template changed again since the diff was shown
    RETURN jsonb_build_object('error', 'template_changed', 'latest_version_id', v_latest_id);
  END IF;
  IF v_plan.base_protocol_version_id IS NULL OR v_plan.base_protocol_version_id = v_latest_id THEN
    RETURN jsonb_build_object('ok', true, 'version', v_plan.plan_version, 'applied', 0);
  END IF;

  SELECT snapshot INTO v_base FROM app.protocol_version WHERE id = v_plan.base_protocol_version_id;
  SELECT snapshot INTO v_latest FROM app.protocol_version WHERE id = v_latest_id;
  v_changes := app._plan_template_changes(v_plan.id, v_base, v_latest);

  SELECT k INTO v_unknown FROM unnest(v_accept) k
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_changes) c WHERE c->>'key' = k)
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN
    -- the plan changed under the diff in a way the version check didn't catch
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'unknown_change', 'key', v_unknown);
  END IF;

  -- Exercise/criteria edits, one entry per touched phase.
  SELECT array_agg(DISTINCT (c->>'phase_n')::int) INTO v_phase_ns
  FROM jsonb_array_elements(v_changes) c
  WHERE c->>'key' = ANY(v_accept) AND c->>'type' IN ('exercise', 'criteria');

  FOREACH v_n IN ARRAY COALESCE(v_phase_ns, ARRAY[]::int[]) LOOP
    -- the phase's active rows as save_plan_version_phases expects them
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'plan_exercise_id', pe.id, 'exercise_id', pe.exercise_id,
      'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit, 'tempo', pe.tempo,
      'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
      'frequency_days_per_week', pe.frequency_days_per_week, 'schedule', pe.schedule,
      'order', pe."order", 'clinician_note', pe.clinician_note
    ) ORDER BY pe."order"), '[]'::jsonb),
    COALESCE(max(pe."order"), 0)
    INTO v_exercises, v_next_order
    FROM plan_phase pp JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
    WHERE pp.plan_version_id = v_plan.version_id AND pp.n = v_n;

    v_removals := '{}'::jsonb;
    v_criteria := NULL;

    FOR v_ch IN
      SELECT c FROM jsonb_array_elements(v_changes) c
      WHERE (c->>'phase_n')::int = v_n AND c->>'key' = ANY(v_accept) AND c->>'type' IN ('exercise', 'criteria')
    LOOP
      IF v_ch->>'type' = 'criteria' THEN
        -- template criteria; an identical plan criterion keeps its met state
        SELECT jsonb_agg(lc || jsonb_build_object(
          'order', ord,
          'id', (SELECT pc.id FROM plan_criterion pc JOIN plan_phase pp ON pp.id = pc.plan_phase_id
                 WHERE pp.plan_version_id = v_plan.version_id AND pp.n = v_n
                   AND pc.type = lc->>'type' AND pc.label = lc->>'label' AND pc.operator = lc->>'operator'
                   AND pc.value = (lc->>'value')::numeric
                 LIMIT 1)
        ) ORDER BY ord)
        INTO v_criteria
        FROM jsonb_array_elements(v_ch->'template_after') WITH ORDINALITY AS t(lc, ord);
        v_criteria := COALESCE(v_criteria, '[]'::jsonb);
      ELSIF v_ch->>'kind' = 'remove' THEN
        v_exercises := (
          SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
          FROM jsonb_array_elements(v_exercises) WITH ORDINALITY AS t(e, ord)
          WHERE e->>'plan_exercise_id' IS DISTINCT FROM v_ch->>'plan_exercise_id'  -- new rows have none
        );
        v_removals := v_removals || jsonb_build_object(v_ch->>'plan_exercise_id', v_reason);
      ELSIF v_ch->>'kind' = 'update' THEN
        v_exercises := (
          SELECT jsonb_agg(CASE WHEN e->>'plan_exercise_id' = v_ch->>'plan_exercise_id'
                                THEN e || (v_ch->'template_after') ELSE e END ORDER BY ord)
          FROM jsonb_array_elements(v_exercises) WITH ORDINALITY AS t(e, ord)
        );
      ELSE -- add
        v_next_order := v_next_order + 1;
        v_exercises := v_exercises || jsonb_build_array(
          jsonb_build_object('exercise_id', v_ch->>'exercise_id', 'order', v_next_order) || (v_ch->'template_after')
        );
        v_added_ids := v_added_ids || (v_ch->>'exercise_id')::uuid;
      END IF;
    END LOOP;

    v_edits := v_edits || jsonb_build_array(jsonb_build_object(
      'phase_n', v_n, 'exercises', v_exercises, 'removal_reasons', v_removals, 'criteria', v_criteria
    ));
  END LOOP;

  v_version := v_plan.plan_version;
  v_version_id := v_plan.version_id;

  IF jsonb_array_length(v_edits) > 0 THEN
    v_save := app.save_plan_version_phases(
      p_clinician_id, p_patient_id, p_base_version, v_edits,
      COALESCE(NULLIF(btrim(p_note), ''), 'עדכון פרוטוקול · Protocol update')
    );
    IF v_save ? 'error' THEN
      -- validation happens before any write in save_plan_version_phases
      RETURN v_save;
    END IF;
    v_version := (v_save->>'version')::int;
    v_version_id := (v_save->>'plan_version_id')::uuid;

    -- template-sourced rows, not personal additions
    UPDATE plan_exercise pe SET source = 'protocol'
    FROM plan_phase pp
    WHERE pp.id = pe.plan_phase_id AND pp.plan_version_id = v_version_id
      AND pe.deleted_at IS NULL AND pe.source = 'added' AND pe.exercise_id = ANY(v_added_ids);
  END IF;

  -- Whole phases the template gained (live protocol == latest, checked above).
  SELECT array_agg((c->>'phase_n')::int) INTO v_new_phases
  FROM jsonb_array_elements(v_changes) c
  WHERE c->>'key' = ANY(v_accept) AND c->>'type' = 'phase';
  FOREACH v_n IN ARRAY COALESCE(v_new_phases, ARRAY[]::int[]) LOOP
    PERFORM app._plan_materialize_phases(v_version_id, v_plan.protocol_id, v_n);
  END LOOP;

  UPDATE plan SET base_protocol_version_id = v_latest_id, updated_at = now() WHERE id = v_plan.id;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'plan_template_review', 'plan', v_plan.id);

  RETURN jsonb_build_object(
    'ok', true, 'version', v_version,
    'applied', COALESCE(array_length(v_accept, 1), 0),
    'skipped', jsonb_array_length(v_changes) - COALESCE(array_length(v_accept, 1), 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- GET /protocols/:id/outdated-plans — this clinic's active patients whose
-- plan hasn't been reviewed against the protocol's current version.
CREATE OR REPLACE FUNCTION app.protocol_outdated_plans(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
  v_latest_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.protocol WHERE id = p_protocol_id AND (clinic_id = v_clinic_id OR clinic_id IS NULL)) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  v_latest_id := app.protocol_snapshot(p_protocol_id);

  SELECT jsonb_build_object(
    'latest', (SELECT jsonb_build_object('id', id, 'version', version) FROM app.protocol_version WHERE id = v_latest_id),
    'patients', COALESCE(jsonb_agg(jsonb_build_object(
      'patient_id', p.id, 'name', p.name, 'current_phase_n', pl.current_phase_n,
      'base_version', bv.version
    ) ORDER BY p.name), '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN patient p ON p.id = pl.patient_id AND p.deleted_at IS NULL AND p.status <> 'discharged'
  JOIN app.protocol_version bv ON bv.id = pl.base_protocol_version_id
  WHERE pl.protocol_id = p_protocol_id AND pl.status = 'active'
    AND pl.base_protocol_version_id <> v_latest_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.plan_template_diff(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.plan_template_diff(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION app.apply_plan_template_update(UUID, UUID, INT, UUID, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.apply_plan_template_update(UUID, UUID, INT, UUID, TEXT[], TEXT) TO service_role;
REVOKE ALL ON FUNCTION app.protocol_outdated_plans(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.protocol_outdated_plans(UUID, UUID) TO service_role;

-- --- Timelines from the plan's own phases ---------------------------------

-- Re-declared from 0045: protocol_phases lists the plan's phases (name and
-- duration as this patient has them); goals/name_en from the template.
-- Adds template_update {base_version, latest_version} when the protocol has a
-- version this plan hasn't been reviewed against.
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
    'intake_note', pt.intake_note,
    'pathology', jsonb_build_object(
      'protocol_id', pr.id,
      'name', pr.name,
      'is_custom', (pr.is_template = false AND pr.clinic_id IS NOT NULL)
    ),
    'phases', COALESCE(phase_agg.items, '[]'::jsonb),
    'protocol_phases', COALESCE(protocol_phase_agg.items, '[]'::jsonb),
    'template_update', (
      SELECT jsonb_build_object('base_version', bv.version, 'latest_version', lv.version)
      FROM app.protocol_version bv,
           LATERAL (SELECT id, version FROM app.protocol_version
                    WHERE protocol_id = pl.protocol_id ORDER BY seq DESC LIMIT 1) lv
      WHERE bv.id = pl.base_protocol_version_id AND lv.id <> bv.id
    )
  )
  INTO v_result
  FROM plan pl
  JOIN patient pt ON pt.id = pl.patient_id
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
      'n', plph.n, 'name', plph.name, 'duration_days', plph.duration_days,
      'goals', COALESCE(prpp.goals, '[]'::jsonb)
    ) ORDER BY plph.n) AS items
    FROM plan_phase plph
    LEFT JOIN app.protocol_phase prpp ON prpp.protocol_id = pl.protocol_id AND prpp.n = plph.n
    WHERE plph.plan_version_id = pv.id
  ) protocol_phase_agg ON true
  WHERE pl.patient_id = p_patient_id;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-declared from 0001: phase_timeline from the plan's own phases.
CREATE OR REPLACE FUNCTION app.patient_progress(
  p_patient_auth_id UUID,
  p_window_days INT DEFAULT 30
) RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'adherence_pct', recompute_adherence(v_patient_id, CURRENT_DATE),
    'adherence_series', COALESCE(adherence_series.items, '[]'::jsonb),
    'pain_trend', COALESCE(pain_trend.items, '[]'::jsonb),
    'phase_timeline', COALESCE(phase_timeline.items, '[]'::jsonb),
    'milestones', COALESCE(milestones.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'date', ad.date, 'planned', ad.planned, 'completed', ad.completed,
      'completion_ratio', ad.completion_ratio
    ) ORDER BY ad.date) AS items
    FROM adherence_daily ad
    WHERE ad.patient_id = v_patient_id
      AND ad.date >= CURRENT_DATE - (p_window_days || ' days')::interval
  ) adherence_series ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('date', pt.d, 'max_pain', pt.mp) ORDER BY pt.d) AS items
    FROM (
      SELECT s.date AS d, MAX(si.pain_score) AS mp
      FROM session s
      JOIN session_item si ON si.session_id = s.id
      WHERE s.patient_id = v_patient_id
        AND si.pain_score IS NOT NULL
        AND NOT si.skipped
        AND s.date >= CURRENT_DATE - (p_window_days || ' days')::interval
      GROUP BY s.date
    ) pt
  ) pain_trend ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'n', plph.n, 'name', plph.name, 'name_en', pph.name_en,
      'duration_days', plph.duration_days,
      'status', CASE WHEN plph.n < pl.current_phase_n THEN 'done'
                     WHEN plph.n = pl.current_phase_n THEN 'current'
                     ELSE 'todo' END,
      'started_at', plph.started_at
    ) ORDER BY plph.n) AS items
    FROM plan_version pv
    JOIN plan_phase plph ON plph.plan_version_id = pv.id
    LEFT JOIN app.protocol_phase pph ON pph.protocol_id = pl.protocol_id AND pph.n = plph.n
    WHERE pv.plan_id = pl.id AND pv.is_current = true
  ) phase_timeline ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'from_phase_n', trans.from_phase_n, 'to_phase_n', trans.to_phase_n,
      'direction', trans.direction, 'approved_at', trans.approved_at
    ) ORDER BY trans.approved_at) AS items
    FROM phase_transition trans
    WHERE trans.plan_id = pl.id
  ) milestones ON true
  WHERE pl.patient_id = v_patient_id;

  IF v_result IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'progress', v_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.get_plan(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.get_plan(UUID, UUID, INT) TO service_role;
REVOKE ALL ON FUNCTION app.patient_progress(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.patient_progress(UUID, INT) TO service_role;
