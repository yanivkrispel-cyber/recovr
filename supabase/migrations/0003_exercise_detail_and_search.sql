-- T-14 follow-up: make the ingested exercise library reachable from the plan
-- editor, and add an exercise-detail read.
--
-- 1. search_exercises: `phase` was a hard filter that matched only via protocol
--    associations, so every imported (and clinic-custom) exercise was invisible
--    whenever a phase was passed — which the plan editor always does. Phase is
--    now a relevance hint: protocol-phase matches sort first, everything else
--    still returns. Also gives the result a real row cap (the old LIMIT sat
--    outside the aggregate and never bound anything) and a `has_media` flag.
-- 2. exercise_filter_options: `regions` now includes every active exercise's
--    region (the imported library stores a body-part there), not just
--    clinic-custom ones, so the region option is actually selectable.
-- 3. get_exercise: full detail + media for the detail drawer. Cross-clinic id
--    returns not_found (rule 4: 404, never 403). Media rows carry their
--    verified state; nothing here changes the verified_at gate.

CREATE OR REPLACE FUNCTION app.search_exercises(
  p_clinician_id UUID,
  p_query TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_phase_n INT DEFAULT NULL,
  p_muscle TEXT DEFAULT NULL,
  p_protocol_slug TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  WITH matched AS (
    SELECT
      ex.id, ex.name, ex.name_en, ex.category, ex.region, ex.is_bilateral, ex.source,
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
        p_region IS NULL OR p_region = ''
        OR ex.region = p_region
        OR EXISTS (
          SELECT 1 FROM app.protocol_phase_exercise ppe
          JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
          JOIN app.protocol pr ON pr.id = pp.protocol_id
          WHERE ppe.exercise_id = ex.id AND (pr.region_en = p_region OR pr.region = p_region)
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
    ORDER BY phase_match DESC, ex.name
    LIMIT 300
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'name_en', name_en, 'category', category,
    'region', region, 'is_bilateral', is_bilateral, 'source', source,
    'protocol_labels', protocol_labels, 'prescription', prescription,
    'phase_match', phase_match, 'has_media', has_media
  ) ORDER BY phase_match DESC, name), '[]'::jsonb)
  INTO v_result
  FROM matched;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

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
    'regions', (
      SELECT COALESCE(jsonb_agg(DISTINCT region ORDER BY region), '[]'::jsonb)
      FROM (
        SELECT region_en AS region FROM app.protocol WHERE region_en IS NOT NULL
        UNION
        SELECT region FROM app.exercise
          WHERE is_active AND region IS NOT NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
      ) r
    ),
    'phases', (SELECT COALESCE(jsonb_agg(DISTINCT n ORDER BY n), '[]'::jsonb) FROM app.protocol_phase),
    'protocols', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', slug, 'name', name) ORDER BY name), '[]'::jsonb)
      FROM app.protocol WHERE is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- app.get_exercise(clinician_id, exercise_id) — GET /exercises/:id (T-14 detail).
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
    'region', ex.region,
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
  WHERE ex.id = p_exercise_id
    AND ex.is_active
    AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id);

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
