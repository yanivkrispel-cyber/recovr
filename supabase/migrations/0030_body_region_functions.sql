-- T-28 continued — update every function that read or wrote the old
-- region/region_en free text to use app.body_region instead (see 0028/0029).
--
-- Functions whose parameter types/counts change use DROP FUNCTION IF EXISTS
-- first (CREATE OR REPLACE only replaces an identical signature — this
-- codebase already hit that bug once, see 0027's comment). Functions whose
-- signature is unchanged just get CREATE OR REPLACE.

-- ============================================================================
-- search_exercises: p_region TEXT -> p_body_region_id UUID. The "match via
-- any protocol this exercise appears in" fallback is kept (now an FK-equality
-- join instead of two OR'd TEXT columns) — that's what makes every
-- knee-variant protocol's exercises show up under one filter value now that
-- exercise and protocol share one FK'd vocabulary. This is the actual bug fix.
-- ============================================================================
DROP FUNCTION IF EXISTS app.search_exercises(UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION app.search_exercises(
  p_clinician_id UUID,
  p_query TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_body_region_id UUID DEFAULT NULL,
  p_phase_n INT DEFAULT NULL,
  p_muscle TEXT DEFAULT NULL,
  p_protocol_slug TEXT DEFAULT NULL,
  p_limit INT DEFAULT 60,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 60), 1), 200);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
  v_total INT;
  v_items JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  WITH matched AS (
    SELECT
      ex.id, ex.name, ex.name_en, ex.category, ex.is_bilateral, ex.source,
      br.id AS body_region_id, br.slug AS body_region_slug, br.name AS body_region_name, br.name_en AS body_region_name_en,
      COALESCE(protocols_agg.names, '[]'::jsonb) AS protocol_labels,
      rx_agg.rx AS prescription,
      (
        p_phase_n IS NOT NULL AND EXISTS (
          SELECT 1 FROM app.protocol_phase_exercise ppe
          JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
          WHERE ppe.exercise_id = ex.id AND pp.n = p_phase_n
        )
      ) AS phase_match,
      EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = ex.id) AS has_media
    FROM app.exercise ex
    LEFT JOIN app.body_region br ON br.id = ex.body_region_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(DISTINCT pr.name) AS names
      FROM app.protocol_phase_exercise ppe
      JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
      JOIN app.protocol pr ON pr.id = pp.protocol_id
      WHERE ppe.exercise_id = ex.id
    ) protocols_agg ON true
    LEFT JOIN LATERAL (
      -- Any one real prescription this exercise has actually been given in the
      -- protocol library — "as seen somewhere", not a curated default.
      SELECT ppe.prescription AS rx
      FROM app.protocol_phase_exercise ppe
      WHERE ppe.exercise_id = ex.id AND ppe.prescription IS NOT NULL AND ppe.prescription != '{}'::jsonb
      LIMIT 1
    ) rx_agg ON true
    WHERE ex.is_active
      AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
      AND (p_query IS NULL OR p_query = '' OR ex.name ILIKE '%' || p_query || '%' OR ex.name_en ILIKE '%' || p_query || '%')
      AND (p_category IS NULL OR p_category = '' OR ex.category = p_category)
      AND (p_muscle IS NULL OR p_muscle = '' OR ex.muscles @> ARRAY[p_muscle])
      AND (
        p_body_region_id IS NULL
        OR ex.body_region_id = p_body_region_id
        OR EXISTS (
          SELECT 1 FROM app.protocol_phase_exercise ppe
          JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
          JOIN app.protocol pr ON pr.id = pp.protocol_id
          WHERE ppe.exercise_id = ex.id AND pr.body_region_id = p_body_region_id
        )
      )
      AND (
        p_protocol_slug IS NULL OR p_protocol_slug = ''
        OR EXISTS (
          SELECT 1 FROM app.protocol_phase_exercise ppe
          JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
          JOIN app.protocol pr ON pr.id = pp.protocol_id
          WHERE ppe.exercise_id = ex.id AND pr.slug = p_protocol_slug
        )
      )
  ),
  paged AS (
    SELECT * FROM matched ORDER BY phase_match DESC, name LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM matched),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'name_en', name_en, 'category', category,
      'body_region', CASE WHEN body_region_id IS NOT NULL
        THEN jsonb_build_object('id', body_region_id, 'slug', body_region_slug, 'name', body_region_name, 'name_en', body_region_name_en)
        ELSE NULL END,
      'is_bilateral', is_bilateral, 'source', source,
      'protocol_labels', protocol_labels, 'prescription', prescription,
      'phase_match', phase_match, 'has_media', has_media
    ) ORDER BY phase_match DESC, name), '[]'::jsonb)
  INTO v_total, v_items
  FROM paged;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.search_exercises(UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, INT, INT) TO authenticated, service_role;

