-- Catalog cleanup step 1 (2026-09-13) — a reusable master-catalog merge.
-- Curators use this from the library workspace to fold a duplicate system
-- exercise into its canonical row; it's also used by seed.sql to merge the
-- three JSON-derived duplicates (Quad Sets, Straight Leg Raise, Heel Slides)
-- into the hand-authored acl_post_op_weeks_1_4 demo rows, which already carry
-- Hebrew instructions and live patient-plan data. See
-- https://claude.ai/code/artifact/27d95f2c-46a6-4bc4-975f-29d34997fc70 for the
-- approved decision list this migration and the seed changes implement.
--
-- p_clinician_id NULL means "system caller" (migrations/seed) and skips the
-- curator check; every other caller must be a curator, and both rows must be
-- master rows (clinic_id IS NULL) — merging clinic-owned exercises isn't
-- supported here.
CREATE OR REPLACE FUNCTION app.catalog_merge_exercise(p_clinician_id UUID, p_from_id UUID, p_to_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_from app.exercise;
  v_to app.exercise;
  v_schema TEXT;
BEGIN
  IF p_clinician_id IS NOT NULL AND NOT app.is_catalog_curator(p_clinician_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_from_id = p_to_id THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'same_exercise');
  END IF;

  SELECT * INTO v_from FROM app.exercise WHERE id = p_from_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO v_to FROM app.exercise WHERE id = p_to_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_from IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_from.clinic_id IS NOT NULL OR v_to.clinic_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'master_rows_only');
  END IF;

  UPDATE app.protocol_phase_exercise SET exercise_id = p_to_id WHERE exercise_id = p_from_id;
  UPDATE app.exercise_media SET exercise_id = p_to_id WHERE exercise_id = p_from_id;

  -- exercise_favorite has PK (user_id, exercise_id): repoint only where the
  -- user doesn't already favorite the target, drop the rest to avoid a
  -- conflict.
  UPDATE app.exercise_favorite f SET exercise_id = p_to_id
  WHERE f.exercise_id = p_from_id
    AND NOT EXISTS (SELECT 1 FROM app.exercise_favorite g WHERE g.user_id = f.user_id AND g.exercise_id = p_to_id);
  DELETE FROM app.exercise_favorite WHERE exercise_id = p_from_id;

  UPDATE app.exercise_pick_event SET exercise_id = p_to_id WHERE exercise_id = p_from_id;

  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    IF to_regclass(format('%I.plan_exercise', v_schema)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I.plan_exercise SET exercise_id = $1 WHERE exercise_id = $2', v_schema)
        USING p_to_id, p_from_id;
    END IF;
  END LOOP;

  UPDATE app.exercise SET
    aliases = ARRAY(
      SELECT DISTINCT x FROM unnest(aliases || ARRAY[v_from.name_en, v_from.name] || COALESCE(v_from.aliases, '{}')) x
      WHERE x IS NOT NULL AND btrim(x) <> ''
    ),
    revision = revision + 1, updated_at = now()
  WHERE id = p_to_id;

  UPDATE app.exercise SET
    status = 'archived', is_active = false, deleted_at = now(), updated_at = now()
  WHERE id = p_from_id;

  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  VALUES (p_to_id, NULL, 'master', 'duplicate',
          jsonb_build_object('merged_from', jsonb_build_object('id', p_from_id, 'name', v_from.name, 'name_en', v_from.name_en)),
          p_clinician_id);

  RETURN jsonb_build_object('ok', true, 'from', p_from_id, 'to', p_to_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_merge_exercise(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_merge_exercise(UUID, UUID, UUID) TO authenticated, service_role;
