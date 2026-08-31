-- Let a clinic delete an exercise it created or duplicated (T-08 gap).
--
-- Only clinic-custom rows (source = 'clinic', owned by the caller's clinic) are
-- deletable; system-library exercises never are. Soft delete per CLAUDE.md §6:
-- the row is kept (plan_exercise / protocol_phase_exercise still FK to it and
-- historical plans must still resolve the name) but marked inactive + dated, so
-- it drops out of search, add-to-plan, duplicate, and detail — all of which
-- already filter on is_active.

ALTER TABLE app.exercise ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- app.delete_custom_exercise(clinician_id, exercise_id) — DELETE /exercises/:id.
CREATE OR REPLACE FUNCTION app.delete_custom_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  UPDATE app.exercise
  SET is_active = false, deleted_at = now()
  WHERE id = p_exercise_id
    AND source = 'clinic'
    AND clinic_id = v_clinic_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    -- system row, another clinic's row, already deleted, or nonexistent —
    -- indistinguishable to the caller on purpose (rule 4).
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.delete_custom_exercise(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_custom_exercise(UUID, UUID) TO authenticated, service_role;
