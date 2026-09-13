-- T-33 — Exercise catalog schema v2 (catalog cleanup step 2, 2026-09-13).
-- See https://claude.ai/code/artifact/27d95f2c-46a6-4bc4-975f-29d34997fc70 and
-- [[project-catalog-cleanup]] for the plan this implements.
--
-- New classification the picker/recommender and a professional rehab
-- library need, none of it clinic-overridable (curator/clinic-owner only,
-- same as start_position/difficulty):
--   - item_kind: exercise (default) / education (read-and-confirm, no sets
--     or reps) / program (a graded schedule dosed in time or distance).
--   - weight_bearing: nwb / pwb / fwb — the field post-op protocols gate on.
--   - contraction_type: the movement quality (isometric, eccentric,
--     plyometric, a stretch, a ROM level, a neural glide, ...) — "Strength"
--     alone doesn't distinguish a quad set from a Nordic curl.
--   - laterality: unilateral / bilateral / alternating, replacing the
--     ambiguous is_bilateral boolean (kept for backward compatibility,
--     unused by new code).
--   - instruction_steps: numbered Hebrew steps, replacing free-text
--     `instructions` as the patient-facing format (instructions stays for
--     older content and as a fallback).
--   - default_prescription (existing JSONB column, was unvalidated): now a
--     typed dosage — {mode: reps|hold|duration|distance, sets, reps,
--     hold_sec, duration_min, distance_m, rest_sec, tempo}.
--   - app.exercise_secondary_region: an exercise can affect more than one
--     region (Bridge: hip + spine); body_region_id stays the primary region
--     search/filtering defaults to.
--
-- Deliberately NOT done here: app.exercise_effective doesn't merge these as
-- clinic overrides (they're master-only, so plain columns on app.exercise
-- are the source of truth for both master and clinic-owned rows — no merge
-- needed), and the patient-facing read path (exercise_effective,
-- patient_today, patient_plan, ExerciseFlow) isn't wired to instruction_steps
-- yet — that's step 3 (P0 content), once rows actually have steps to show.

ALTER TABLE app.exercise
  ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'exercise'
    CHECK (item_kind IN ('exercise', 'education', 'program')),
  ADD COLUMN weight_bearing TEXT
    CHECK (weight_bearing IN ('nwb', 'pwb', 'fwb')),
  ADD COLUMN contraction_type TEXT
    CHECK (contraction_type IN (
      'isometric', 'concentric', 'eccentric', 'isotonic', 'plyometric',
      'stretch', 'rom_passive', 'rom_active_assisted', 'rom_active',
      'neural_glide', 'proprioception'
    )),
  ADD COLUMN laterality TEXT
    CHECK (laterality IN ('unilateral', 'bilateral', 'alternating')),
  ADD COLUMN instruction_steps TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX app_exercise_item_kind_idx ON app.exercise(item_kind);

CREATE TABLE app.exercise_secondary_region (
  exercise_id    UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  body_region_id UUID NOT NULL REFERENCES app.body_region(id),
  PRIMARY KEY (exercise_id, body_region_id)
);

-- item_kind backfill for the T01/T03 rows (education/program) lives in
-- seed.sql, not here: those exercise rows come from protocols_import.sql,
-- which runs after every migration — an UPDATE here would find nothing.

-- ============================================================================
-- Field registry: teach the existing patch validator/override system about
-- the new fields (0032's app._catalog_*_fields, used by
-- app._catalog_normalize_patch and the override merge).
-- ============================================================================
CREATE OR REPLACE FUNCTION app._catalog_array_fields() RETURNS TEXT[] AS $$
  SELECT ARRAY['aliases', 'key_cues', 'muscles', 'equipment', 'instruction_steps'];
$$ LANGUAGE sql IMMUTABLE;

-- instruction_steps is master-only for now (see header) — _catalog_content_fields
-- (the override-eligible set) is intentionally left unchanged.

