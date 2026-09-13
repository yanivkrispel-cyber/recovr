-- T-30 — Exercise catalog governance (foundation).
--
-- The exercise library becomes a governed catalog (product owner, 2026-09-13):
--
--   * Hybrid ownership. System rows (clinic_id NULL) are the platform master
--     catalog, edited directly — for every clinic — only by catalog curators
--     (app.catalog_curator, a platform-level grant, not a clinic role). A
--     clinic keeps its own version of the patient-facing content fields of a
--     system exercise in app.exercise_override; everything else follows the
--     master, so later master improvements still reach that clinic. This
--     replaces the old "Edit silently forks a private copy" flow. Clinic-owned
--     exercises stay fully editable by their clinic.
--   * Lifecycle status: draft -> in_review -> approved -> archived. Only
--     approved exercises are offered by the picker (search / recommend /
--     recent). Existing protocol and plan references are never broken by a
--     status — status gates *choosing* an exercise, not showing one already
--     chosen.
--   * New catalog fields: aliases, key_cues, start_position, difficulty,
--     contraindications; revision (optimistic concurrency for autosave);
--     curated_at (protects curated rows from dataset re-ingest).
--   * app.exercise_revision: append-only change history (field-level from/to)
--     with restore.
--   * Completeness score (app.exercise_completeness, mirrored by
--     packages/shared/src/exerciseCatalog.ts).
--   * app.catalog_search: one query for the library workspace — typo-tolerant
--     Hebrew/English/alias search, facet counts, completeness, saved-view
--     filters.
--
-- Grandfathering: exercises already used by a protocol or a patient plan start
-- as approved (app.catalog_backfill_governance, also called at the end of
-- seed.sql because seeds run after migrations), and an exercise used only by
-- protocols of a single body region inherits that region.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- ============================================================================
-- Tables & columns
-- ============================================================================
CREATE TABLE app.catalog_curator (
  user_id     UUID PRIMARY KEY REFERENCES app."user"(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);

ALTER TABLE app.exercise
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
  ADD COLUMN reviewed_by UUID REFERENCES app."user"(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN key_cues TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN start_position TEXT
    CHECK (start_position IN ('standing', 'sitting', 'supine', 'prone', 'side_lying', 'quadruped', 'kneeling', 'other')),
  ADD COLUMN difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 3),
  ADD COLUMN contraindications TEXT,
  ADD COLUMN revision INT NOT NULL DEFAULT 0,
  ADD COLUMN curated_at TIMESTAMPTZ;

CREATE INDEX app_exercise_status_idx ON app.exercise(status);
CREATE INDEX app_exercise_name_trgm_idx ON app.exercise USING gin (name extensions.gin_trgm_ops);
CREATE INDEX app_exercise_name_en_trgm_idx ON app.exercise USING gin (name_en extensions.gin_trgm_ops);

-- A clinic's own version of a system exercise's patient-facing content.
-- `fields` holds only the overridden keys (see app.exercise_effective); a key
-- whose value equals the master is removed rather than stored.
CREATE TABLE app.exercise_override (
  clinic_id    UUID NOT NULL REFERENCES app.clinic(id) ON DELETE CASCADE,
  exercise_id  UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  fields       JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision     INT NOT NULL DEFAULT 0,
  updated_by   UUID REFERENCES app."user"(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, exercise_id)
);

-- Append-only. clinic_id NULL = a master-catalog change (visible to every
-- clinic); otherwise the owning clinic of a clinic exercise or override.
CREATE TABLE app.exercise_revision (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id  UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  clinic_id    UUID REFERENCES app.clinic(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('master', 'clinic', 'override')),
  action       TEXT NOT NULL CHECK (action IN ('create', 'update', 'status', 'revert', 'restore', 'duplicate')),
  changes      JSONB NOT NULL,  -- {field: {"from": <json>, "to": <json>}}
  changed_by   UUID REFERENCES app."user"(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX exercise_revision_exercise_idx ON app.exercise_revision(exercise_id, changed_at DESC);

-- ============================================================================
-- Field registry helpers
-- ============================================================================
CREATE OR REPLACE FUNCTION app._catalog_text_fields() RETURNS TEXT[] AS $$
  SELECT ARRAY['name', 'name_en', 'description', 'instructions', 'common_mistakes', 'safety_notes', 'contraindications'];
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION app._catalog_array_fields() RETURNS TEXT[] AS $$
  SELECT ARRAY['aliases', 'key_cues', 'muscles', 'equipment'];
$$ LANGUAGE sql IMMUTABLE;

-- The fields a clinic may keep its own version of on a system exercise.
CREATE OR REPLACE FUNCTION app._catalog_content_fields() RETURNS TEXT[] AS $$
  SELECT ARRAY['description', 'instructions', 'key_cues', 'common_mistakes', 'safety_notes', 'contraindications'];
$$ LANGUAGE sql IMMUTABLE;

-- A field's value from a to_jsonb(app.exercise) row, in the same JSON shape a
-- normalized patch uses (arrays never NULL) so values compare directly.
CREATE OR REPLACE FUNCTION app._catalog_field_value(p_row JSONB, p_key TEXT) RETURNS JSONB AS $$
  SELECT CASE
    WHEN p_key = ANY(app._catalog_array_fields()) THEN COALESCE(NULLIF(p_row -> p_key, 'null'::jsonb), '[]'::jsonb)
    ELSE COALESCE(p_row -> p_key, 'null'::jsonb)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Validates and normalizes an edit patch. Returns {patch: {...}} or an error
-- object. Text is trimmed ('' -> null); arrays are trimmed, de-duplicated
-- (case-insensitively, first occurrence wins, order kept) and capped.
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
        SELECT COALESCE(array_agg(x ORDER BY ord), '{}') INTO v_items
        FROM (
          SELECT DISTINCT ON (lower(x)) x, ord
          FROM (SELECT btrim(e) AS x, ord FROM jsonb_array_elements_text(v_val) WITH ORDINALITY t(e, ord)) s
          WHERE x <> ''
          ORDER BY lower(x), ord
        ) d;
      END IF;
      IF cardinality(v_items) > 40 OR EXISTS (SELECT 1 FROM unnest(v_items) x WHERE length(x) > 300) THEN
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

    ELSE
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'unknown_field', 'field', v_key);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('patch', v_out);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Actor / tenancy helpers
-- ============================================================================
CREATE OR REPLACE FUNCTION app.is_catalog_curator(p_user_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM app.catalog_curator WHERE user_id = p_user_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.is_catalog_curator(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.clinic_id_for_schema(p_schema TEXT) RETURNS UUID AS $$
  SELECT id FROM app.clinic WHERE 'clinic_' || slug = p_schema;
$$ LANGUAGE sql STABLE;

-- Number of patients whose *current* plan uses the exercise, in one clinic schema.
CREATE OR REPLACE FUNCTION app._exercise_plan_usage(p_schema TEXT, p_exercise_id UUID)
RETURNS INT AS $$
DECLARE
  v_count INT;
BEGIN
  IF p_schema IS NULL OR to_regclass(format('%I.plan_exercise', p_schema)) IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE format(
    'SELECT count(DISTINCT pv.plan_id)::int
       FROM %1$I.plan_exercise pe
       JOIN %1$I.plan_phase pp ON pp.id = pe.plan_phase_id
       JOIN %1$I.plan_version pv ON pv.id = pp.plan_version_id AND pv.is_current
      WHERE pe.exercise_id = $1 AND pe.deleted_at IS NULL', p_schema)
  INTO v_count USING p_exercise_id;
  RETURN COALESCE(v_count, 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app._exercise_plan_usage(TEXT, UUID) FROM PUBLIC;

-- ============================================================================
-- exercise_effective: every exercise a clinic can see, with that clinic's
-- content overrides merged in. Plain (inlinable) SQL — callers apply their
-- own is_active / status predicates.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_effective(p_clinic_id UUID)
RETURNS TABLE (
  id UUID, clinic_id UUID, name TEXT, name_en TEXT, category TEXT, body_region_id UUID,
  muscle_group TEXT, muscles TEXT[], equipment TEXT[], aliases TEXT[], key_cues TEXT[],
  description TEXT, instructions TEXT, common_mistakes TEXT, safety_notes TEXT, contraindications TEXT,
  start_position TEXT, difficulty SMALLINT, is_bilateral BOOLEAN, default_prescription JSONB,
  source TEXT, external_ref TEXT, status TEXT, reviewed_by UUID, reviewed_at TIMESTAMPTZ,
  revision INT, override_revision INT, override_fields JSONB,
  is_active BOOLEAN, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
) AS $$
  SELECT
    ex.id, ex.clinic_id, ex.name, ex.name_en, ex.category, ex.body_region_id,
    ex.muscle_group, COALESCE(ex.muscles, '{}'), COALESCE(ex.equipment, '{}'), ex.aliases,
    CASE WHEN ov.fields ? 'key_cues'
      THEN ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(ov.fields -> 'key_cues', 'null'::jsonb), '[]'::jsonb)))
      ELSE ex.key_cues END,
    CASE WHEN ov.fields ? 'description' THEN ov.fields ->> 'description' ELSE ex.description END,
    CASE WHEN ov.fields ? 'instructions' THEN ov.fields ->> 'instructions' ELSE ex.instructions END,
    CASE WHEN ov.fields ? 'common_mistakes' THEN ov.fields ->> 'common_mistakes' ELSE ex.common_mistakes END,
    CASE WHEN ov.fields ? 'safety_notes' THEN ov.fields ->> 'safety_notes' ELSE ex.safety_notes END,
    CASE WHEN ov.fields ? 'contraindications' THEN ov.fields ->> 'contraindications' ELSE ex.contraindications END,
    ex.start_position, ex.difficulty, ex.is_bilateral, ex.default_prescription,
    ex.source, ex.external_ref, ex.status, ex.reviewed_by, ex.reviewed_at,
    ex.revision, ov.revision, ov.fields,
    ex.is_active, ex.deleted_at, ex.created_at, GREATEST(ex.updated_at, ov.updated_at)
  FROM app.exercise ex
  LEFT JOIN app.exercise_override ov
    ON ov.exercise_id = ex.id AND ov.clinic_id = p_clinic_id AND ex.clinic_id IS NULL
  WHERE ex.clinic_id IS NULL OR ex.clinic_id = p_clinic_id;
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- exercise_completeness — mirrored by packages/shared/src/exerciseCatalog.ts
-- (keys, order and scoring must match).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_completeness(
  p_name TEXT, p_name_en TEXT, p_body_region_id UUID, p_instructions TEXT, p_description TEXT,
  p_key_cues TEXT[], p_safety_notes TEXT, p_contraindications TEXT, p_muscles TEXT[],
  p_position TEXT, p_difficulty SMALLINT, p_has_media BOOLEAN
) RETURNS TABLE (score INT, missing TEXT[]) AS $$
  SELECT (round(100.0 * (11 - COALESCE(cardinality(m), 0)) / 11))::int, m
  FROM (
    SELECT array_remove(ARRAY[
      CASE WHEN COALESCE(p_name, '') !~ '[א-ת]' THEN 'name_he' END,
      CASE WHEN NULLIF(btrim(p_name_en), '') IS NULL THEN 'name_en' END,
      CASE WHEN p_body_region_id IS NULL THEN 'body_region' END,
      CASE WHEN COALESCE(p_instructions, '') !~ '[א-ת]' THEN 'instructions_he' END,
      CASE WHEN NULLIF(btrim(p_description), '') IS NULL THEN 'description' END,
      CASE WHEN COALESCE(cardinality(p_key_cues), 0) = 0 THEN 'key_cues' END,
      CASE WHEN NULLIF(btrim(p_safety_notes), '') IS NULL AND NULLIF(btrim(p_contraindications), '') IS NULL THEN 'safety' END,
      CASE WHEN COALESCE(cardinality(p_muscles), 0) = 0 THEN 'muscles' END,
      CASE WHEN p_position IS NULL THEN 'start_position' END,
      CASE WHEN p_difficulty IS NULL THEN 'difficulty' END,
      CASE WHEN NOT COALESCE(p_has_media, false) THEN 'media' END
    ], NULL) AS m
  ) s;
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================================
-- catalog_search
--
-- p_filters: {q, body_region_id, category, status, equipment, start_position,
--             source ('system'|'clinic'|'override'), media ('with'|'without'),
--             missing (a completeness key), protocol (slug),
--             sort ('relevance'|'name'|'updated'|'completeness')}
-- Archived exercises are excluded unless status = 'archived' is asked for.
-- Facet counts for a dimension apply every *other* active filter, so a
-- facet always shows what selecting one of its values would return.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_search(
  p_clinician_id UUID,
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_limit INT DEFAULT 60,
  p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_filters JSONB := COALESCE(p_filters, '{}'::jsonb);
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 60), 1), 200);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
  v_q TEXT := NULLIF(btrim(v_filters ->> 'q'), '');
  v_q_like TEXT;
  v_q_prefix TEXT;
  v_tokens TEXT[];
  v_q_words TEXT[];
  v_region UUID;
  v_category TEXT := NULLIF(v_filters ->> 'category', '');
  v_status TEXT := NULLIF(v_filters ->> 'status', '');
  v_equipment TEXT := NULLIF(v_filters ->> 'equipment', '');
  v_position TEXT := NULLIF(v_filters ->> 'start_position', '');
  v_source TEXT := NULLIF(v_filters ->> 'source', '');
  v_media TEXT := NULLIF(v_filters ->> 'media', '');
  v_missing TEXT := NULLIF(v_filters ->> 'missing', '');
  v_protocol TEXT := NULLIF(v_filters ->> 'protocol', '');
  v_sort TEXT := COALESCE(NULLIF(v_filters ->> 'sort', ''), CASE WHEN NULLIF(btrim(v_filters ->> 'q'), '') IS NULL THEN 'name' ELSE 'relevance' END);
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  BEGIN
    v_region := NULLIF(v_filters ->> 'body_region_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region_id');
  END;

  IF v_q IS NOT NULL THEN
    v_q := left(v_q, 120);
    v_q_prefix := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_q_like := '%' || v_q_prefix;
    v_tokens := ARRAY(
      SELECT '%' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      FROM regexp_split_to_table(v_q, '\s+') tok WHERE tok <> ''
    );
    v_q_words := ARRAY(SELECT lower(tok) FROM regexp_split_to_table(v_q, '\s+') tok WHERE tok <> '' LIMIT 8);
  END IF;

  WITH base AS (
    SELECT
      e.*,
      md.thumb_path, md.gif_path, COALESCE(md.verified, false) AS media_verified,
      (md.thumb_path IS NOT NULL OR EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = e.id)) AS has_media,
      (e.clinic_id IS NULL AND COALESCE(e.override_fields, '{}'::jsonb) <> '{}'::jsonb) AS has_override,
      CASE
        WHEN v_q IS NULL THEN 0
        WHEN lower(e.name) = lower(v_q) OR lower(COALESCE(e.name_en, '')) = lower(v_q) THEN 100
        WHEN e.name ILIKE v_q_prefix ESCAPE '\' OR COALESCE(e.name_en, '') ILIKE v_q_prefix ESCAPE '\' THEN 85
        WHEN e.name ILIKE v_q_like ESCAPE '\' OR COALESCE(e.name_en, '') ILIKE v_q_like ESCAPE '\' THEN 70
        WHEN EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE a ILIKE v_q_like ESCAPE '\') THEN 60
        WHEN NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) t
          WHERE (e.name || ' ' || COALESCE(e.name_en, '') || ' ' || array_to_string(e.aliases, ' ')) NOT ILIKE t ESCAPE '\'
        ) THEN 55
        WHEN array_to_string(e.muscles, ' ') ILIKE v_q_like ESCAPE '\'
          OR array_to_string(e.equipment, ' ') ILIKE v_q_like ESCAPE '\' THEN 35
        -- typo tolerance: every query word is a prefix of, or within edit
        -- distance 1 (4 letters) / 2 (5+ letters) of, some word of the names
        -- or aliases — "sqaut" finds "squat", "extnsion" finds "extension"
        WHEN NOT EXISTS (
          SELECT 1 FROM unnest(v_q_words) qw
          WHERE NOT EXISTS (
            SELECT 1
            FROM regexp_split_to_table(lower(e.name || ' ' || COALESCE(e.name_en, '') || ' ' || array_to_string(e.aliases, ' ')), '[^[:alnum:]]+') w
            WHERE w <> '' AND (
              left(w, length(qw)) = qw
              OR (length(qw) >= 4 AND extensions.levenshtein_less_equal(qw, w, 2) <= CASE WHEN length(qw) >= 5 THEN 2 ELSE 1 END)
            )
          )
        ) THEN 25
        ELSE 0
      END AS relevance
    FROM app.exercise_effective(v_clinic_id) e
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN m.kind = 'gif' THEN COALESCE(m.thumb_url, m.url) ELSE m.url END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media m
      WHERE m.exercise_id = e.id AND m.kind IN ('gif', 'image')
      ORDER BY (m.kind = 'gif') DESC, m."order"
      LIMIT 1
    ) md ON true
    WHERE e.is_active AND e.deleted_at IS NULL
  ),
  scored AS (
    SELECT b.*, c.score AS completeness, c.missing
    FROM base b
    CROSS JOIN LATERAL app.exercise_completeness(
      b.name, b.name_en, b.body_region_id, b.instructions, b.description, b.key_cues,
      b.safety_notes, b.contraindications, b.muscles, b.start_position, b.difficulty, b.has_media
    ) c
    WHERE v_q IS NULL OR b.relevance > 0
  ),
  flags AS (
    SELECT s.*,
      (v_region IS NULL OR s.body_region_id = v_region) AS f_region,
      (v_category IS NULL OR s.category = v_category) AS f_category,
      (CASE WHEN v_status IS NULL THEN s.status <> 'archived' ELSE s.status = v_status END) AS f_status,
      (v_equipment IS NULL OR s.equipment @> ARRAY[v_equipment]) AS f_equipment,
      (v_position IS NULL OR s.start_position = v_position) AS f_position,
      (v_source IS NULL
        OR (v_source = 'system' AND s.clinic_id IS NULL)
        OR (v_source = 'clinic' AND s.clinic_id IS NOT NULL)
        OR (v_source = 'override' AND s.has_override)) AS f_source,
      (v_media IS NULL OR (v_media = 'with') = s.has_media) AS f_media,
      (v_missing IS NULL OR v_missing = ANY(s.missing)) AS f_missing,
      (v_protocol IS NULL OR EXISTS (
        SELECT 1 FROM app.protocol_phase_exercise ppe
        JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
        JOIN app.protocol pr ON pr.id = pp.protocol_id
        WHERE ppe.exercise_id = s.id AND pr.slug = v_protocol
          AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
      )) AS f_protocol
    FROM scored s
  ),
  matched AS (
    SELECT * FROM flags
    WHERE f_region AND f_category AND f_status AND f_equipment AND f_position
      AND f_source AND f_media AND f_missing AND f_protocol
  ),
  paged AS (
    SELECT m.*, row_number() OVER (
      ORDER BY
        CASE WHEN v_sort = 'relevance' THEN m.relevance END DESC NULLS LAST,
        CASE WHEN v_sort = 'updated' THEN m.updated_at END DESC NULLS LAST,
        CASE WHEN v_sort = 'completeness' THEN m.completeness END ASC NULLS LAST,
        m.name, m.id
    ) AS ord
    FROM matched m
    ORDER BY ord
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matched),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'name_en', p.name_en, 'category', p.category,
        'body_region', CASE WHEN br.id IS NOT NULL
          THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
          ELSE NULL END,
        'status', p.status, 'source', p.source, 'is_clinic_owned', p.clinic_id IS NOT NULL,
        'has_override', p.has_override,
        'start_position', p.start_position, 'difficulty', p.difficulty, 'is_bilateral', p.is_bilateral,
        'equipment', to_jsonb(p.equipment), 'muscle_group', p.muscle_group,
        'completeness', p.completeness, 'missing', to_jsonb(p.missing),
        'revision', p.revision, 'updated_at', p.updated_at,
        'thumb_path', p.thumb_path, 'gif_path', p.gif_path, 'media_verified', p.media_verified,
        'protocol_count', (
          SELECT count(DISTINCT pr.id) FROM app.protocol_phase_exercise ppe
          JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
          JOIN app.protocol pr ON pr.id = pp.protocol_id
          WHERE ppe.exercise_id = p.id AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
        )
      ) ORDER BY p.ord)
      FROM paged p
      LEFT JOIN app.body_region br ON br.id = p.body_region_id
    ), '[]'::jsonb),
    'facets', jsonb_build_object(
      'body_region', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC)
        FROM (SELECT body_region_id::text AS v, count(*) AS c FROM flags
              WHERE f_category AND f_status AND f_equipment AND f_position AND f_source AND f_media AND f_missing AND f_protocol
                AND body_region_id IS NOT NULL
              GROUP BY 1) x), '[]'::jsonb),
      'category', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC)
        FROM (SELECT category AS v, count(*) AS c FROM flags
              WHERE f_region AND f_status AND f_equipment AND f_position AND f_source AND f_media AND f_missing AND f_protocol
              GROUP BY 1) x), '[]'::jsonb),
      'status', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC)
        FROM (SELECT status AS v, count(*) AS c FROM flags
              WHERE f_region AND f_category AND f_equipment AND f_position AND f_source AND f_media AND f_missing AND f_protocol
              GROUP BY 1) x), '[]'::jsonb),
      'equipment', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC, v)
        FROM (SELECT eq AS v, count(*) AS c FROM flags, unnest(equipment) eq
              WHERE f_region AND f_category AND f_status AND f_position AND f_source AND f_media AND f_missing AND f_protocol
              GROUP BY 1 ORDER BY 2 DESC LIMIT 30) x), '[]'::jsonb),
      'start_position', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC)
        FROM (SELECT start_position AS v, count(*) AS c FROM flags
              WHERE f_region AND f_category AND f_status AND f_equipment AND f_source AND f_media AND f_missing AND f_protocol
                AND start_position IS NOT NULL
              GROUP BY 1) x), '[]'::jsonb),
      'source', (
        SELECT jsonb_build_array(
          jsonb_build_object('value', 'system', 'count', count(*) FILTER (WHERE clinic_id IS NULL)),
          jsonb_build_object('value', 'clinic', 'count', count(*) FILTER (WHERE clinic_id IS NOT NULL)),
          jsonb_build_object('value', 'override', 'count', count(*) FILTER (WHERE has_override))
        )
        FROM flags
        WHERE f_region AND f_category AND f_status AND f_equipment AND f_position AND f_media AND f_missing AND f_protocol),
      'media', (
        SELECT jsonb_build_array(
          jsonb_build_object('value', 'with', 'count', count(*) FILTER (WHERE has_media)),
          jsonb_build_object('value', 'without', 'count', count(*) FILTER (WHERE NOT has_media))
        )
        FROM flags
        WHERE f_region AND f_category AND f_status AND f_equipment AND f_position AND f_source AND f_missing AND f_protocol),
      'missing', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('value', v, 'count', c) ORDER BY c DESC)
        FROM (SELECT mk AS v, count(*) AS c FROM flags, unnest(missing) mk
              WHERE f_region AND f_category AND f_status AND f_equipment AND f_position AND f_source AND f_media AND f_protocol
              GROUP BY 1) x), '[]'::jsonb)
    ),
    'viewer', jsonb_build_object('is_curator', app.is_catalog_curator(p_clinician_id))
  )
  INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_search(UUID, JSONB, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_search(UUID, JSONB, INT, INT) TO authenticated, service_role;

-- ============================================================================
-- catalog_get_exercise: the editor payload.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_get_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
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

  v_has_media := EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = p_exercise_id);
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

  RETURN jsonb_build_object(
    'id', v_ex.id, 'name', v_ex.name, 'name_en', v_ex.name_en, 'category', v_ex.category,
    'body_region_id', v_ex.body_region_id,
    'body_region', (SELECT jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
                    FROM app.body_region br WHERE br.id = v_ex.body_region_id),
    'muscle_group', v_ex.muscle_group, 'muscles', to_jsonb(v_ex.muscles), 'equipment', to_jsonb(v_ex.equipment),
    'aliases', to_jsonb(v_ex.aliases), 'key_cues', to_jsonb(v_ex.key_cues),
    'description', v_ex.description, 'instructions', v_ex.instructions,
    'common_mistakes', v_ex.common_mistakes, 'safety_notes', v_ex.safety_notes,
    'contraindications', v_ex.contraindications,
    'start_position', v_ex.start_position, 'difficulty', v_ex.difficulty, 'is_bilateral', v_ex.is_bilateral,
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
        'width', m.width, 'height', m.height, 'order', m."order", 'source_file', m.source_file,
        'verified', m.verified_at IS NOT NULL, 'verified_at', m.verified_at
      ) ORDER BY m."order")
      FROM app.exercise_media m WHERE m.exercise_id = p_exercise_id
    ), '[]'::jsonb),
    'created_at', v_ex.created_at, 'updated_at', v_ex.updated_at
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_get_exercise(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_get_exercise(UUID, UUID) TO authenticated, service_role;

-- Completeness for one exercise as the given clinic sees it (save responses).
CREATE OR REPLACE FUNCTION app._catalog_completeness_for(p_clinic_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
  SELECT jsonb_build_object('completeness', c.score, 'missing', to_jsonb(c.missing))
  FROM app.exercise_effective(p_clinic_id) e
  CROSS JOIN LATERAL app.exercise_completeness(
    e.name, e.name_en, e.body_region_id, e.instructions, e.description, e.key_cues,
    e.safety_notes, e.contraindications, e.muscles, e.start_position, e.difficulty,
    EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = e.id)) c
  WHERE e.id = p_exercise_id;
$$ LANGUAGE sql STABLE;

-- ============================================================================
-- catalog_save_exercise
--
-- Create (p_exercise_id NULL): p_scope 'master' (curators only) or 'clinic'
-- (default). Update: the target follows from the row and the caller —
--   clinic exercise of the caller's clinic -> the row itself
--   system exercise, curator              -> the master row
--   system exercise, anyone else          -> the clinic override (content
--                                            fields only; others: forbidden)
-- p_expected_revision guards against lost updates (the row's revision, or the
-- override's for an override target); NULL skips the check (bulk edits).
-- A patch that changes nothing is a no-op (no revision bump, no history row).
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

REVOKE ALL ON FUNCTION app.catalog_save_exercise(UUID, UUID, JSONB, INT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_save_exercise(UUID, UUID, JSONB, INT, TEXT, TEXT) TO authenticated, service_role;

-- ============================================================================
-- catalog_bulk_update: one patch applied to many exercises (bulk grid).
-- Rows the caller may not change are skipped and reported, never partially
-- applied.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_bulk_update(p_clinician_id UUID, p_ids UUID[], p_patch JSONB)
RETURNS JSONB AS $$
DECLARE
  v_id UUID;
  v_res JSONB;
  v_updated INT := 0;
  v_skipped JSONB := '[]'::jsonb;
  v_norm JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin')) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_ids');
  END IF;
  v_norm := app._catalog_normalize_patch(p_patch);
  IF v_norm ? 'error' THEN
    RETURN v_norm;
  END IF;

  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_ids) x) LOOP
    v_res := app.catalog_save_exercise(p_clinician_id, v_id, p_patch, NULL);
    IF v_res ? 'error' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', COALESCE(v_res ->> 'message', v_res ->> 'error'));
    ELSIF (v_res ->> 'changed')::boolean THEN
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('updated', v_updated, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_bulk_update(UUID, UUID[], JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_bulk_update(UUID, UUID[], JSONB) TO authenticated, service_role;

-- ============================================================================
-- catalog_set_status (single or bulk). Approval requires a name, a category
-- and a body region. Master rows: curators only.
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
    IF p_status = 'approved' AND v_row.body_region_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'missing_body_region');
      CONTINUE;
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

REVOKE ALL ON FUNCTION app.catalog_set_status(UUID, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_set_status(UUID, UUID[], TEXT) TO authenticated, service_role;

-- ============================================================================
-- catalog_revert_override: drop the clinic's version of some (NULL = all)
-- fields, back to the master content.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_revert_override(p_clinician_id UUID, p_exercise_id UUID, p_fields TEXT[] DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_master JSONB;
  v_ov app.exercise_override;
  v_patch JSONB := '{}'::jsonb;
  v_key TEXT;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT to_jsonb(ex) INTO v_master FROM app.exercise ex
  WHERE ex.id = p_exercise_id AND ex.clinic_id IS NULL AND ex.deleted_at IS NULL;
  IF v_master IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_ov FROM app.exercise_override WHERE clinic_id = v_clinic_id AND exercise_id = p_exercise_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'changed', false);
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_ov.fields) LOOP
    IF p_fields IS NULL OR v_key = ANY(p_fields) THEN
      v_patch := v_patch || jsonb_build_object(v_key, app._catalog_field_value(v_master, v_key));
    END IF;
  END LOOP;
  IF v_patch = '{}'::jsonb THEN
    RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'changed', false);
  END IF;

  -- A curator's save would target the master row, so write the override
  -- directly here instead of going through catalog_save_exercise.
  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  SELECT p_exercise_id, v_clinic_id, 'override', 'revert',
         jsonb_object_agg(k, jsonb_build_object('from', v_ov.fields -> k, 'to', v_patch -> k)), p_clinician_id
  FROM jsonb_object_keys(v_patch) k;

  UPDATE app.exercise_override
  SET fields = fields - ARRAY(SELECT jsonb_object_keys(v_patch)),
      revision = revision + 1, updated_by = p_clinician_id, updated_at = now()
  WHERE clinic_id = v_clinic_id AND exercise_id = p_exercise_id
  RETURNING * INTO v_ov;

  RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'changed', true, 'override_revision', v_ov.revision)
         || app._catalog_completeness_for(v_clinic_id, p_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_revert_override(UUID, UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_revert_override(UUID, UUID, TEXT[]) TO authenticated, service_role;

-- ============================================================================
-- catalog_history / catalog_restore_revision
-- A master change made by someone outside the caller's clinic shows as the
-- catalog team, never by name.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_history(p_clinician_id UUID, p_exercise_id UUID, p_limit INT DEFAULT 50)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = p_exercise_id AND (clinic_id IS NULL OR clinic_id = v_clinic_id)) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'scope', r.scope, 'action', r.action, 'changes', r.changes, 'changed_at', r.changed_at,
      'changed_by_name', CASE WHEN u.clinic_id = v_clinic_id THEN u.name END,
      'by_catalog_team', u.id IS NOT NULL AND u.clinic_id <> v_clinic_id,
      'restorable', r.action IN ('update', 'revert', 'restore')
    ) ORDER BY r.changed_at DESC)
    FROM (
      SELECT * FROM app.exercise_revision
      WHERE exercise_id = p_exercise_id AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
      ORDER BY changed_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    ) r
    LEFT JOIN app."user" u ON u.id = r.changed_by
  ), '[]'::jsonb));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_history(UUID, UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_history(UUID, UUID, INT) TO authenticated, service_role;

-- Restores the "from" side of one revision as a new change (history is never
-- rewritten). Goes through catalog_save_exercise, so the same permission
-- rules apply to what can be restored and where it lands.
CREATE OR REPLACE FUNCTION app.catalog_restore_revision(p_clinician_id UUID, p_revision_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_rev app.exercise_revision;
  v_patch JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_rev FROM app.exercise_revision
  WHERE id = p_revision_id AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_rev.action NOT IN ('update', 'revert', 'restore') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'not_restorable');
  END IF;

  SELECT jsonb_object_agg(key, value -> 'from') INTO v_patch FROM jsonb_each(v_rev.changes);
  -- a restored name can't be empty; drop it rather than failing the restore
  IF v_patch -> 'name' = 'null'::jsonb THEN
    v_patch := v_patch - 'name';
  END IF;
  IF v_patch IS NULL OR v_patch = '{}'::jsonb THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'not_restorable');
  END IF;

  RETURN app.catalog_save_exercise(p_clinician_id, v_rev.exercise_id, v_patch, NULL, NULL, 'restore');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_restore_revision(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_restore_revision(UUID, UUID) TO authenticated, service_role;

-- ============================================================================
-- catalog_find_similar: duplicate warning while creating/renaming.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_find_similar(
  p_clinician_id UUID, p_name TEXT, p_name_en TEXT DEFAULT NULL, p_exclude_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_name TEXT := lower(NULLIF(btrim(p_name), ''));
  v_name_en TEXT := lower(NULLIF(btrim(p_name_en), ''));
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_name IS NULL AND v_name_en IS NULL THEN
    RETURN jsonb_build_object('items', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'name_en', s.name_en, 'status', s.status,
      'is_clinic_owned', s.clinic_id IS NOT NULL, 'similarity', round(s.sim::numeric, 2)
    ) ORDER BY s.sim DESC, s.name)
    FROM (
    SELECT * FROM (
      SELECT ex.id, ex.name, ex.name_en, ex.status, ex.clinic_id,
        GREATEST(
          CASE WHEN v_name IS NOT NULL THEN extensions.similarity(lower(ex.name), v_name) ELSE 0 END,
          CASE WHEN v_name_en IS NOT NULL THEN extensions.similarity(lower(COALESCE(ex.name_en, '')), v_name_en) ELSE 0 END,
          CASE WHEN v_name_en IS NOT NULL AND app.exercise_name_key(ex.name_en) = app.exercise_name_key(v_name_en) THEN 1 ELSE 0 END,
          CASE WHEN v_name IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(ex.aliases) a WHERE lower(a) = v_name) THEN 1 ELSE 0 END
        ) AS sim
      FROM app.exercise ex
      WHERE ex.is_active AND ex.deleted_at IS NULL
        AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
        AND ex.id IS DISTINCT FROM p_exclude_id
    ) s0
    WHERE s0.sim >= 0.45
    ORDER BY s0.sim DESC, s0.name
    LIMIT 6
    ) s
  ), '[]'::jsonb));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_find_similar(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_find_similar(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ============================================================================
-- duplicate_exercise: copies the clinic's *effective* content plus the new
-- catalog fields; the copy starts as a draft with a history entry.
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
    clinic_id, name, name_en, category, body_region_id, muscle_group, muscles, equipment, aliases, key_cues,
    description, instructions, common_mistakes, safety_notes, contraindications, start_position, difficulty,
    is_bilateral, source, status, revision
  )
  SELECT
    v_clinic_id, e.name || ' (עותק)', e.name_en, e.category, e.body_region_id, e.muscle_group, e.muscles, e.equipment,
    e.aliases, e.key_cues, e.description, e.instructions, e.common_mistakes, e.safety_notes, e.contraindications,
    e.start_position, e.difficulty, e.is_bilateral, 'clinic', 'draft', 1
  FROM app.exercise_effective(v_clinic_id) e
  WHERE e.id = p_exercise_id AND e.is_active AND e.deleted_at IS NULL
  RETURNING id INTO v_new_id;

  IF v_new_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  VALUES (v_new_id, v_clinic_id, 'clinic', 'duplicate',
          jsonb_build_object('source_exercise_id', jsonb_build_object('from', NULL, 'to', p_exercise_id)), p_clinician_id);

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- delete_custom_exercise: refuses exercises still in use (protocol or a
-- current patient plan) — those are archived instead.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.delete_custom_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
BEGIN
  SELECT r.clinic_id, r.schema_name INTO v_clinic_id, v_schema FROM app.resolve_clinician_schema(p_clinician_id) r;
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.exercise
    WHERE id = p_exercise_id AND source = 'clinic' AND clinic_id = v_clinic_id AND deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF EXISTS (SELECT 1 FROM app.protocol_phase_exercise WHERE exercise_id = p_exercise_id)
     OR app._exercise_plan_usage(v_schema, p_exercise_id) > 0 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'in_use');
  END IF;

  UPDATE app.exercise
  SET is_active = false, deleted_at = now()
  WHERE id = p_exercise_id;

  RETURN jsonb_build_object('ok', true, 'id', p_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- get_exercise (picker detail drawer): effective content + catalog fields.
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
    'muscles', to_jsonb(ex.muscles),
    'equipment', to_jsonb(ex.equipment),
    'aliases', to_jsonb(ex.aliases),
    'key_cues', to_jsonb(ex.key_cues),
    'description', ex.description, 'instructions', ex.instructions,
    'common_mistakes', ex.common_mistakes, 'safety_notes', ex.safety_notes,
    'contraindications', ex.contraindications,
    'start_position', ex.start_position, 'difficulty', ex.difficulty,
    'default_prescription', ex.default_prescription,
    'is_bilateral', ex.is_bilateral, 'source', ex.source, 'external_ref', ex.external_ref,
    'status', ex.status,
    'protocol_labels', COALESCE((
      SELECT jsonb_agg(DISTINCT pr.name)
      FROM app.protocol_phase_exercise ppe
      JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
      JOIN app.protocol pr ON pr.id = pp.protocol_id
      WHERE ppe.exercise_id = ex.id AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
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
  FROM app.exercise_effective(v_clinic_id) ex
  LEFT JOIN app.body_region br ON br.id = ex.body_region_id
  WHERE ex.id = p_exercise_id AND ex.is_active;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================================
-- Grandfathering backfill (idempotent). Called here for existing databases
-- and again at the end of supabase/seed/seed.sql, because on `db reset` the
-- protocol/plan seeds run after all migrations.
--   1. An exercise with no region, used only by protocols of exactly one
--      region, takes that region.
--   2. A draft exercise already used by a protocol or any patient plan is
--      approved (reviewed_by NULL = grandfathered, not a person's review).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_backfill_governance()
RETURNS JSONB AS $$
DECLARE
  v_regions INT;
  v_approved INT := 0;
  v_n INT;
  v_schema TEXT;
BEGIN
  UPDATE app.exercise ex
  SET body_region_id = r.region_id
  FROM (
    SELECT ppe.exercise_id, (array_agg(DISTINCT pr.body_region_id))[1] AS region_id
    FROM app.protocol_phase_exercise ppe
    JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
    JOIN app.protocol pr ON pr.id = pp.protocol_id
    WHERE pr.body_region_id IS NOT NULL
    GROUP BY ppe.exercise_id
    HAVING count(DISTINCT pr.body_region_id) = 1
  ) r
  WHERE ex.id = r.exercise_id AND ex.body_region_id IS NULL;
  GET DIAGNOSTICS v_regions = ROW_COUNT;

  UPDATE app.exercise SET status = 'approved', reviewed_at = now()
  WHERE status = 'draft'
    AND id IN (SELECT exercise_id FROM app.protocol_phase_exercise);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_approved := v_approved + v_n;

  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    IF to_regclass(format('%I.plan_exercise', v_schema)) IS NOT NULL THEN
      EXECUTE format(
        'UPDATE app.exercise SET status = ''approved'', reviewed_at = now()
          WHERE status = ''draft'' AND id IN (SELECT exercise_id FROM %I.plan_exercise)', v_schema);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_approved := v_approved + v_n;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('regions_inferred', v_regions, 'approved', v_approved);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_backfill_governance() FROM PUBLIC;

SELECT app.catalog_backfill_governance();

-- ============================================================================
-- Picker gating: only approved exercises can be chosen. Bodies below are the
-- 0031 definitions with one added predicate each.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.search_exercises(p_clinician_id uuid, p_query text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_body_region_id uuid DEFAULT NULL::uuid, p_phase_n integer DEFAULT NULL::integer, p_muscle text DEFAULT NULL::text, p_protocol_slug text DEFAULT NULL::text, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0, p_equipment text DEFAULT NULL::text, p_favorites_only boolean DEFAULT false, p_media_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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
      ex.id, ex.name, ex.name_en, ex.category, ex.is_bilateral, ex.source, ex.equipment,
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
      md.thumb_path, md.gif_path, COALESCE(md.verified, false) AS media_verified,
      EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = ex.id) AS has_media,
      (fav.exercise_id IS NOT NULL) AS is_favorite
    FROM app.exercise ex
    LEFT JOIN app.body_region br ON br.id = ex.body_region_id
    LEFT JOIN app.exercise_favorite fav ON fav.exercise_id = ex.id AND fav.user_id = p_clinician_id
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
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN m.kind = 'gif' THEN COALESCE(m.thumb_url, m.url) ELSE m.url END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media m
      WHERE m.exercise_id = ex.id AND m.kind IN ('gif', 'image')
      ORDER BY (m.kind = 'gif') DESC, m."order"
      LIMIT 1
    ) md ON true
    WHERE ex.is_active
      AND ex.status = 'approved'
      AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
      AND (p_query IS NULL OR p_query = '' OR ex.name ILIKE '%' || p_query || '%' OR ex.name_en ILIKE '%' || p_query || '%')
      AND (p_category IS NULL OR p_category = '' OR ex.category = p_category)
      AND (p_muscle IS NULL OR p_muscle = '' OR ex.muscles @> ARRAY[p_muscle])
      AND (p_equipment IS NULL OR p_equipment = '' OR ex.equipment @> ARRAY[p_equipment])
      AND (NOT COALESCE(p_favorites_only, false) OR fav.exercise_id IS NOT NULL)
      AND (NOT COALESCE(p_media_only, false) OR md.thumb_path IS NOT NULL)
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
      'phase_match', phase_match, 'has_media', has_media,
      'equipment', COALESCE(to_jsonb(equipment), '[]'::jsonb),
      'is_favorite', is_favorite,
      'thumb_path', thumb_path, 'gif_path', gif_path, 'media_verified', media_verified
    ) ORDER BY phase_match DESC, name), '[]'::jsonb)
  INTO v_total, v_items
  FROM paged;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$function$;

CREATE OR REPLACE FUNCTION app.recommend_exercises(p_clinician_id uuid, p_protocol_id uuid DEFAULT NULL::uuid, p_body_region_id uuid DEFAULT NULL::uuid, p_phase_n integer DEFAULT NULL::integer, p_anchor_ids uuid[] DEFAULT '{}'::uuid[], p_exclude_ids uuid[] DEFAULT '{}'::uuid[], p_limit integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_clinic_id UUID;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 12), 1), 50);
  v_anchor_ids UUID[] := COALESCE(p_anchor_ids, '{}');
  v_exclude_ids UUID[] := COALESCE(p_exclude_ids, '{}');
  v_protocol_id UUID;
  v_protocol_region UUID;
  v_region UUID := p_body_region_id;
  v_region_json JSONB;
  v_region_total INT := 0;
  v_anchor_cats TEXT[];
  v_typical_cats TEXT[];
  v_ranked JSONB;
  v_ids UUID[];
  v_cards JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF p_protocol_id IS NOT NULL THEN
    SELECT id, body_region_id INTO v_protocol_id, v_protocol_region
    FROM app.protocol WHERE id = p_protocol_id AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
    IF v_protocol_id IS NULL THEN
      RETURN jsonb_build_object('error', 'not_found');
    END IF;
    v_region := COALESCE(v_region, v_protocol_region);
  END IF;

  IF v_region IS NOT NULL THEN
    SELECT jsonb_build_object('id', id, 'slug', slug, 'name', name, 'name_en', name_en)
    INTO v_region_json FROM app.body_region WHERE id = v_region;
    IF v_region_json IS NULL THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_region_id');
    END IF;

    SELECT count(*) INTO v_region_total
    FROM app.protocol pr
    WHERE pr.is_active AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
      AND pr.body_region_id = v_region AND pr.id IS DISTINCT FROM v_protocol_id;

    SELECT array_agg(DISTINCT ex.category) INTO v_typical_cats
    FROM app.protocol_phase_exercise ppe
    JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
    JOIN app.protocol pr ON pr.id = pp.protocol_id
    JOIN app.exercise ex ON ex.id = ppe.exercise_id
    WHERE pr.is_active AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
      AND pr.body_region_id = v_region AND (p_phase_n IS NULL OR pp.n = p_phase_n);
  END IF;

  SELECT array_agg(DISTINCT category) INTO v_anchor_cats FROM app.exercise WHERE id = ANY(v_anchor_ids);

  WITH vis AS (
    SELECT ppe.exercise_id, ppe.protocol_phase_id, pp.n, pr.id AS protocol_id, pr.body_region_id,
           ppe.prescription, ppe.frequency
    FROM app.protocol_phase_exercise ppe
    JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
    JOIN app.protocol pr ON pr.id = pp.protocol_id
    WHERE pr.is_active AND (pr.clinic_id IS NULL OR pr.clinic_id = v_clinic_id)
  ),
  region_stats AS (
    SELECT exercise_id,
           count(DISTINCT protocol_id) FILTER (WHERE n = p_phase_n) AS rp_count,
           count(DISTINCT protocol_id) AS r_count
    FROM vis
    WHERE v_region IS NOT NULL AND body_region_id = v_region AND protocol_id IS DISTINCT FROM v_protocol_id
    GROUP BY exercise_id
  ),
  adjacent AS (
    SELECT DISTINCT ON (exercise_id) exercise_id, n AS adj_n
    FROM vis
    WHERE v_protocol_id IS NOT NULL AND p_phase_n IS NOT NULL AND protocol_id = v_protocol_id AND n <> p_phase_n
    ORDER BY exercise_id, abs(n - p_phase_n), n
  ),
  co AS (
    SELECT a.exercise_id, count(DISTINCT a.protocol_phase_id) AS co_count
    FROM vis a
    JOIN vis b ON b.protocol_phase_id = a.protocol_phase_id AND b.exercise_id <> a.exercise_id
    WHERE b.exercise_id = ANY(v_anchor_ids)
      -- only pairings from a comparable context: same region (when known) and
      -- this phase or a neighbouring one — a late-phase agility drill that
      -- happens to share a phase with a squat elsewhere isn't a phase-1 match
      AND (v_region IS NULL OR a.body_region_id = v_region)
      AND (p_phase_n IS NULL OR abs(a.n - p_phase_n) <= 1)
    GROUP BY a.exercise_id
  ),
  picks AS (
    SELECT exercise_id,
           count(DISTINCT picker_session_id) FILTER (WHERE user_id <> p_clinician_id) AS clinic_adds,
           count(DISTINCT picker_session_id) FILTER (WHERE user_id = p_clinician_id) AS my_adds
    FROM app.exercise_pick_event
    WHERE clinic_id = v_clinic_id AND event = 'added'
      AND body_region_id IS NOT DISTINCT FROM v_region
      AND (p_phase_n IS NULL OR phase_n IS NULL OR phase_n = p_phase_n)
    GROUP BY exercise_id
  ),
  cand AS (
    SELECT ex.id, ex.name, ex.category, COALESCE(app.exercise_name_key(ex.name_en), ex.name) AS name_key,
           COALESCE(rs.rp_count, 0) AS rp, COALESCE(rs.r_count, 0) AS r,
           adj.adj_n, COALESCE(co.co_count, 0) AS co,
           COALESCE(pk.clinic_adds, 0) AS ca, COALESCE(pk.my_adds, 0) AS ma,
           (fav.exercise_id IS NOT NULL) AS is_fav
    FROM app.exercise ex
    LEFT JOIN region_stats rs ON rs.exercise_id = ex.id
    LEFT JOIN adjacent adj ON adj.exercise_id = ex.id
    LEFT JOIN co ON co.exercise_id = ex.id
    LEFT JOIN picks pk ON pk.exercise_id = ex.id
    LEFT JOIN app.exercise_favorite fav ON fav.exercise_id = ex.id AND fav.user_id = p_clinician_id
    WHERE ex.is_active AND ex.status = 'approved' AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
      AND NOT (ex.id = ANY(v_exclude_ids))
      AND NOT EXISTS (
        SELECT 1 FROM app.exercise x
        WHERE x.id = ANY(v_exclude_ids)
          AND (x.name = ex.name OR app.exercise_name_key(x.name_en) = app.exercise_name_key(ex.name_en))
      )
      AND (rs.exercise_id IS NOT NULL OR adj.exercise_id IS NOT NULL OR co.exercise_id IS NOT NULL
           OR pk.exercise_id IS NOT NULL OR fav.exercise_id IS NOT NULL)
  ),
  weighted AS (
    SELECT c.*,
      CASE WHEN v_region_total > 0 THEN 4.0 * c.rp / v_region_total ELSE 0 END AS s_rp,
      CASE WHEN v_region_total > 0 THEN 1.5 * c.r / v_region_total ELSE 0 END AS s_r,
      CASE WHEN c.adj_n IS NULL THEN 0
           WHEN abs(c.adj_n - p_phase_n) = 1 THEN 1.5
           WHEN abs(c.adj_n - p_phase_n) = 2 THEN 0.75
           ELSE 0 END AS s_adj,
      0.75 * LEAST(c.co, 4) AS s_co,
      0.5 * LEAST(c.ca, 6) AS s_ca,
      0.75 * LEAST(c.ma, 4) AS s_ma,
      CASE WHEN c.is_fav THEN 1.0 ELSE 0 END AS s_fav
    FROM cand c
  ),
  gapped AS (
    SELECT w.*,
      CASE WHEN (w.s_rp + w.s_r + w.s_adj + w.s_co) > 0
             AND COALESCE(array_length(v_anchor_cats, 1), 0) > 0
             AND NOT (w.category = ANY(v_anchor_cats))
             AND COALESCE(w.category = ANY(v_typical_cats), false)
           THEN 0.75 ELSE 0 END AS s_gap
    FROM weighted w
  ),
  scored AS (
    SELECT g.*, round((g.s_rp + g.s_r + g.s_adj + g.s_co + g.s_ca + g.s_ma + g.s_fav + g.s_gap)::numeric, 2) AS score
    FROM gapped g
  ),
  deduped AS (
    -- one card per exercise identity: the best-scoring copy wins
    SELECT s.*, row_number() OVER (PARTITION BY s.name_key ORDER BY s.score DESC, s.name, s.id) AS copy_n
    FROM scored s
    WHERE s.score > 0
  ),
  top AS (
    SELECT d.*, row_number() OVER (ORDER BY d.score DESC, d.name) AS rank
    FROM deduped d
    WHERE d.copy_n = 1
    ORDER BY d.score DESC, d.name
    LIMIT v_limit
  )
  SELECT
    array_agg(t.id ORDER BY t.rank),
    jsonb_object_agg(t.id::text, jsonb_build_object(
      'rank', t.rank,
      'score', t.score,
      'reasons', (
        SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.w DESC, x.prio), '[]'::jsonb)
        FROM (VALUES
          (t.s_rp, 1, CASE WHEN t.rp > 0 THEN jsonb_build_object('code', 'region_phase', 'count', t.rp, 'total', v_region_total) END),
          (t.s_adj, 2, CASE WHEN t.s_adj > 0 THEN jsonb_build_object('code', 'adjacent_phase', 'phase_n', t.adj_n) END),
          (t.s_co, 3, CASE WHEN t.co > 0 THEN jsonb_build_object('code', 'co_occurs', 'count', t.co) END),
          (t.s_ma, 4, CASE WHEN t.ma > 0 THEN jsonb_build_object('code', 'my_picks', 'count', t.ma) END),
          (t.s_ca, 5, CASE WHEN t.ca > 0 THEN jsonb_build_object('code', 'clinic_picks', 'count', t.ca) END),
          (t.s_fav, 6, CASE WHEN t.is_fav THEN jsonb_build_object('code', 'favorite') END),
          (t.s_gap, 7, CASE WHEN t.s_gap > 0 THEN jsonb_build_object('code', 'fills_gap', 'category', t.category) END),
          (t.s_r, 8, CASE WHEN t.r > 0 AND t.rp = 0 THEN jsonb_build_object('code', 'region', 'count', t.r, 'total', v_region_total) END)
        ) AS x(w, prio, obj)
        WHERE x.obj IS NOT NULL
      ),
      -- The prescription this exercise was actually given in the closest
      -- matching protocol context: same region + phase, then same region,
      -- then this protocol, then anywhere.
      'context_prescription', (
        SELECT jsonb_build_object('prescription', v.prescription, 'frequency', v.frequency)
        FROM vis v
        WHERE v.exercise_id = t.id AND v.prescription IS NOT NULL AND v.prescription != '{}'::jsonb
        ORDER BY (v.body_region_id = v_region AND v.n = p_phase_n) DESC NULLS LAST,
                 (v.body_region_id = v_region) DESC NULLS LAST,
                 (v.protocol_id = v_protocol_id) DESC NULLS LAST,
                 v.n
        LIMIT 1
      )
    ))
  INTO v_ids, v_ranked
  FROM top t;

  v_cards := app.exercise_cards(v_clinic_id, p_clinician_id, COALESCE(v_ids, '{}'));

  RETURN jsonb_build_object(
    'context', jsonb_build_object(
      'protocol_id', v_protocol_id,
      'body_region', v_region_json,
      'phase_n', p_phase_n,
      'region_protocol_total', v_region_total,
      -- id -> category for the anchors, so the picker can show the phase's
      -- category balance without a second lookup.
      'anchor_categories', (
        SELECT COALESCE(jsonb_object_agg(id, category), '{}'::jsonb)
        FROM app.exercise
        WHERE id = ANY(v_anchor_ids) AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
      )
    ),
    'items', (
      SELECT COALESCE(jsonb_agg(
        c.card
          || jsonb_build_object('score', v_ranked -> (c.card ->> 'id') -> 'score',
                                'rank', v_ranked -> (c.card ->> 'id') -> 'rank',
                                'reasons', v_ranked -> (c.card ->> 'id') -> 'reasons')
          || CASE WHEN v_ranked -> (c.card ->> 'id') -> 'context_prescription' IS NOT NULL
                    AND jsonb_typeof(v_ranked -> (c.card ->> 'id') -> 'context_prescription') = 'object'
               THEN jsonb_build_object(
                 'prescription', v_ranked -> (c.card ->> 'id') -> 'context_prescription' -> 'prescription',
                 'frequency', v_ranked -> (c.card ->> 'id') -> 'context_prescription' -> 'frequency')
               ELSE '{}'::jsonb END
        ORDER BY c.ord), '[]'::jsonb)
      FROM jsonb_array_elements(v_cards) WITH ORDINALITY AS c(card, ord)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.exercise_cards(p_clinic_id uuid, p_user_id uuid, p_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT COALESCE(jsonb_agg(card ORDER BY ord), '[]'::jsonb)
  FROM (
    SELECT u.ord, jsonb_build_object(
      'id', ex.id, 'name', ex.name, 'name_en', ex.name_en, 'category', ex.category,
      'body_region', CASE WHEN br.id IS NOT NULL
        THEN jsonb_build_object('id', br.id, 'slug', br.slug, 'name', br.name, 'name_en', br.name_en)
        ELSE NULL END,
      'equipment', COALESCE(to_jsonb(ex.equipment), '[]'::jsonb),
      'is_bilateral', ex.is_bilateral,
      'source', ex.source,
      'is_favorite', EXISTS (SELECT 1 FROM app.exercise_favorite f WHERE f.user_id = p_user_id AND f.exercise_id = ex.id),
      'thumb_path', md.thumb_path,
      'gif_path', md.gif_path,
      'media_verified', COALESCE(md.verified, false),
      'prescription', rx.rx
    ) AS card
    FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
    JOIN app.exercise ex ON ex.id = u.id AND ex.is_active AND ex.status = 'approved' AND (ex.clinic_id IS NULL OR ex.clinic_id = p_clinic_id)
    LEFT JOIN app.body_region br ON br.id = ex.body_region_id
    LEFT JOIN LATERAL (
      SELECT
        CASE WHEN m.kind = 'gif' THEN COALESCE(m.thumb_url, m.url) ELSE m.url END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media m
      WHERE m.exercise_id = ex.id AND m.kind IN ('gif', 'image')
      ORDER BY (m.kind = 'gif') DESC, m."order"
      LIMIT 1
    ) md ON true
    LEFT JOIN LATERAL (
      SELECT ppe.prescription AS rx
      FROM app.protocol_phase_exercise ppe
      JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
      JOIN app.protocol pr ON pr.id = pp.protocol_id
      WHERE ppe.exercise_id = ex.id AND (pr.clinic_id IS NULL OR pr.clinic_id = p_clinic_id)
        AND ppe.prescription IS NOT NULL AND ppe.prescription != '{}'::jsonb
      LIMIT 1
    ) rx ON true
  ) s;
$function$;


-- ============================================================================
-- Patient views: instructions come from the clinic's effective content (its
-- own version when it keeps one). Bodies are the 0005/0006 definitions with
-- the exercise join swapped for app.exercise_effective.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.patient_today(p_patient_auth_id uuid, p_today date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_plan_version_id UUID;
  v_phase_id UUID;
  v_phase_name TEXT;
  v_phase_n INT;
  v_session_id UUID;
  v_items JSONB;
  v_done INT;
  v_total INT;
  v_patient_name TEXT;
  v_protocol_name TEXT;
  v_plan_started_at TIMESTAMPTZ;
  v_plan_version_no INT;
  v_plan_version_created_at TIMESTAMPTZ;
  v_est_seconds INT;
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

  SELECT pv.id, pp.id, pp.name, pp.n, p.name, pr.name, pl.started_at, pv.version, pv.created_at
  INTO v_plan_version_id, v_phase_id, v_phase_name, v_phase_n, v_patient_name, v_protocol_name, v_plan_started_at, v_plan_version_no, v_plan_version_created_at
  FROM plan pl
  JOIN patient p ON p.id = pl.patient_id
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = v_patient_id;

  IF v_phase_id IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  SELECT id INTO v_session_id FROM session WHERE patient_id = v_patient_id AND date = p_today;
  IF v_session_id IS NULL THEN
    SELECT count(*) INTO v_total FROM plan_exercise WHERE plan_phase_id = v_phase_id AND deleted_at IS NULL;
    INSERT INTO session (patient_id, plan_version_id, date, status, items_planned)
    VALUES (v_patient_id, v_plan_version_id, p_today, 'planned', v_total)
    RETURNING id INTO v_session_id;
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pe.id, 'plan_phase_id', pe.plan_phase_id, 'exercise_id', pe.exercise_id,
      'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit,
      'tempo', pe.tempo, 'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
      'order', pe."order", 'source', pe.source,
      'exercise', jsonb_build_object(
        'name', ex.name, 'name_en', ex.name_en, 'instructions', ex.instructions,
        'media', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'kind', m.kind, 'url', m.url, 'thumb_url', m.thumb_url,
            'width', m.width, 'height', m.height
          ) ORDER BY m."order")
          FROM app.exercise_media m
          WHERE m.exercise_id = ex.id AND m.verified_at IS NOT NULL
        ), '[]'::jsonb)
      ),
      'done', (si.id IS NOT NULL AND NOT si.skipped)
    ) ORDER BY pe."order"), '[]'::jsonb),
    count(*) FILTER (WHERE si.id IS NOT NULL AND NOT si.skipped)
  INTO v_items, v_done
  FROM plan_exercise pe
  JOIN app.exercise_effective(app.clinic_id_for_schema(v_schema)) ex ON ex.id = pe.exercise_id
  LEFT JOIN session_item si ON si.session_id = v_session_id AND si.plan_exercise_id = pe.id
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  v_total := jsonb_array_length(v_items);

  -- Rough duration estimate for the "~N min" header line — not a clinical
  -- figure, just a UX estimate from the prescribed sets/reps/hold/rest.
  SELECT COALESCE(sum(pe.sets * (COALESCE(pe.hold_sec, pe.reps * 3, 20) + COALESCE(pe.rest_sec, 30))), 0)
  INTO v_est_seconds
  FROM plan_exercise pe
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'session', v_session_id);

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'date', p_today,
    'patient', jsonb_build_object('name', v_patient_name, 'day', (p_today - v_plan_started_at::date) + 1),
    'plan', jsonb_build_object(
      'protocol_name', v_protocol_name,
      'updated_recently', v_plan_version_no > 1 AND v_plan_version_created_at >= now() - interval '3 days'
    ),
    'est_minutes', GREATEST(1, round(v_est_seconds / 60.0)::int),
    'phase', jsonb_build_object('name', v_phase_name, 'n', v_phase_n),
    'items', v_items,
    'progress', jsonb_build_object('done', v_done, 'total', v_total)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION app.patient_plan(p_patient_auth_id uuid, p_today date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
      JOIN app.exercise_effective(app.clinic_id_for_schema(v_schema)) ex ON ex.id = pe.exercise_id
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
$function$;
