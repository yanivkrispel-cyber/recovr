-- T-32 — "Add to protocol" follows the T-30 hybrid ownership model
-- (product owner, 2026-09-13).
--
-- attach_exercise_to_protocol_phase used to accept only the caller's own
-- clinic protocols, so the exercise editor offered 1 of 26 protocols. Now:
--   * clinic protocol of the caller's clinic -> attach to it (unchanged)
--   * system protocol, catalog curator       -> attach to the system protocol
--                                               itself (every clinic sees it);
--                                               its version is bumped
--   * system protocol, anyone else           -> duplicate it into a private
--                                               clinic copy (protocol_duplicate)
--                                               and attach to the copy
-- Patients are unaffected either way: a plan is a copy made when it was
-- assigned. Only approved exercises can be attached (T-30 status gating).

CREATE OR REPLACE FUNCTION app.attach_exercise_to_protocol_phase(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_protocol_id UUID,
  p_phase_n INT
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_curator BOOLEAN;
  v_protocol app.protocol;
  v_source_phase UUID;
  v_target UUID;
  v_phase_id UUID;
  v_next_order INT;
  v_copied BOOLEAN := false;
  v_dup JSONB;
  v_scope TEXT;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  IF NOT EXISTS (
    SELECT 1 FROM app.exercise
    WHERE id = p_exercise_id AND is_active AND deleted_at IS NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
  ) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = p_exercise_id AND status = 'approved') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'exercise_not_approved');
  END IF;

  SELECT * INTO v_protocol FROM app.protocol
  WHERE id = p_protocol_id AND is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- validate against the source before any copy is made
  SELECT id INTO v_source_phase FROM app.protocol_phase WHERE protocol_id = p_protocol_id AND n = p_phase_n;
  IF v_source_phase IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF EXISTS (SELECT 1 FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_source_phase AND exercise_id = p_exercise_id) THEN
    RETURN jsonb_build_object('ok', true, 'already_attached', true, 'protocol_id', p_protocol_id, 'copied', false);
  END IF;

  IF v_protocol.clinic_id IS NOT NULL THEN
    v_target := p_protocol_id;
    v_scope := 'clinic';
  ELSIF v_is_curator THEN
    v_target := p_protocol_id;
    v_scope := 'master';
  ELSE
    v_dup := app.protocol_duplicate(p_clinician_id, p_protocol_id);
    IF v_dup ? 'error' THEN
      RETURN v_dup;
    END IF;
    v_target := (v_dup ->> 'id')::uuid;
    v_copied := true;
    v_scope := 'clinic';
  END IF;

  SELECT id INTO v_phase_id FROM app.protocol_phase WHERE protocol_id = v_target AND n = p_phase_n;

  SELECT COALESCE(MAX("order"), 0) + 1 INTO v_next_order
  FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_phase_id;

  INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, "order")
  VALUES (v_phase_id, p_exercise_id, '{}'::jsonb, v_next_order);

  IF v_scope = 'master' THEN
    BEGIN
      UPDATE app.protocol SET version = (COALESCE(version, '1.0')::numeric + 0.1)::text, updated_at = now()
      WHERE id = v_target;
    EXCEPTION WHEN OTHERS THEN
      UPDATE app.protocol SET updated_at = now() WHERE id = v_target;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'protocol_id', v_target, 'copied', v_copied, 'scope', v_scope,
    'protocol_name', (SELECT name FROM app.protocol WHERE id = v_target)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
