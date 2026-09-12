-- "Quick attach" — let a clinician optionally attach an exercise to one phase
-- of one of their own protocols directly from the exercise create/edit form,
-- instead of having to go into the protocol editor. Appends to the end of the
-- phase with a blank prescription; sets/reps/hold/tempo/order are still
-- fine-tuned in the protocol editor afterwards (protocol_update), same as any
-- other phase exercise.
--
-- Only clinic-owned protocols are targets (system protocols aren't editable —
-- same rule as everywhere else). Note protocol_update (PATCH /protocols/:id)
-- does a full delete+reinsert of every phase on save (see 0021), so if the
-- protocol editor is open with stale data in another tab when this runs, a
-- subsequent save there can overwrite this attach — an existing risk of the
-- whole-document-replace editor, not something new here.

CREATE OR REPLACE FUNCTION app.attach_exercise_to_protocol_phase(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_protocol_id UUID,
  p_phase_n INT
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_phase_id UUID;
  v_next_order INT;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.exercise
    WHERE id = p_exercise_id AND is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
  ) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT pp.id INTO v_phase_id
  FROM app.protocol_phase pp
  JOIN app.protocol pr ON pr.id = pp.protocol_id
  WHERE pp.protocol_id = p_protocol_id AND pp.n = p_phase_n
    AND pr.source = 'clinic' AND pr.clinic_id = v_clinic_id;

  IF v_phase_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF EXISTS (
    SELECT 1 FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_phase_id AND exercise_id = p_exercise_id
  ) THEN
    RETURN jsonb_build_object('ok', true, 'already_attached', true);
  END IF;

  SELECT COALESCE(MAX("order"), 0) + 1 INTO v_next_order
  FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_phase_id;

  INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, "order")
  VALUES (v_phase_id, p_exercise_id, '{}'::jsonb, v_next_order);

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.attach_exercise_to_protocol_phase(UUID, UUID, UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attach_exercise_to_protocol_phase(UUID, UUID, UUID, INT) TO authenticated, service_role;
