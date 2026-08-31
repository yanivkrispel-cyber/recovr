-- app.patient_plan — data for the printable home program (T-15).
--
-- Patient-auth-scoped read of the current plan version's current phase:
-- exercises (with prescription, clinician note, instructions, common mistakes,
-- and VERIFIED media only), phase goals, phase criteria, and the treating
-- clinician's name + phone for the footer. GET /me/plan (API_CONTRACT). The
-- me-plan edge function turns the bucket-relative media paths into signed URLs.

CREATE OR REPLACE FUNCTION app.patient_plan(p_patient_auth_id UUID, p_today DATE)
RETURNS JSONB AS $$
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
    'patient', jsonb_build_object(
      'name', p.name,
      'day', GREATEST(1, (p_today - pl.started_at::date) + 1)
    ),
    'clinician', jsonb_build_object('name', u.name, 'phone', u.phone),
    'plan', jsonb_build_object('protocol_name', pr.name, 'started_at', pl.started_at),
    'phase', jsonb_build_object(
      'n', plph.n,
      'name', plph.name,
      'goals', COALESCE(pph.goals, '[]'::jsonb),
      'criteria', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'type', c.type, 'label', c.label, 'label_en', c.label_en,
          'operator', c.operator, 'value', c.value, 'unit', c.unit, 'is_met', c.is_met
        ) ORDER BY c."order")
        FROM plan_criterion c WHERE c.plan_phase_id = plph.id
      ), '[]'::jsonb)
    ),
    'exercises', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', ex.name, 'name_en', ex.name_en,
        'sets', pe.sets, 'reps', pe.reps, 'hold_sec', pe.hold_sec,
        'frequency_days_per_week', pe.frequency_days_per_week,
        'clinician_note', pe.clinician_note,
        'instructions', ex.instructions,
        'common_mistakes', ex.common_mistakes,
        'media', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'kind', m.kind, 'url', m.url, 'thumb_url', m.thumb_url,
            'width', m.width, 'height', m.height
          ) ORDER BY m."order")
          FROM app.exercise_media m
          WHERE m.exercise_id = ex.id AND m.verified_at IS NOT NULL
        ), '[]'::jsonb)
      ) ORDER BY pe."order")
      FROM plan_exercise pe
      JOIN app.exercise ex ON ex.id = pe.exercise_id
      WHERE pe.plan_phase_id = plph.id AND pe.deleted_at IS NULL
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN patient p ON p.id = pl.patient_id
  LEFT JOIN app."user" u ON u.id = p.primary_clinician_id
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase plph ON plph.plan_version_id = pv.id AND plph.n = pl.current_phase_n
  LEFT JOIN app.protocol_phase pph ON pph.protocol_id = pl.protocol_id AND pph.n = pl.current_phase_n
  WHERE pl.patient_id = v_patient_id;

  IF v_result IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'plan', v_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.patient_plan(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.patient_plan(UUID, DATE) TO authenticated, service_role;