-- ============================================================================
-- exercise_filter_options: 'regions' (a data-dependent UNION of protocol.
-- region_en and clinic exercise.region text) -> 'body_regions', a fixed list
-- of all 9 canonical regions so a clinician can assign a region that has no
-- prior usage yet.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_filter_options(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  RETURN jsonb_build_object(
    'categories', (SELECT COALESCE(jsonb_agg(DISTINCT category ORDER BY category), '[]'::jsonb) FROM app.exercise WHERE is_active),
    'body_regions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'name_en', name_en) ORDER BY sort_order), '[]'::jsonb)
      FROM app.body_region
    ),
    'phases', (SELECT COALESCE(jsonb_agg(DISTINCT n ORDER BY n), '[]'::jsonb) FROM app.protocol_phase),
    'protocols', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', slug, 'name', name) ORDER BY name), '[]'::jsonb)
      FROM app.protocol WHERE is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
    ),
    'custom_count', (SELECT count(*) FROM app.exercise WHERE is_active AND clinic_id = v_clinic_id)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================================
-- create_custom_exercise / update_custom_exercise: p_region TEXT -> p_body_region_id UUID.
-- ============================================================================
DROP FUNCTION IF EXISTS app.create_custom_exercise(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION app.create_custom_exercise(
  p_clinician_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_category TEXT,
  p_body_region_id UUID,
  p_description TEXT,
  p_instructions TEXT,
  p_is_bilateral BOOLEAN
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_exercise_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF p_category NOT IN ('Mobility', 'Strength', 'Balance', 'Control', 'Cardio') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_category');
  END IF;

  IF p_body_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = p_body_region_id) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  INSERT INTO app.exercise (clinic_id, name, name_en, category, body_region_id, description, instructions, is_bilateral, source)
  VALUES (v_clinic_id, p_name, p_name_en, p_category, p_body_region_id, p_description, p_instructions, COALESCE(p_is_bilateral, false), 'clinic')
  RETURNING id INTO v_exercise_id;

  RETURN jsonb_build_object('ok', true, 'id', v_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.create_custom_exercise(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

DROP FUNCTION IF EXISTS app.update_custom_exercise(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION app.update_custom_exercise(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_category TEXT,
  p_body_region_id UUID,
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

  IF p_body_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = p_body_region_id) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  UPDATE app.exercise
  SET name = p_name, name_en = p_name_en, category = p_category, body_region_id = p_body_region_id,
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

REVOKE ALL ON FUNCTION app.update_custom_exercise(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_custom_exercise(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

-- ============================================================================
-- duplicate_exercise: no signature change — copies body_region_id/muscle_group
-- instead of region.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.duplicate_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_new_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  INSERT INTO app.exercise (
    clinic_id, name, name_en, category, body_region_id, muscle_group, muscles, equipment,
    description, instructions, common_mistakes, safety_notes, is_bilateral, source
  )
  SELECT
    v_clinic_id, name || ' (עותק)', name_en, category, body_region_id, muscle_group, muscles, equipment,
    description, instructions, common_mistakes, safety_notes, is_bilateral, 'clinic'
  FROM app.exercise
  WHERE id = p_exercise_id AND is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
  RETURNING id INTO v_new_id;

  IF v_new_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- get_exercise: no signature change — 'region' -> joined 'body_region' object,
-- plus 'muscle_group'.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.get_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'id', ex.id, 'name', ex.name, 'name_en', ex.name_en, 'category', ex.category,
    'body_region', CASE WHEN br.id IS NOT NULL
      THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
      ELSE NULL END,
    'muscle_group', ex.muscle_group,
    'muscles', COALESCE(to_jsonb(ex.muscles), '[]'::jsonb),
    'equipment', COALESCE(to_jsonb(ex.equipment), '[]'::jsonb),
    'description', ex.description, 'instructions', ex.instructions,
    'common_mistakes', ex.common_mistakes, 'safety_notes', ex.safety_notes,
    'default_prescription', ex.default_prescription,
    'is_bilateral', ex.is_bilateral, 'source', ex.source, 'external_ref', ex.external_ref,
    'protocol_labels', COALESCE((
      SELECT jsonb_agg(DISTINCT pr.name)
      FROM app.protocol_phase_exercise ppe
      JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
      JOIN app.protocol pr ON pr.id = pp.protocol_id
      WHERE ppe.exercise_id = ex.id
    ), '[]'::jsonb),
    'media', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'kind', m.kind, 'url', m.url, 'thumb_url', m.thumb_url,
        'width', m.width, 'height', m.height, 'duration_ms', m.duration_ms,
        'order', m."order", 'source_file', m.source_file,
        'verified', m.verified_at IS NOT NULL, 'verified_at', m.verified_at
      ) ORDER BY m."order")
      FROM app.exercise_media m WHERE m.exercise_id = ex.id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM app.exercise ex
  LEFT JOIN app.body_region br ON br.id = ex.body_region_id
  WHERE ex.id = p_exercise_id
    AND ex.is_active
    AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id);

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================================
-- protocol_detail / protocol_library: no signature change — 'region'/
-- 'region_en' -> joined 'body_region' object + 'region_detail'/'region_detail_en'.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.protocol_detail(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'body_region', CASE WHEN br.id IS NOT NULL
      THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
      ELSE NULL END,
    'region_detail', pr.region_detail, 'region_detail_en', pr.region_detail_en,
    'source', pr.source,
    'version', pr.version, 'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'phases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'n', pp.n, 'name', pp.name, 'name_en', pp.name_en,
        'duration_days', pp.duration_days, 'goals', pp.goals,
        'exercises', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'exercise_id', ppe.exercise_id, 'name', e.name, 'name_en', e.name_en,
            'prescription', ppe.prescription, 'frequency', ppe.frequency,
            'order', ppe."order", 'notes', ppe.notes
          ) ORDER BY ppe."order")
          FROM app.protocol_phase_exercise ppe
          JOIN app.exercise e ON e.id = ppe.exercise_id
          WHERE ppe.protocol_phase_id = pp.id
        ), '[]'::jsonb),
        'criteria', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'type', c.type, 'label', c.label, 'label_en', c.label_en,
            'operator', c.operator, 'value', c.value, 'unit', c.unit, 'order', c."order"
          ) ORDER BY c."order")
          FROM app.protocol_phase_criterion c
          WHERE c.protocol_phase_id = pp.id
        ), '[]'::jsonb)
      ) ORDER BY pp.n)
      FROM app.protocol_phase pp WHERE pp.protocol_id = pr.id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM app.protocol pr
  LEFT JOIN app.body_region br ON br.id = pr.body_region_id
  WHERE pr.id = p_protocol_id AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL);

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION app.protocol_library(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', pr.id, 'slug', pr.slug, 'name', pr.name, 'name_en', pr.name_en,
    'body_region', CASE WHEN br.id IS NOT NULL
      THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
      ELSE NULL END,
    'source', pr.source, 'version', pr.version,
    'is_active', pr.is_active,
    'is_editable', (pr.source = 'clinic' AND pr.clinic_id = v_clinic_id),
    'phase_count', (SELECT count(*) FROM app.protocol_phase pp WHERE pp.protocol_id = pr.id),
    'updated_at', pr.updated_at
  ) ORDER BY pr.is_active DESC, pr.name), '[]'::jsonb)
  INTO v_result
  FROM app.protocol pr
  LEFT JOIN app.body_region br ON br.id = pr.body_region_id
  WHERE pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================================