CREATE OR REPLACE FUNCTION app._catalog_normalize_patch(p_patch JSONB)
RETURNS JSONB AS $$
DECLARE
  v_out JSONB := '{}'::jsonb;
  v_key TEXT;
  v_val JSONB;
  v_text TEXT;
  v_items TEXT[];
  v_uuid UUID;
  v_max_len INT;
  v_rx JSONB;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'empty_patch');
  END IF;

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_patch) LOOP
    IF v_key = ANY(app._catalog_text_fields()) THEN
      IF jsonb_typeof(v_val) NOT IN ('string', 'null') THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_value', 'field', v_key);
      END IF;
      v_text := NULLIF(btrim(v_val #>> '{}'), '');
      IF v_key = 'name' AND v_text IS NULL THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required', 'field', v_key);
      END IF;
      v_max_len := CASE WHEN v_key IN ('name', 'name_en') THEN 200 ELSE 5000 END;
      IF length(v_text) > v_max_len THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'too_long', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_text);

    ELSIF v_key = ANY(app._catalog_array_fields()) THEN
      IF jsonb_typeof(v_val) = 'null' THEN
        v_items := '{}';
      ELSIF jsonb_typeof(v_val) <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_val) e WHERE jsonb_typeof(e) <> 'string') THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_value', 'field', v_key);
      ELSE
        IF v_key = 'instruction_steps' THEN
          -- steps keep their given order, not de-duplicated/sorted like tags
          SELECT COALESCE(array_agg(x) FILTER (WHERE x <> ''), '{}')
          INTO v_items FROM (SELECT btrim(e) AS x FROM jsonb_array_elements_text(v_val) WITH ORDINALITY t(e, ord) ORDER BY ord) s;
        ELSE
          SELECT COALESCE(array_agg(x ORDER BY ord), '{}') INTO v_items
          FROM (
            SELECT DISTINCT ON (lower(x)) x, ord
            FROM (SELECT btrim(e) AS x, ord FROM jsonb_array_elements_text(v_val) WITH ORDINALITY t(e, ord)) s
            WHERE x <> ''
            ORDER BY lower(x), ord
          ) d;
        END IF;
      END IF;
      v_max_len := CASE WHEN v_key = 'instruction_steps' THEN 500 ELSE 300 END;
      IF cardinality(v_items) > 40 OR EXISTS (SELECT 1 FROM unnest(v_items) x WHERE length(x) > v_max_len) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'too_long', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_items));

    ELSIF v_key = 'category' THEN
      IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('Mobility', 'Strength', 'Balance', 'Control', 'Cardio') THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_category', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'body_region_id' THEN
      IF jsonb_typeof(v_val) = 'null' THEN
        v_out := v_out || jsonb_build_object(v_key, NULL);
      ELSE
        BEGIN
          v_uuid := (v_val #>> '{}')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          v_uuid := NULL;
        END;
        IF jsonb_typeof(v_val) <> 'string' OR v_uuid IS NULL
           OR NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = v_uuid) THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region', 'field', v_key);
        END IF;
        v_out := v_out || jsonb_build_object(v_key, v_uuid);
      END IF;

    ELSIF v_key = 'start_position' THEN
      IF jsonb_typeof(v_val) <> 'null' AND (jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN
           ('standing', 'sitting', 'supine', 'prone', 'side_lying', 'quadruped', 'kneeling', 'other')) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_position', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'difficulty' THEN
      IF jsonb_typeof(v_val) <> 'null' AND (jsonb_typeof(v_val) <> 'number' OR (v_val #>> '{}') NOT IN ('1', '2', '3')) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_difficulty', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'is_bilateral' THEN
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_value', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'item_kind' THEN
      IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('exercise', 'education', 'program') THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_item_kind', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'weight_bearing' THEN
      IF jsonb_typeof(v_val) <> 'null' AND (jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('nwb', 'pwb', 'fwb')) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_weight_bearing', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'contraction_type' THEN
      IF jsonb_typeof(v_val) <> 'null' AND (jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN (
           'isometric', 'concentric', 'eccentric', 'isotonic', 'plyometric', 'stretch',
           'rom_passive', 'rom_active_assisted', 'rom_active', 'neural_glide', 'proprioception')) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_contraction_type', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'laterality' THEN
      IF jsonb_typeof(v_val) <> 'null' AND (jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') NOT IN ('unilateral', 'bilateral', 'alternating')) THEN
        RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_laterality', 'field', v_key);
      END IF;
      v_out := v_out || jsonb_build_object(v_key, v_val);

    ELSIF v_key = 'default_prescription' THEN
      IF jsonb_typeof(v_val) = 'null' THEN
        v_out := v_out || jsonb_build_object(v_key, '{}'::jsonb);
      ELSE
        IF jsonb_typeof(v_val) <> 'object' THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_prescription', 'field', v_key);
        END IF;
        IF v_val ? 'mode' AND (v_val ->> 'mode') NOT IN ('reps', 'hold', 'duration', 'distance') THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_prescription_mode', 'field', v_key);
        END IF;
        IF EXISTS (
          SELECT 1 FROM jsonb_each(v_val) kv
          WHERE kv.key NOT IN ('mode', 'sets', 'reps', 'hold_sec', 'duration_min', 'distance_m', 'rest_sec', 'tempo')
             OR (kv.key <> 'mode' AND kv.key <> 'tempo' AND jsonb_typeof(kv.value) NOT IN ('number', 'null'))
             OR (kv.key = 'tempo' AND jsonb_typeof(kv.value) NOT IN ('string', 'null'))
        ) THEN
          RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_prescription', 'field', v_key);
        END IF;
        v_out := v_out || jsonb_build_object(v_key, v_val);
      END IF;

    ELSE
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'unknown_field', 'field', v_key);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('patch', v_out);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- catalog_save_exercise: extend the master/clinic row UPDATE to include the
-- new columns (v_new already carries them via jsonb_populate_record; the
-- override branch above is untouched — none of these are content fields).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_save_exercise(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_patch JSONB,
  p_expected_revision INT DEFAULT NULL,
  p_scope TEXT DEFAULT NULL,
  p_action TEXT DEFAULT 'update'
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_curator BOOLEAN;
  v_norm JSONB;
  v_patch JSONB;
  v_old app.exercise;
  v_new app.exercise;
  v_old_json JSONB;
  v_new_json JSONB;
  v_target TEXT;
  v_changes JSONB;
  v_key TEXT;
  v_ov app.exercise_override;
  v_fields JSONB;
  v_master_val JSONB;
  v_effective_val JSONB;
  v_id UUID;
  v_revision INT;
  v_action TEXT := COALESCE(p_action, 'update');
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  v_norm := app._catalog_normalize_patch(p_patch);
  IF v_norm ? 'error' THEN
    RETURN v_norm;
  END IF;
  v_patch := v_norm -> 'patch';

  -- ---------------------------------------------------------------- create
  IF p_exercise_id IS NULL THEN
    IF NOT (v_patch ? 'name') THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required', 'field', 'name');
    END IF;
    IF COALESCE(p_scope, 'clinic') = 'master' AND NOT v_is_curator THEN
      RETURN jsonb_build_object('error', 'forbidden');
    END IF;
    v_target := CASE WHEN COALESCE(p_scope, 'clinic') = 'master' THEN 'master' ELSE 'clinic' END;

    INSERT INTO app.exercise (clinic_id, name, category, source, status, revision, curated_at)
    VALUES (
      CASE WHEN v_target = 'master' THEN NULL ELSE v_clinic_id END,
      v_patch ->> 'name',
      COALESCE(v_patch ->> 'category', 'Strength'),
      CASE WHEN v_target = 'master' THEN 'system' ELSE 'clinic' END,
      'draft', 0,
      CASE WHEN v_target = 'master' THEN now() END
    )
    RETURNING * INTO v_old;
    v_old_json := to_jsonb(v_old);
    v_action := 'create';
    -- fall through to the row update below with an empty "from"
  ELSE
    SELECT * INTO v_old FROM app.exercise
    WHERE id = p_exercise_id AND deleted_at IS NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'not_found');
    END IF;
    v_old_json := to_jsonb(v_old);
    v_target := CASE
      WHEN v_old.clinic_id IS NOT NULL THEN 'clinic'
      WHEN v_is_curator THEN 'master'
      ELSE 'override'
    END;
  END IF;

  -- -------------------------------------------------------------- override
  IF v_target = 'override' THEN
    FOR v_key IN SELECT jsonb_object_keys(v_patch) LOOP
      IF NOT (v_key = ANY(app._catalog_content_fields())) THEN
        RETURN jsonb_build_object('error', 'forbidden', 'message', 'master_field', 'field', v_key);
      END IF;
    END LOOP;

    INSERT INTO app.exercise_override (clinic_id, exercise_id)
    VALUES (v_clinic_id, v_old.id)
    ON CONFLICT (clinic_id, exercise_id) DO NOTHING;
    SELECT * INTO v_ov FROM app.exercise_override
    WHERE clinic_id = v_clinic_id AND exercise_id = v_old.id FOR UPDATE;

    IF p_expected_revision IS NOT NULL AND v_ov.revision <> p_expected_revision THEN
      RETURN jsonb_build_object('error', 'conflict', 'revision', v_ov.revision);
    END IF;

    v_fields := v_ov.fields;
    v_changes := '{}'::jsonb;
    FOR v_key IN SELECT jsonb_object_keys(v_patch) LOOP
      v_master_val := app._catalog_field_value(v_old_json, v_key);
      v_effective_val := CASE WHEN v_fields ? v_key THEN v_fields -> v_key ELSE v_master_val END;
      IF v_effective_val IS DISTINCT FROM (v_patch -> v_key) THEN
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_effective_val, 'to', v_patch -> v_key));
      END IF;
      IF (v_patch -> v_key) = v_master_val THEN
        v_fields := v_fields - v_key;
      ELSE
        v_fields := v_fields || jsonb_build_object(v_key, v_patch -> v_key);
      END IF;
    END LOOP;

    IF v_changes = '{}'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'id', v_old.id, 'revision', v_old.revision,
                                'override_revision', v_ov.revision, 'changed', false)
             || app._catalog_completeness_for(v_clinic_id, v_old.id);
    END IF;

    UPDATE app.exercise_override
    SET fields = v_fields, revision = revision + 1, updated_by = p_clinician_id, updated_at = now()
    WHERE clinic_id = v_clinic_id AND exercise_id = v_old.id
    RETURNING * INTO v_ov;

    INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
    VALUES (v_old.id, v_clinic_id, 'override', v_action, v_changes, p_clinician_id);

    RETURN jsonb_build_object('ok', true, 'id', v_old.id, 'revision', v_old.revision,
                              'override_revision', v_ov.revision, 'changed', true,
                              'overridden_fields', COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(v_fields) k), '[]'::jsonb))
           || app._catalog_completeness_for(v_clinic_id, v_old.id);
  END IF;

  -- ------------------------------------------------------ master / clinic row
  IF v_action <> 'create' AND p_expected_revision IS NOT NULL AND v_old.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('error', 'conflict', 'revision', v_old.revision);
  END IF;

  v_new := jsonb_populate_record(v_old, v_patch);
  v_new_json := to_jsonb(v_new);

  SELECT COALESCE(jsonb_object_agg(k, jsonb_build_object(
           'from', CASE WHEN v_action = 'create' THEN 'null'::jsonb ELSE app._catalog_field_value(v_old_json, k) END,
           'to', app._catalog_field_value(v_new_json, k))), '{}'::jsonb)
  INTO v_changes
  FROM jsonb_object_keys(v_patch) k
  WHERE v_action = 'create' OR app._catalog_field_value(v_old_json, k) IS DISTINCT FROM app._catalog_field_value(v_new_json, k);

  IF v_changes = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', true, 'id', v_old.id, 'revision', v_old.revision, 'changed', false)
           || app._catalog_completeness_for(v_clinic_id, v_old.id);
  END IF;

  UPDATE app.exercise SET
    name = v_new.name, name_en = v_new.name_en, category = v_new.category,
    body_region_id = v_new.body_region_id, muscles = v_new.muscles, equipment = v_new.equipment,
    aliases = COALESCE(v_new.aliases, '{}'), key_cues = COALESCE(v_new.key_cues, '{}'),
    description = v_new.description, instructions = v_new.instructions,
    common_mistakes = v_new.common_mistakes, safety_notes = v_new.safety_notes,
    contraindications = v_new.contraindications,
    start_position = v_new.start_position, difficulty = v_new.difficulty, is_bilateral = v_new.is_bilateral,
    item_kind = COALESCE(v_new.item_kind, 'exercise'), weight_bearing = v_new.weight_bearing,
    contraction_type = v_new.contraction_type, laterality = v_new.laterality,
    instruction_steps = COALESCE(v_new.instruction_steps, '{}'),
    default_prescription = COALESCE(v_new.default_prescription, '{}'::jsonb),
    revision = revision + 1,
    curated_at = CASE WHEN v_target = 'master' THEN now() ELSE curated_at END,
    updated_at = now()
  WHERE id = v_old.id
  RETURNING id, revision INTO v_id, v_revision;

  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  VALUES (v_id, CASE WHEN v_target = 'master' THEN NULL ELSE v_clinic_id END, v_target, v_action, v_changes, p_clinician_id);

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'revision', v_revision, 'changed', true)
         || app._catalog_completeness_for(v_clinic_id, v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- catalog_set_secondary_regions: the exercise_secondary_region junction isn't
-- a plain column, so it gets its own small RPC rather than going through the
-- generic patch path. Master rows: curators only, same rule as every other
-- classification field.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_set_secondary_regions(p_clinician_id UUID, p_exercise_id UUID, p_region_ids UUID[])
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_ex app.exercise;
  v_ids UUID[];
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ex FROM app.exercise
  WHERE id = p_exercise_id AND deleted_at IS NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_ex.clinic_id IS NULL AND NOT app.is_catalog_curator(p_clinician_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}') INTO v_ids
  FROM unnest(COALESCE(p_region_ids, '{}')) x WHERE x <> v_ex.body_region_id;
  IF v_ids IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(v_ids) r WHERE NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = r)) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  DELETE FROM app.exercise_secondary_region WHERE exercise_id = p_exercise_id;
  INSERT INTO app.exercise_secondary_region (exercise_id, body_region_id)
  SELECT p_exercise_id, r FROM unnest(v_ids) r;

  UPDATE app.exercise SET revision = revision + 1, updated_at = now() WHERE id = p_exercise_id;
  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  VALUES (p_exercise_id, CASE WHEN v_ex.clinic_id IS NULL THEN NULL ELSE v_clinic_id END,
          CASE WHEN v_ex.clinic_id IS NULL THEN 'master' ELSE 'clinic' END, 'update',
          jsonb_build_object('secondary_regions', jsonb_build_object('to', to_jsonb(v_ids))), p_clinician_id);

  RETURN jsonb_build_object('ok', true, 'secondary_region_ids', to_jsonb(v_ids));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_set_secondary_regions(UUID, UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_set_secondary_regions(UUID, UUID, UUID[]) TO authenticated, service_role;

-- ============================================================================
-- catalog_get_exercise: surface the new columns (read from the row itself,
-- v_master — these aren't override-merged, see header).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_get_exercise(p_clinician_id uuid, p_exercise_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
  v_is_curator BOOLEAN;
  v_ex RECORD;
  v_master app.exercise;
  v_has_media BOOLEAN;
  v_comp RECORD;
  v_plan_count INT;
  v_protocols JSONB;
  v_can_edit_master BOOLEAN;
  v_secondary_regions JSONB;
BEGIN
  SELECT r.clinic_id, r.schema_name INTO v_clinic_id, v_schema FROM app.resolve_clinician_schema(p_clinician_id) r;
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  SELECT * INTO v_ex FROM app.exercise_effective(v_clinic_id) e
  WHERE e.id = p_exercise_id AND e.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  SELECT * INTO v_master FROM app.exercise WHERE id = p_exercise_id;

  v_has_media := EXISTS (SELECT 1 FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = p_exercise_id);
  SELECT * INTO v_comp FROM app.exercise_completeness(
    v_ex.name, v_ex.name_en, v_ex.body_region_id, v_ex.instructions, v_ex.description, v_ex.key_cues,
    v_ex.safety_notes, v_ex.contraindications, v_ex.muscles, v_ex.start_position, v_ex.difficulty, v_has_media);

  v_plan_count := app._exercise_plan_usage(v_schema, p_exercise_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'protocol_id', x.protocol_id, 'name', x.name, 'is_clinic', x.is_clinic, 'phases', x.phases
    ) ORDER BY x.name), '[]'::jsonb)
  INTO v_protocols
  FROM (
    SELECT pr.id AS protocol_id, pr.name, pr.clinic_id IS NOT NULL AS is_clinic,
           jsonb_agg(DISTINCT pp.n) AS phases
    FROM app.protocol_phase_exercise ppe
    JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
    JOIN app.protocol pr ON pr.id = pp.protocol_id
    WHERE ppe.exercise_id = p_exercise_id AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
    GROUP BY pr.id, pr.name, pr.clinic_id
  ) x;

  v_can_edit_master := CASE WHEN v_ex.clinic_id IS NULL THEN v_is_curator ELSE true END;
  SELECT COALESCE(jsonb_agg(body_region_id), '[]'::jsonb) INTO v_secondary_regions
  FROM app.exercise_secondary_region WHERE exercise_id = p_exercise_id;

  RETURN jsonb_build_object(
    'id', v_ex.id, 'name', v_ex.name, 'name_en', v_ex.name_en, 'category', v_ex.category,
    'body_region_id', v_ex.body_region_id,
    'body_region', (SELECT jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
                    FROM app.body_region br WHERE br.id = v_ex.body_region_id),
    'secondary_region_ids', v_secondary_regions,
    'muscle_group', v_ex.muscle_group, 'muscles', to_jsonb(v_ex.muscles), 'equipment', to_jsonb(v_ex.equipment),
    'aliases', to_jsonb(v_ex.aliases), 'key_cues', to_jsonb(v_ex.key_cues),
    'description', v_ex.description, 'instructions', v_ex.instructions,
    'instruction_steps', to_jsonb(v_master.instruction_steps),
    'common_mistakes', v_ex.common_mistakes, 'safety_notes', v_ex.safety_notes,
    'contraindications', v_ex.contraindications,
    'start_position', v_ex.start_position, 'difficulty', v_ex.difficulty, 'is_bilateral', v_ex.is_bilateral,
    'item_kind', v_master.item_kind, 'weight_bearing', v_master.weight_bearing,
    'contraction_type', v_master.contraction_type, 'laterality', v_master.laterality,
    'default_prescription', COALESCE(v_master.default_prescription, '{}'::jsonb),
    'source', v_ex.source, 'external_ref', v_ex.external_ref,
    'is_clinic_owned', v_ex.clinic_id IS NOT NULL,
    'status', v_ex.status, 'reviewed_at', v_ex.reviewed_at,
    'reviewed_by_name', (SELECT u.name FROM app."user" u WHERE u.id = v_ex.reviewed_by AND u.clinic_id = v_clinic_id),
    'revision', v_ex.revision, 'override_revision', COALESCE(v_ex.override_revision, 0),
    'overridden_fields', COALESCE((SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(COALESCE(v_ex.override_fields, '{}'::jsonb)) k), '[]'::jsonb),
    -- master values of the overridable fields, so the editor can show "catalog
    -- version" next to a clinic version and offer a revert
    'master', CASE WHEN v_ex.clinic_id IS NULL THEN jsonb_build_object(
      'description', v_master.description, 'instructions', v_master.instructions,
      'key_cues', to_jsonb(v_master.key_cues), 'common_mistakes', v_master.common_mistakes,
      'safety_notes', v_master.safety_notes, 'contraindications', v_master.contraindications
    ) END,
    'completeness', v_comp.score, 'missing', to_jsonb(v_comp.missing),
    'permissions', jsonb_build_object(
      'is_curator', v_is_curator,
      'can_edit_master', v_can_edit_master,
      'can_edit_content', true,
      'can_change_status', v_can_edit_master,
      'can_delete', v_ex.clinic_id IS NOT NULL AND v_plan_count = 0 AND jsonb_array_length(v_protocols) = 0
    ),
    'usage', jsonb_build_object('protocols', v_protocols, 'active_plan_count', v_plan_count),
    'media', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'kind', m.kind, 'url', m.url, 'thumb_url', m.thumb_url,
        'width', m.width, 'height', m.height, 'duration_ms', m.duration_ms, 'order', m."order",
        'source_file', m.source_file, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
        'rights', m.rights, 'attribution', m.attribution, 'start_sec', m.start_sec, 'end_sec', m.end_sec,
        'review_note', m.review_note,
        'verified', m.verified_at IS NOT NULL, 'verified_at', m.verified_at,
        'scope', CASE WHEN m.clinic_id IS NULL THEN 'master' ELSE 'clinic' END,
        'can_manage', m.clinic_id = v_clinic_id OR (m.clinic_id IS NULL AND v_is_curator)
      ) ORDER BY (m.clinic_id IS NULL), m."order")
      FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = p_exercise_id
    ), '[]'::jsonb),
    'media_scope', CASE WHEN v_ex.clinic_id IS NULL AND v_is_curator THEN 'master' ELSE 'clinic' END,
    'created_at', v_ex.created_at, 'updated_at', v_ex.updated_at
  );
