-- Fix: the exercise library header showed "300 exercises" because
-- search_exercises (0003) had a flat `LIMIT 300` with no way to see or reach
-- anything past it — the imported dataset alone has 1,324 rows. Replace the
-- cap with real pagination (limit/offset) and an accurate total, and give
-- the client a reliable total/custom count that isn't just "however many
-- rows happened to load".

CREATE OR REPLACE FUNCTION app.search_exercises(
  p_clinician_id UUID,
  p_query TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
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
  ),
  paged AS (
    SELECT * FROM matched ORDER BY phase_match DESC, name LIMIT v_limit OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM matched),
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'name_en', name_en, 'category', category,
      'region', region, 'is_bilateral', is_bilateral, 'source', source,
      'protocol_labels', protocol_labels, 'prescription', prescription,
      'phase_match', phase_match, 'has_media', has_media
    ) ORDER BY phase_match DESC, name), '[]'::jsonb)
  INTO v_total, v_items
  FROM paged;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- exercise_filter_options: add a clinic-wide custom-exercise count. The total
-- library count is already accurate from search_exercises's own `total` (it's
-- computed by the same WHERE clause), so only the count of clinic-custom
-- exercises — which the client can't otherwise get without loading every
-- page — needs to be added here.
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
    ),
    'custom_count', (SELECT count(*) FROM app.exercise WHERE is_active AND clinic_id = v_clinic_id)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
