-- Surface exercise media to the patient during a session (T-14 → T-11).
--
-- Adds `media` to each item's `exercise` object in app.patient_today. Only
-- VERIFIED media is included (verified_at IS NOT NULL) — CLAUDE.md §Media,
-- RULES §7. Until the Gym visual licence question is answered nothing is
-- verified, so `media` comes back empty and the patient app shows its labeled
-- placeholder frame. `url`/`thumb_url` are bucket-relative paths; the me-today
-- edge function turns them into signed URLs.

CREATE OR REPLACE FUNCTION app.patient_today(p_patient_auth_id UUID, p_today DATE)
RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_plan_version_id UUID;
  v_phase_id UUID;
  v_phase_name TEXT;
  v_phase_n INT;
  v_session_id UUID;
  v_items JSONB;
  v_done INT;
  v_total INT;
  v_patient_name TEXT;
  v_protocol_name TEXT;
  v_plan_started_at TIMESTAMPTZ;
  v_plan_version_no INT;
  v_plan_version_created_at TIMESTAMPTZ;
  v_est_seconds INT;
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

  SELECT pv.id, pp.id, pp.name, pp.n, p.name, pr.name, pl.started_at, pv.version, pv.created_at
  INTO v_plan_version_id, v_phase_id, v_phase_name, v_phase_n, v_patient_name, v_protocol_name, v_plan_started_at, v_plan_version_no, v_plan_version_created_at
  FROM plan pl
  JOIN patient p ON p.id = pl.patient_id
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = v_patient_id;

  IF v_phase_id IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  SELECT id INTO v_session_id FROM session WHERE patient_id = v_patient_id AND date = p_today;
  IF v_session_id IS NULL THEN
    SELECT count(*) INTO v_total FROM plan_exercise WHERE plan_phase_id = v_phase_id AND deleted_at IS NULL;
    INSERT INTO session (patient_id, plan_version_id, date, status, items_planned)
    VALUES (v_patient_id, v_plan_version_id, p_today, 'planned', v_total)
    RETURNING id INTO v_session_id;
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pe.id, 'plan_phase_id', pe.plan_phase_id, 'exercise_id', pe.exercise_id,
      'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit,
      'tempo', pe.tempo, 'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
      'order', pe."order", 'source', pe.source,
      'exercise', jsonb_build_object(
        'name', ex.name, 'name_en', ex.name_en, 'instructions', ex.instructions,
        'media', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'kind', m.kind, 'url', m.url, 'thumb_url', m.thumb_url,
            'width', m.width, 'height', m.height
          ) ORDER BY m."order")
          FROM app.exercise_media m
          WHERE m.exercise_id = ex.id AND m.verified_at IS NOT NULL
        ), '[]'::jsonb)
      ),
      'done', (si.id IS NOT NULL AND NOT si.skipped)
    ) ORDER BY pe."order"), '[]'::jsonb),
    count(*) FILTER (WHERE si.id IS NOT NULL AND NOT si.skipped)
  INTO v_items, v_done
  FROM plan_exercise pe
  JOIN app.exercise ex ON ex.id = pe.exercise_id
  LEFT JOIN session_item si ON si.session_id = v_session_id AND si.plan_exercise_id = pe.id
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  v_total := jsonb_array_length(v_items);

  -- Rough duration estimate for the "~N min" header line — not a clinical
  -- figure, just a UX estimate from the prescribed sets/reps/hold/rest.
  SELECT COALESCE(sum(pe.sets * (COALESCE(pe.hold_sec, pe.reps * 3, 20) + COALESCE(pe.rest_sec, 30))), 0)
  INTO v_est_seconds
  FROM plan_exercise pe
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'session', v_session_id);

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'date', p_today,
    'patient', jsonb_build_object('name', v_patient_name, 'day', (p_today - v_plan_started_at::date) + 1),
    'plan', jsonb_build_object(
      'protocol_name', v_protocol_name,
      'updated_recently', v_plan_version_no > 1 AND v_plan_version_created_at >= now() - interval '3 days'
    ),
    'est_minutes', GREATEST(1, round(v_est_seconds / 60.0)::int),
    'phase', jsonb_build_object('name', v_phase_name, 'n', v_phase_n),
    'items', v_items,
    'progress', jsonb_build_object('done', v_done, 'total', v_total)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