END;
$function$;

-- ============================================================================
-- catalog_set_status: tighten the approval gate. Existing approved rows are
-- untouched (this only guards the transition INTO 'approved'); a curator
-- approving a NEW/edited exercise from here on must give it the P0 content a
-- patient can act on safely. Requirements scale with item_kind: education
-- items don't need cues/dosage, programs don't need cues/media.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_set_status(p_clinician_id UUID, p_ids UUID[], p_status TEXT)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_curator BOOLEAN;
  v_row app.exercise;
  v_id UUID;
  v_updated INT := 0;
  v_skipped JSONB := '[]'::jsonb;
  v_missing TEXT[];
  v_has_media BOOLEAN;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_status NOT IN ('draft', 'in_review', 'approved', 'archived') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_status');
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_ids');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_ids) x) LOOP
    SELECT * INTO v_row FROM app.exercise
    WHERE id = v_id AND deleted_at IS NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
    FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found');
      CONTINUE;
    END IF;
    IF v_row.clinic_id IS NULL AND NOT v_is_curator THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'forbidden');
      CONTINUE;
    END IF;
    IF v_row.status = p_status THEN
      CONTINUE;
    END IF;

    IF p_status = 'approved' THEN
      v_missing := '{}';
      IF v_row.body_region_id IS NULL THEN v_missing := array_append(v_missing, 'body_region'); END IF;
      IF cardinality(v_row.instruction_steps) = 0 THEN v_missing := array_append(v_missing, 'instruction_steps'); END IF;
      IF v_row.item_kind = 'exercise' THEN
        IF cardinality(v_row.key_cues) = 0 THEN v_missing := array_append(v_missing, 'key_cues'); END IF;
        IF NULLIF(btrim(COALESCE(v_row.safety_notes, '')), '') IS NULL AND NULLIF(btrim(COALESCE(v_row.contraindications, '')), '') IS NULL THEN
          v_missing := array_append(v_missing, 'safety');
        END IF;
      END IF;
      IF v_row.item_kind IN ('exercise', 'program') AND NOT (v_row.default_prescription ? 'mode') THEN
        v_missing := array_append(v_missing, 'default_prescription');
      END IF;
      IF v_row.item_kind = 'exercise' THEN
        v_has_media := EXISTS (SELECT 1 FROM app.exercise_media WHERE exercise_id = v_id AND verified_at IS NOT NULL);
        IF NOT v_has_media THEN v_missing := array_append(v_missing, 'media'); END IF;
      END IF;
      IF cardinality(v_missing) > 0 THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'missing_required_fields', 'fields', to_jsonb(v_missing));
        CONTINUE;
      END IF;
    END IF;

    UPDATE app.exercise SET
      status = p_status,
      reviewed_by = CASE WHEN p_status = 'approved' THEN p_clinician_id ELSE reviewed_by END,
      reviewed_at = CASE WHEN p_status = 'approved' THEN now() ELSE reviewed_at END,
      revision = revision + 1,
      updated_at = now()
    WHERE id = v_id;

    INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
    VALUES (v_id, v_row.clinic_id, CASE WHEN v_row.clinic_id IS NULL THEN 'master' ELSE 'clinic' END, 'status',
            jsonb_build_object('status', jsonb_build_object('from', v_row.status, 'to', p_status)), p_clinician_id);
    v_updated := v_updated + 1;
  END LOOP;

  RETURN jsonb_build_object('updated', v_updated, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_save_exercise(UUID, UUID, JSONB, INT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_save_exercise(UUID, UUID, JSONB, INT, TEXT, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION app.catalog_set_status(UUID, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_set_status(UUID, UUID[], TEXT) TO authenticated, service_role;
