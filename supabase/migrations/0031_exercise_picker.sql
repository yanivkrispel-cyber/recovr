-- T-29 — smart exercise picker, phase 1.
--
-- Replaces the two copy-pasted "Add Exercise" search panels (protocol editor,
-- patient plan editor) with one picker that knows its context. This migration
-- adds what that picker needs server-side:
--
--   * app.exercise_favorite     — a clinician's starred exercises
--   * app.exercise_pick_event   — picker log (recommendations shown, exercises
--                                 added); feeds "recent" and the clinic-history
--                                 recommendation signal
--   * app.recommend_exercises   — explainable scoring, mirrored by
--                                 packages/shared/src/exerciseRecommend.ts
--   * app.recent_picked_exercises, app.set_exercise_favorite,
--     app.log_exercise_pick_events
--   * search_exercises gains equipment / favorites-only / media-only filters and
--     returns card fields (thumbnail paths, equipment, is_favorite)
--   * exercise_filter_options gains an equipment list
--
-- Scope decisions (product owner, 2026-09-13): recommendation signals come
-- only from the protocol library (system + this clinic's protocols) and from
-- this clinic's own picker history. No patient records, nothing cross-clinic,
-- nothing applied automatically — the clinician always picks.

-- ============================================================================
-- Tables
-- ============================================================================
CREATE TABLE app.exercise_favorite (
  user_id      UUID NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  exercise_id  UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  clinic_id    UUID NOT NULL REFERENCES app.clinic(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exercise_id)
);

CREATE TABLE app.exercise_pick_event (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          UUID NOT NULL REFERENCES app.clinic(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES app."user"(id) ON DELETE CASCADE,
  picker_session_id  UUID NOT NULL,  -- one opening of the picker
  entry              TEXT NOT NULL CHECK (entry IN ('protocol', 'plan')),
  protocol_id        UUID REFERENCES app.protocol(id) ON DELETE SET NULL,
  body_region_id     UUID REFERENCES app.body_region(id),
  phase_n            INT,
  exercise_id        UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  event              TEXT NOT NULL CHECK (event IN ('shown', 'added')),
  source             TEXT CHECK (source IN ('recommended', 'search', 'favorite', 'recent')),
  rank               INT,
  score              NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX exercise_pick_event_context_idx ON app.exercise_pick_event(clinic_id, event, body_region_id, phase_n);
CREATE INDEX exercise_pick_event_user_idx ON app.exercise_pick_event(user_id, event, created_at DESC);

-- ============================================================================
-- exercise_name_key: loose identity for an exercise name, so the picker can
-- tell that "Heel slide" and "Heel Slides" are the same exercise. The library
-- has near-duplicates like that (demo seed vs protocol seed vs clinic copies);
-- recommending the plural of something already in the phase is noise.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_name_key(p_name TEXT)
RETURNS TEXT AS $$
  SELECT NULLIF(btrim(regexp_replace(
    regexp_replace(lower(COALESCE(p_name, '')), '[^a-z0-9]+', ' ', 'g'),
    's( |$)', '\1', 'g')), '');
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================================
-- exercise_cards: the card payload shared by recommend / recent. Internal
-- helper — only called from the SECURITY DEFINER functions below, which have
-- already resolved and checked the clinic.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_cards(p_clinic_id UUID, p_user_id UUID, p_ids UUID[])
RETURNS JSONB AS $$
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
    JOIN app.exercise ex ON ex.id = u.id AND ex.is_active AND (ex.clinic_id IS NULL OR ex.clinic_id = p_clinic_id)
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
$$ LANGUAGE sql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.exercise_cards(UUID, UUID, UUID[]) FROM PUBLIC;

-- ============================================================================
-- recommend_exercises
--
-- Signals per candidate exercise (all over *visible* protocols — system rows
-- plus this clinic's own — and never the context protocol itself for the
-- region counts, so a protocol doesn't recommend its own contents back):
--   region_phase  other region protocols using it in this phase number
--   region        other region protocols using it in any phase
--   adjacent      nearest other phase of the context protocol using it
--   co_occurs     protocol phases (same region, this phase ±1) pairing it
--                 with an anchor (already in / picked for this phase)
--   my / clinic   picker sessions in this clinic that added it in a matching
--                 context (same region, same or unknown phase)
--   favorite      starred by this clinician
--   fills_gap     its category is typical for this region+phase but missing
--                 from the anchors
-- Weights and reason ordering: packages/shared/src/exerciseRecommend.ts.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.recommend_exercises(
  p_clinician_id UUID,
  p_protocol_id UUID DEFAULT NULL,
  p_body_region_id UUID DEFAULT NULL,
  p_phase_n INT DEFAULT NULL,
  p_anchor_ids UUID[] DEFAULT '{}',
  p_exclude_ids UUID[] DEFAULT '{}',
  p_limit INT DEFAULT 12
)
RETURNS JSONB AS $$
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
    WHERE ex.is_active AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.recommend_exercises(UUID, UUID, UUID, INT, UUID[], UUID[], INT) TO authenticated, service_role;

-- ============================================================================
-- recent_picked_exercises: what this clinician added through the picker,
-- most recent first.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.recent_picked_exercises(p_clinician_id UUID, p_limit INT DEFAULT 24)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_ids UUID[];
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT array_agg(exercise_id ORDER BY last_added DESC) INTO v_ids
  FROM (
    SELECT exercise_id, max(created_at) AS last_added
    FROM app.exercise_pick_event
    WHERE user_id = p_clinician_id AND clinic_id = v_clinic_id AND event = 'added'
    GROUP BY exercise_id
    ORDER BY last_added DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 60)
  ) r;

  RETURN jsonb_build_object('items', app.exercise_cards(v_clinic_id, p_clinician_id, COALESCE(v_ids, '{}')));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.recent_picked_exercises(UUID, INT) TO authenticated, service_role;

-- ============================================================================
-- set_exercise_favorite
-- ============================================================================
CREATE OR REPLACE FUNCTION app.set_exercise_favorite(p_clinician_id UUID, p_exercise_id UUID, p_on BOOLEAN)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
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

  IF p_on THEN
    INSERT INTO app.exercise_favorite (user_id, exercise_id, clinic_id)
    VALUES (p_clinician_id, p_exercise_id, v_clinic_id)
    ON CONFLICT (user_id, exercise_id) DO NOTHING;
  ELSE
    DELETE FROM app.exercise_favorite WHERE user_id = p_clinician_id AND exercise_id = p_exercise_id;
  END IF;

  RETURN jsonb_build_object('exercise_id', p_exercise_id, 'is_favorite', p_on);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.set_exercise_favorite(UUID, UUID, BOOLEAN) TO authenticated, service_role;

-- ============================================================================
-- log_exercise_pick_events
-- payload: {picker_session_id, entry, protocol_id?, body_region_id?, phase_n?,
--           events: [{exercise_id, event, source?, rank?, score?}]}
-- Rows naming an exercise the clinic can't see are dropped, as is a protocol
-- the clinic can't see (logged as NULL) — logging is best-effort and must
-- never become a way to probe another clinic's ids.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.log_exercise_pick_events(p_clinician_id UUID, p_payload JSONB)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_session UUID;
  v_entry TEXT := p_payload ->> 'entry';
  v_protocol_id UUID;
  v_region_id UUID;
  v_phase_n INT;
  v_inserted INT;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  BEGIN
    v_session := (p_payload ->> 'picker_session_id')::uuid;
    v_protocol_id := NULLIF(p_payload ->> 'protocol_id', '')::uuid;
    v_region_id := NULLIF(p_payload ->> 'body_region_id', '')::uuid;
    v_phase_n := NULLIF(p_payload ->> 'phase_n', '')::int;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_payload');
  END;

  IF v_session IS NULL OR v_entry NOT IN ('protocol', 'plan')
     OR jsonb_typeof(p_payload -> 'events') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload -> 'events') > 200 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_payload');
  END IF;

  IF v_protocol_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.protocol WHERE id = v_protocol_id AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
  ) THEN
    v_protocol_id := NULL;
  END IF;
  IF v_region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = v_region_id) THEN
    v_region_id := NULL;
  END IF;

  WITH raw AS (
    SELECT e ->> 'exercise_id' AS exercise_id, e ->> 'event' AS event, e ->> 'source' AS source,
           e ->> 'rank' AS rank, e ->> 'score' AS score
    FROM jsonb_array_elements(p_payload -> 'events') e
  ),
  valid AS (
    SELECT ex.id AS exercise_id, raw.event,
           CASE WHEN raw.source IN ('recommended', 'search', 'favorite', 'recent') THEN raw.source END AS source,
           CASE WHEN raw.rank ~ '^\d{1,4}$' THEN raw.rank::int END AS rank,
           CASE WHEN raw.score ~ '^\d{1,3}(\.\d+)?$' THEN raw.score::numeric END AS score
    FROM raw
    JOIN app.exercise ex
      ON raw.exercise_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND ex.id = raw.exercise_id::uuid
     AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
    WHERE raw.event IN ('shown', 'added')
  )
  INSERT INTO app.exercise_pick_event
    (clinic_id, user_id, picker_session_id, entry, protocol_id, body_region_id, phase_n,
     exercise_id, event, source, rank, score)
  SELECT v_clinic_id, p_clinician_id, v_session, v_entry, v_protocol_id, v_region_id, v_phase_n,
         exercise_id, event, source, rank, score
  FROM valid;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('inserted', v_inserted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.log_exercise_pick_events(UUID, JSONB) TO authenticated, service_role;

-- ============================================================================
-- search_exercises: + p_equipment, p_favorites_only, p_media_only; items gain
-- card fields (equipment, is_favorite, thumb_path, gif_path, media_verified).
-- Signature changes, so DROP first (see 0027).
-- ============================================================================
DROP FUNCTION IF EXISTS app.search_exercises(UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION app.search_exercises(
  p_clinician_id UUID,
  p_query TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_body_region_id UUID DEFAULT NULL,
  p_phase_n INT DEFAULT NULL,
  p_muscle TEXT DEFAULT NULL,
  p_protocol_slug TEXT DEFAULT NULL,
  p_limit INT DEFAULT 60,
  p_offset INT DEFAULT 0,
  p_equipment TEXT DEFAULT NULL,
  p_favorites_only BOOLEAN DEFAULT false,
  p_media_only BOOLEAN DEFAULT false
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION app.search_exercises(UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, INT, INT, TEXT, BOOLEAN, BOOLEAN) TO authenticated, service_role;

-- ============================================================================
-- exercise_filter_options: + 'equipment' (values used by at least 5 visible
-- exercises, most common first).
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
    'custom_count', (SELECT count(*) FROM app.exercise WHERE is_active AND clinic_id = v_clinic_id),
    'equipment', (
      SELECT COALESCE(jsonb_agg(e ORDER BY c DESC, e), '[]'::jsonb)
      FROM (
        SELECT unnest(equipment) AS e, count(*) AS c
        FROM app.exercise
        WHERE is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
        GROUP BY 1
        HAVING count(*) >= 5
      ) eq
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