-- protocol_create / protocol_update: (p_region, p_region_en) TEXT pair ->
-- (p_body_region_id UUID, p_region_detail TEXT, p_region_detail_en TEXT).
-- ============================================================================
DROP FUNCTION IF EXISTS app.protocol_create(UUID, TEXT, TEXT, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION app.protocol_create(
  p_clinician_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_body_region_id UUID,
  p_region_detail TEXT,
  p_region_detail_en TEXT,
  p_phases JSONB
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_base_slug TEXT;
  v_slug TEXT;
  v_suffix INT := 1;
  v_protocol_id UUID;
  v_phase_error JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required');
  END IF;

  IF p_body_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = p_body_region_id) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  v_phase_error := app._protocol_validate_phases(v_clinic_id, p_phases);
  IF v_phase_error IS NOT NULL THEN
    RETURN v_phase_error;
  END IF;

  v_base_slug := lower(regexp_replace(COALESCE(NULLIF(btrim(p_name_en), ''), p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_base_slug := btrim(v_base_slug, '-');
  IF v_base_slug IS NULL OR v_base_slug = '' THEN
    v_base_slug := 'protocol';
  END IF;
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM app.protocol WHERE clinic_id = v_clinic_id AND slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, body_region_id, region_detail, region_detail_en, source, version, is_active)
  VALUES (v_clinic_id, v_slug, btrim(p_name), NULLIF(btrim(p_name_en), ''), p_body_region_id, NULLIF(btrim(p_region_detail), ''), NULLIF(btrim(p_region_detail_en), ''), 'clinic', '1.0', true)
  RETURNING id INTO v_protocol_id;

  PERFORM app._protocol_insert_phases(v_protocol_id, p_phases);

  RETURN jsonb_build_object('ok', true, 'id', v_protocol_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.protocol_create(UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.protocol_create(UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

DROP FUNCTION IF EXISTS app.protocol_update(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION app.protocol_update(
  p_clinician_id UUID,
  p_protocol_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_body_region_id UUID,
  p_region_detail TEXT,
  p_region_detail_en TEXT,
  p_phases JSONB
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_source TEXT;
  v_owner_clinic_id UUID;
  v_old_version TEXT;
  v_new_version TEXT;
  v_phase_error JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT source, clinic_id, version INTO v_source, v_owner_clinic_id, v_old_version
  FROM app.protocol WHERE id = p_protocol_id;

  IF v_source IS NULL OR (v_owner_clinic_id IS NOT NULL AND v_owner_clinic_id != v_clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_source != 'clinic' OR v_owner_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'name_required');
  END IF;

  IF p_body_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = p_body_region_id) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region');
  END IF;

  v_phase_error := app._protocol_validate_phases(v_clinic_id, p_phases);
  IF v_phase_error IS NOT NULL THEN
    RETURN v_phase_error;
  END IF;

  BEGIN
    v_new_version := (COALESCE(v_old_version, '1.0')::numeric + 0.1)::text;
  EXCEPTION WHEN OTHERS THEN
    v_new_version := '1.1';
  END;

  UPDATE app.protocol
  SET name = btrim(p_name), name_en = NULLIF(btrim(p_name_en), ''),
      body_region_id = p_body_region_id,
      region_detail = NULLIF(btrim(p_region_detail), ''), region_detail_en = NULLIF(btrim(p_region_detail_en), ''),
      version = v_new_version, updated_at = now()
  WHERE id = p_protocol_id;

  DELETE FROM app.protocol_phase WHERE protocol_id = p_protocol_id;
  PERFORM app._protocol_insert_phases(p_protocol_id, p_phases);

  RETURN jsonb_build_object('ok', true, 'id', p_protocol_id, 'version', v_new_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.protocol_update(UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

-- ============================================================================
-- protocol_duplicate: no signature change — copies body_region_id/
-- region_detail/region_detail_en instead of region/region_en.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.protocol_duplicate(p_clinician_id UUID, p_protocol_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_src RECORD;
  v_base_slug TEXT;
  v_slug TEXT;
  v_suffix INT := 1;
  v_new_id UUID;
  v_src_phase RECORD;
  v_new_phase_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_src FROM app.protocol
  WHERE id = p_protocol_id AND is_active AND (clinic_id = v_clinic_id OR clinic_id IS NULL);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_base_slug := v_src.slug || '-copy';
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM app.protocol WHERE clinic_id = v_clinic_id AND slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  END LOOP;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, body_region_id, region_detail, region_detail_en, source, version, is_active)
  VALUES (v_clinic_id, v_slug, v_src.name || ' (עותק)', v_src.name_en, v_src.body_region_id, v_src.region_detail, v_src.region_detail_en, 'clinic', '1.0', true)
  RETURNING id INTO v_new_id;

  FOR v_src_phase IN SELECT * FROM app.protocol_phase WHERE protocol_id = v_src.id ORDER BY n LOOP
    INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, goals, "order")
    VALUES (v_new_id, v_src_phase.n, v_src_phase.name, v_src_phase.name_en, v_src_phase.duration_days, v_src_phase.goals, v_src_phase."order")
    RETURNING id INTO v_new_phase_id;

    INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, frequency, "order", notes)
    SELECT v_new_phase_id, exercise_id, prescription, frequency, "order", notes
    FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_src_phase.id;

    INSERT INTO app.protocol_phase_criterion (protocol_phase_id, type, label, label_en, operator, value, unit, "order")
    SELECT v_new_phase_id, type, label, label_en, operator, value, unit, "order"
    FROM app.protocol_phase_criterion WHERE protocol_phase_id = v_src_phase.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- protocol_options (add-patient wizard): no signature change — 'region' ->
-- joined 'body_region' object.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.protocol_options(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id UUID;
  v_result    JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(p ORDER BY p->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', pr.id,
      'slug', pr.slug,
      'name', pr.name,
      'name_en', pr.name_en,
      'body_region', CASE WHEN br.id IS NOT NULL
        THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
        ELSE NULL END,
      'phases', (
        SELECT COALESCE(jsonb_agg(ph ORDER BY (ph->>'n')::int), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'n', pp.n,
            'name', pp.name,
            'name_en', pp.name_en,
            'duration_days', pp.duration_days,
            'exercises', (
              SELECT COALESCE(jsonb_agg(ex ORDER BY (ex->>'order')::int), '[]'::jsonb)
              FROM (
                SELECT jsonb_build_object(
                  'exercise_id', ppe.exercise_id,
                  'name', e.name,
                  'name_en', e.name_en,
                  'order', ppe."order",
                  'prescription', ppe.prescription
                ) AS ex
                FROM app.protocol_phase_exercise ppe
                JOIN app.exercise e ON e.id = ppe.exercise_id
                WHERE ppe.protocol_phase_id = pp.id
              ) exq
            )
          ) AS ph
          FROM app.protocol_phase pp
          WHERE pp.protocol_id = pr.id
        ) phq
      )
    ) AS p
    FROM app.protocol pr
    LEFT JOIN app.body_region br ON br.id = pr.body_region_id
    WHERE pr.is_active
      AND pr.is_template
      AND (pr.clinic_id = v_clinic_id OR pr.clinic_id IS NULL)
  ) pq;

  RETURN v_result;
END;
$fn$;
