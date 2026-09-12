-- Let a clinic edit an exercise it created or duplicated (T-08 gap, same
-- shape as create_custom_exercise — mirrors its field set and validation).
-- Only clinic-owned rows are editable; system-library exercises never are
-- (same rule as delete_custom_exercise / set_exercise_video — duplicate first).

-- app.update_custom_exercise(...) — PUT /exercises/:id.
CREATE OR REPLACE FUNCTION app.update_custom_exercise(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_category TEXT,
  p_region TEXT,
  p_description TEXT,
  p_instructions TEXT,
  p_is_bilateral BOOLEAN
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF p_category NOT IN ('Mobility', 'Strength', 'Balance', 'Control', 'Cardio') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_category');
  END IF;

  UPDATE app.exercise
  SET name = p_name, name_en = p_name_en, category = p_category, region = p_region,
      description = p_description, instructions = p_instructions,
      is_bilateral = COALESCE(p_is_bilateral, false), updated_at = now()
  WHERE id = p_exercise_id AND source = 'clinic' AND clinic_id = v_clinic_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    -- system row, another clinic's row, already deleted, or nonexistent —
    -- indistinguishable to the caller on purpose (rule 4).
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.update_custom_exercise(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_custom_exercise(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
