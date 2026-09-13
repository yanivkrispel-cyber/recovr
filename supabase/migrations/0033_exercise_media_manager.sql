-- T-31 — Exercise media manager.
--
-- Builds on T-30's hybrid catalog:
--   * exercise_media.clinic_id — NULL = master media (catalog curators manage
--     it, every clinic sees it); set = one clinic's own media, visible only to
--     that clinic and its patients. A clinic's own media sorts before master
--     media (same precedence as its content overrides). Every media read now
--     goes through app.exercise_media_visible(clinic_id).
--   * Uploaded files: kind 'clip' (MP4/WebM) joins image/gif; 'video' stays a
--     YouTube id. Uploads land under uploads/master/<exercise>/ or
--     uploads/clinic/<clinic>/<exercise>/ in the private exercise-media
--     bucket; the API mints signed upload URLs and registers the row only
--     after the object exists.
--   * Rights: rights (unknown|own|licensed|open|embed) + attribution. A media
--     row can only be *newly* verified with known rights. Rows verified before
--     this migration are left as they are and surface in the queue as
--     "verified, rights unknown" rather than being silently re-labelled.
--   * start_sec / end_sec trim a YouTube video or clip to the relevant part.
--   * Verification queue, bulk verify, reorder / primary, remove, and
--     filename -> exercise matching for bulk import.
--
-- CLAUDE.md §Media is unchanged: patients and the printed program still only
-- ever receive media with verified_at set.

-- ============================================================================
-- Columns, constraints, storage
-- ============================================================================
ALTER TABLE app.exercise_media
  ADD COLUMN clinic_id UUID REFERENCES app.clinic(id) ON DELETE CASCADE,
  ADD COLUMN rights TEXT NOT NULL DEFAULT 'unknown'
    CHECK (rights IN ('unknown', 'own', 'licensed', 'open', 'embed')),
  ADD COLUMN attribution TEXT,
  ADD COLUMN start_sec INT CHECK (start_sec >= 0),
  ADD COLUMN end_sec INT CHECK (end_sec > 0),
  ADD COLUMN mime_type TEXT,
  ADD COLUMN size_bytes BIGINT,
  ADD COLUMN uploaded_by UUID REFERENCES app."user"(id) ON DELETE SET NULL,
  ADD COLUMN review_note TEXT;

ALTER TABLE app.exercise_media DROP CONSTRAINT exercise_media_kind_check;
ALTER TABLE app.exercise_media ADD CONSTRAINT exercise_media_kind_check
  CHECK (kind IN ('image', 'gif', 'video', 'clip'));
ALTER TABLE app.exercise_media ADD CONSTRAINT exercise_media_trim_check
  CHECK (start_sec IS NULL OR end_sec IS NULL OR end_sec > start_sec);

-- one YouTube video per exercise *per scope* (master, or one clinic)
DROP INDEX IF EXISTS app.exercise_media_one_video_idx;
CREATE UNIQUE INDEX exercise_media_one_video_idx
  ON app.exercise_media (exercise_id, COALESCE(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind = 'video';
CREATE INDEX exercise_media_clinic_idx ON app.exercise_media (clinic_id) WHERE clinic_id IS NOT NULL;
CREATE INDEX exercise_media_pending_idx ON app.exercise_media (exercise_id) WHERE verified_at IS NULL;

-- Backfill: media of a clinic's own exercise belongs to that clinic; YouTube
-- links are embeds; dataset files carry their attribution (rights stay unknown).
UPDATE app.exercise_media m SET clinic_id = e.clinic_id
FROM app.exercise e
WHERE e.id = m.exercise_id AND e.clinic_id IS NOT NULL AND m.clinic_id IS NULL;
UPDATE app.exercise_media SET rights = 'embed' WHERE kind = 'video' AND rights = 'unknown';
UPDATE app.exercise_media SET attribution = '© Gym visual — https://gymvisual.com/'
WHERE url LIKE 'dataset/%' AND attribution IS NULL;

ALTER TABLE app.exercise_revision DROP CONSTRAINT exercise_revision_action_check;
ALTER TABLE app.exercise_revision ADD CONSTRAINT exercise_revision_action_check
  CHECK (action IN ('create', 'update', 'status', 'revert', 'restore', 'duplicate', 'media'));

-- removing an uploaded file also drops its cached signed URL (0019 only
-- granted SELECT/INSERT/UPDATE)
GRANT DELETE ON app.media_signed_url_cache TO service_role;

UPDATE storage.buckets
SET file_size_limit = 52428800,  -- 50 MiB (per-kind limits are enforced by the API)
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']
WHERE id = 'exercise-media';

-- ============================================================================
-- Visibility
-- ============================================================================
CREATE OR REPLACE FUNCTION app.exercise_media_visible(p_clinic_id UUID)
RETURNS SETOF app.exercise_media AS $$
  SELECT * FROM app.exercise_media m
  WHERE m.clinic_id IS NULL OR m.clinic_id = p_clinic_id;
$$ LANGUAGE sql STABLE;

-- Where the caller's media changes on an exercise land:
--   own clinic's exercise            -> clinic scope
--   system exercise, catalog curator -> master
--   system exercise, anyone else     -> clinic scope (private media)
CREATE OR REPLACE FUNCTION app._media_scope(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_ex_clinic UUID;
  v_is_curator BOOLEAN;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT clinic_id INTO v_ex_clinic FROM app.exercise
  WHERE id = p_exercise_id AND deleted_at IS NULL AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  IF v_ex_clinic IS NULL AND v_is_curator THEN
    RETURN jsonb_build_object('clinic_id', v_clinic_id, 'is_curator', true, 'scope', 'master',
      'target_clinic_id', NULL, 'prefix', format('uploads/master/%s/', p_exercise_id));
  END IF;
  RETURN jsonb_build_object('clinic_id', v_clinic_id, 'is_curator', v_is_curator, 'scope', 'clinic',
    'target_clinic_id', v_clinic_id, 'prefix', format('uploads/clinic/%s/%s/', v_clinic_id, p_exercise_id),
    'system_exercise', v_ex_clinic IS NULL);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app._media_scope(UUID, UUID) FROM PUBLIC;

-- Public wrapper for the API (it needs the storage prefix before minting upload URLs).
CREATE OR REPLACE FUNCTION app.catalog_media_scope(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
  SELECT app._media_scope(p_clinician_id, p_exercise_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_scope(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_scope(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app._media_history(
  p_exercise_id UUID, p_media_clinic UUID, p_clinician_id UUID, p_changes JSONB
) RETURNS VOID AS $$
  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  SELECT p_exercise_id, p_media_clinic,
         CASE WHEN p_media_clinic IS NULL THEN 'master'
              WHEN e.clinic_id IS NULL THEN 'override'
              ELSE 'clinic' END,
         'media', p_changes, p_clinician_id
  FROM app.exercise e WHERE e.id = p_exercise_id;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION app._media_summary(m app.exercise_media) RETURNS JSONB AS $$
  SELECT jsonb_build_object('id', m.id, 'kind', m.kind, 'rights', m.rights, 'verified', m.verified_at IS NOT NULL,
                            'file', COALESCE(m.source_file, CASE WHEN m.kind = 'video' THEN m.url END));
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================================
-- catalog_media_add
-- p_media: {kind, path | youtube_id, thumb_path?, source_file?, width?, height?,
--           duration_ms?, mime_type?, size_bytes?, rights?, attribution?,
--           start_sec?, end_sec?, primary?: bool, verify?: bool}
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_add(p_clinician_id UUID, p_exercise_id UUID, p_media JSONB)
RETURNS JSONB AS $$
DECLARE
  v_scope JSONB;
  v_target UUID;
  v_prefix TEXT;
  v_kind TEXT := p_media ->> 'kind';
  v_path TEXT;
  v_thumb TEXT := NULLIF(p_media ->> 'thumb_path', '');
  v_rights TEXT;
  v_start INT;
  v_end INT;
  v_verify BOOLEAN := COALESCE((p_media ->> 'verify')::boolean, false);
  v_primary BOOLEAN := COALESCE((p_media ->> 'primary')::boolean, false);
  v_order INT;
  v_row app.exercise_media;
BEGIN
  v_scope := app._media_scope(p_clinician_id, p_exercise_id);
  IF v_scope ? 'error' THEN
    RETURN v_scope;
  END IF;
  v_target := (v_scope ->> 'target_clinic_id')::uuid;
  v_prefix := v_scope ->> 'prefix';

  IF v_kind IS NULL OR v_kind NOT IN ('image', 'gif', 'clip', 'video') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_kind');
  END IF;

  v_rights := COALESCE(NULLIF(p_media ->> 'rights', ''), CASE WHEN v_kind = 'video' THEN 'embed' ELSE 'unknown' END);
  IF v_rights NOT IN ('unknown', 'own', 'licensed', 'open', 'embed') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_rights');
  END IF;
  IF v_verify AND v_rights = 'unknown' THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'rights_required');
  END IF;
  IF length(p_media ->> 'attribution') > 300 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'too_long');
  END IF;

  BEGIN
    v_start := NULLIF(p_media ->> 'start_sec', '')::int;
    v_end := NULLIF(p_media ->> 'end_sec', '')::int;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_trim');
  END;
  IF (v_start IS NOT NULL AND v_start < 0) OR (v_end IS NOT NULL AND v_end <= COALESCE(v_start, 0)) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_trim');
  END IF;

  IF v_kind = 'video' THEN
    v_path := p_media ->> 'youtube_id';
    IF v_path IS NULL OR v_path !~ '^[A-Za-z0-9_-]{11}$' THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_youtube_id');
    END IF;
    v_thumb := NULL;
  ELSE
    v_path := p_media ->> 'path';
    IF v_path IS NULL OR left(v_path, length(v_prefix)) <> v_prefix OR v_path LIKE '%..%'
       OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'exercise-media' AND name = v_path) THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_path');
    END IF;
    IF v_thumb IS NOT NULL AND (left(v_thumb, length(v_prefix)) <> v_prefix OR v_thumb LIKE '%..%'
       OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'exercise-media' AND name = v_thumb)) THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_thumb_path');
    END IF;
    IF v_kind = 'clip' AND v_thumb IS NULL THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'thumb_required');
    END IF;
  END IF;

  IF v_primary THEN
    UPDATE app.exercise_media SET "order" = "order" + 1
    WHERE exercise_id = p_exercise_id AND clinic_id IS NOT DISTINCT FROM v_target;
    v_order := 0;
  ELSE
    SELECT COALESCE(max("order") + 1, 0) INTO v_order FROM app.exercise_media
    WHERE exercise_id = p_exercise_id AND clinic_id IS NOT DISTINCT FROM v_target;
  END IF;

  BEGIN
    INSERT INTO app.exercise_media (
      exercise_id, clinic_id, kind, url, thumb_url, width, height, duration_ms, "order", source_file,
      mime_type, size_bytes, rights, attribution, start_sec, end_sec, uploaded_by, verified_by, verified_at
    ) VALUES (
      p_exercise_id, v_target, v_kind, v_path, v_thumb,
      NULLIF(p_media ->> 'width', '')::int, NULLIF(p_media ->> 'height', '')::int,
      NULLIF(p_media ->> 'duration_ms', '')::int, v_order, left(NULLIF(p_media ->> 'source_file', ''), 200),
      left(NULLIF(p_media ->> 'mime_type', ''), 100), NULLIF(p_media ->> 'size_bytes', '')::bigint,
      v_rights, NULLIF(btrim(p_media ->> 'attribution'), ''), v_start, v_end, p_clinician_id,
      CASE WHEN v_verify THEN p_clinician_id END, CASE WHEN v_verify THEN now() END
    )
    RETURNING * INTO v_row;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'video_exists');
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_value');
  END;

  PERFORM app._media_history(p_exercise_id, v_target, p_clinician_id,
    jsonb_build_object('media', jsonb_build_object('from', NULL, 'to', app._media_summary(v_row))));

  RETURN jsonb_build_object('ok', true, 'id', v_row.id, 'scope', v_scope ->> 'scope');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_add(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_add(UUID, UUID, JSONB) TO authenticated, service_role;

-- A media row the caller may manage, locked; NULL when not visible or not theirs.
CREATE OR REPLACE FUNCTION app._media_for_manage(p_clinician_id UUID, p_media_id UUID, OUT r app.exercise_media, OUT reason TEXT)
AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    reason := 'forbidden';
    RETURN;
  END IF;
  SELECT m.* INTO r FROM app.exercise_media m
  JOIN app.exercise e ON e.id = m.exercise_id AND e.deleted_at IS NULL AND (e.clinic_id IS NULL OR e.clinic_id = v_clinic_id)
  WHERE m.id = p_media_id AND (m.clinic_id IS NULL OR m.clinic_id = v_clinic_id)
  FOR UPDATE OF m;
  IF r.id IS NULL THEN
    reason := 'not_found';
  ELSIF r.clinic_id IS NULL AND NOT app.is_catalog_curator(p_clinician_id) THEN
    r := NULL;
    reason := 'forbidden';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app._media_for_manage(UUID, UUID) FROM PUBLIC;

-- ============================================================================
-- catalog_media_update: rights, attribution, trim, note. Downgrading rights to
-- unknown also withdraws verification.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_update(p_clinician_id UUID, p_media_id UUID, p_patch JSONB)
RETURNS JSONB AS $$
DECLARE
  v_found RECORD;
  v_old app.exercise_media;
  v_new app.exercise_media;
  v_key TEXT;
BEGIN
  SELECT * INTO v_found FROM app._media_for_manage(p_clinician_id, p_media_id);
  IF v_found.reason IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_found.reason);
  END IF;
  v_old := v_found.r;
  v_new := v_old;

  FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_patch, '{}'::jsonb)) LOOP
    IF v_key NOT IN ('rights', 'attribution', 'start_sec', 'end_sec', 'review_note') THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'unknown_field', 'field', v_key);
    END IF;
  END LOOP;

  BEGIN
    IF p_patch ? 'rights' THEN v_new.rights := p_patch ->> 'rights'; END IF;
    IF p_patch ? 'attribution' THEN v_new.attribution := left(NULLIF(btrim(p_patch ->> 'attribution'), ''), 300); END IF;
    IF p_patch ? 'review_note' THEN v_new.review_note := left(NULLIF(btrim(p_patch ->> 'review_note'), ''), 500); END IF;
    IF p_patch ? 'start_sec' THEN v_new.start_sec := NULLIF(p_patch ->> 'start_sec', '')::int; END IF;
    IF p_patch ? 'end_sec' THEN v_new.end_sec := NULLIF(p_patch ->> 'end_sec', '')::int; END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_value');
  END;

  IF v_new.rights NOT IN ('unknown', 'own', 'licensed', 'open', 'embed') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_rights');
  END IF;
  IF (v_new.start_sec IS NOT NULL AND v_new.start_sec < 0)
     OR (v_new.end_sec IS NOT NULL AND v_new.end_sec <= COALESCE(v_new.start_sec, 0)) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_trim');
  END IF;
  IF v_new.rights = 'unknown' AND v_old.rights <> 'unknown' THEN
    v_new.verified_at := NULL;
    v_new.verified_by := NULL;
  END IF;

  UPDATE app.exercise_media SET
    rights = v_new.rights, attribution = v_new.attribution, review_note = v_new.review_note,
    start_sec = v_new.start_sec, end_sec = v_new.end_sec,
    verified_at = v_new.verified_at, verified_by = v_new.verified_by
  WHERE id = p_media_id;

  PERFORM app._media_history(v_old.exercise_id, v_old.clinic_id, p_clinician_id,
    jsonb_build_object('media', jsonb_build_object('from', app._media_summary(v_old), 'to', app._media_summary(v_new))));

  RETURN jsonb_build_object('ok', true, 'id', p_media_id, 'verified', v_new.verified_at IS NOT NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_update(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_update(UUID, UUID, JSONB) TO authenticated, service_role;

-- ============================================================================
-- catalog_media_reorder: p_ids = the complete media list of the caller's
-- scope for this exercise, in the new order (first = primary).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_reorder(p_clinician_id UUID, p_exercise_id UUID, p_ids UUID[])
RETURNS JSONB AS $$
DECLARE
  v_scope JSONB;
  v_target UUID;
BEGIN
  v_scope := app._media_scope(p_clinician_id, p_exercise_id);
  IF v_scope ? 'error' THEN
    RETURN v_scope;
  END IF;
  v_target := (v_scope ->> 'target_clinic_id')::uuid;

  IF p_ids IS NULL OR cardinality(p_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_ids) x)
     OR (SELECT array_agg(id ORDER BY id) FROM app.exercise_media WHERE exercise_id = p_exercise_id AND clinic_id IS NOT DISTINCT FROM v_target)
        IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_ids) x) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'ids_mismatch');
  END IF;

  UPDATE app.exercise_media m SET "order" = u.ord - 1
  FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
  WHERE m.id = u.id;

  PERFORM app._media_history(p_exercise_id, v_target, p_clinician_id,
    jsonb_build_object('media_order', jsonb_build_object('from', NULL, 'to', to_jsonb(p_ids))));

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_reorder(UUID, UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_reorder(UUID, UUID, UUID[]) TO authenticated, service_role;

-- ============================================================================
-- catalog_media_verify (bulk). Verifying needs known rights — either already
-- on the row or passed in p_rights (applied to every row in the call).
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_verify(
  p_clinician_id UUID, p_ids UUID[], p_verified BOOLEAN, p_rights TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_id UUID;
  v_found RECORD;
  v_old app.exercise_media;
  v_rights TEXT;
  v_updated INT := 0;
  v_skipped JSONB := '[]'::jsonb;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_ids');
  END IF;
  IF p_rights IS NOT NULL AND p_rights NOT IN ('own', 'licensed', 'open', 'embed') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_rights');
  END IF;

  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_ids) x) LOOP
    SELECT * INTO v_found FROM app._media_for_manage(p_clinician_id, v_id);
    IF v_found.reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', v_found.reason);
      CONTINUE;
    END IF;
    v_old := v_found.r;
    v_rights := COALESCE(p_rights, v_old.rights);

    IF p_verified AND v_rights = 'unknown' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'rights_unknown');
      CONTINUE;
    END IF;
    IF (v_old.verified_at IS NOT NULL) = p_verified AND v_rights = v_old.rights THEN
      CONTINUE;
    END IF;

    UPDATE app.exercise_media SET
      rights = v_rights,
      verified_at = CASE WHEN p_verified THEN now() END,
      verified_by = CASE WHEN p_verified THEN p_clinician_id END,
      review_note = COALESCE(left(NULLIF(btrim(p_note), ''), 500), review_note)
    WHERE id = v_id;

    PERFORM app._media_history(v_old.exercise_id, v_old.clinic_id, p_clinician_id,
      jsonb_build_object('media', jsonb_build_object(
        'from', app._media_summary(v_old),
        'to', app._media_summary(v_old) || jsonb_build_object('verified', p_verified, 'rights', v_rights))));
    v_updated := v_updated + 1;
  END LOOP;

  RETURN jsonb_build_object('updated', v_updated, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_verify(UUID, UUID[], BOOLEAN, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_verify(UUID, UUID[], BOOLEAN, TEXT, TEXT) TO authenticated, service_role;

-- ============================================================================
-- catalog_media_remove: deletes the row (media is content, not a clinical
-- record) and returns the uploaded Storage objects that nothing else
-- references, for the API to delete. Dataset objects are never returned.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_remove(p_clinician_id UUID, p_media_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_found RECORD;
  v_old app.exercise_media;
  v_paths TEXT[];
BEGIN
  SELECT * INTO v_found FROM app._media_for_manage(p_clinician_id, p_media_id);
  IF v_found.reason IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_found.reason);
  END IF;
  v_old := v_found.r;

  DELETE FROM app.exercise_media WHERE id = p_media_id;

  -- close the gap so the remaining order stays 0..n-1
  UPDATE app.exercise_media m SET "order" = s.rn - 1
  FROM (
    SELECT id, row_number() OVER (ORDER BY "order", created_at) AS rn
    FROM app.exercise_media
    WHERE exercise_id = v_old.exercise_id AND clinic_id IS NOT DISTINCT FROM v_old.clinic_id
  ) s
  WHERE m.id = s.id;

  SELECT COALESCE(array_agg(p), '{}') INTO v_paths
  FROM unnest(ARRAY[v_old.url, v_old.thumb_url]) p
  WHERE p LIKE 'uploads/%'
    AND NOT EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.url = p OR m.thumb_url = p);

  PERFORM app._media_history(v_old.exercise_id, v_old.clinic_id, p_clinician_id,
    jsonb_build_object('media', jsonb_build_object('from', app._media_summary(v_old), 'to', NULL)));

  RETURN jsonb_build_object('ok', true, 'delete_paths', to_jsonb(v_paths));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_remove(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_remove(UUID, UUID) TO authenticated, service_role;

-- ============================================================================
-- catalog_media_queue: media the caller manages (curator: master + own
-- clinic; everyone else: own clinic), for review.
-- p_filters: {status: pending|verified|rights_unknown|all (default pending),
--             source: dataset|upload|youtube, exercise_status}
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_queue(
  p_clinician_id UUID, p_filters JSONB DEFAULT '{}'::jsonb, p_limit INT DEFAULT 48, p_offset INT DEFAULT 0
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_is_curator BOOLEAN;
  v_status TEXT := COALESCE(NULLIF(p_filters ->> 'status', ''), 'pending');
  v_source TEXT := NULLIF(p_filters ->> 'source', '');
  v_ex_status TEXT := NULLIF(p_filters ->> 'exercise_status', '');
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 48), 1), 200);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  v_is_curator := app.is_catalog_curator(p_clinician_id);

  WITH base AS (
    SELECT m.*, e.name AS ex_name, e.name_en AS ex_name_en, e.status AS ex_status, e.clinic_id AS ex_clinic_id,
      CASE WHEN m.kind = 'video' THEN 'youtube' WHEN m.url LIKE 'dataset/%' THEN 'dataset' ELSE 'upload' END AS source
    FROM app.exercise_media m
    JOIN app.exercise e ON e.id = m.exercise_id AND e.is_active AND e.deleted_at IS NULL
      AND (e.clinic_id IS NULL OR e.clinic_id = v_clinic_id)
    WHERE (m.clinic_id = v_clinic_id OR (m.clinic_id IS NULL AND v_is_curator))
      AND (v_ex_status IS NULL OR e.status = v_ex_status)
  ),
  sourced AS (
    SELECT * FROM base WHERE v_source IS NULL OR source = v_source
  ),
  matched AS (
    SELECT * FROM sourced
    WHERE CASE v_status
      WHEN 'pending' THEN verified_at IS NULL
      WHEN 'verified' THEN verified_at IS NOT NULL
      WHEN 'rights_unknown' THEN rights = 'unknown'
      ELSE true END
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matched),
    'counts', (SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE verified_at IS NULL),
      'verified', count(*) FILTER (WHERE verified_at IS NOT NULL),
      'rights_unknown', count(*) FILTER (WHERE rights = 'unknown'),
      'all', count(*)) FROM sourced),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'url', p.url, 'thumb_url', p.thumb_url, 'width', p.width, 'height', p.height,
        'duration_ms', p.duration_ms, 'source_file', p.source_file, 'rights', p.rights, 'attribution', p.attribution,
        'start_sec', p.start_sec, 'end_sec', p.end_sec, 'verified', p.verified_at IS NOT NULL,
        'review_note', p.review_note, 'source', p.source, 'scope', CASE WHEN p.clinic_id IS NULL THEN 'master' ELSE 'clinic' END,
        'exercise', jsonb_build_object('id', p.exercise_id, 'name', p.ex_name, 'name_en', p.ex_name_en,
                                       'status', p.ex_status, 'is_clinic_owned', p.ex_clinic_id IS NOT NULL)
      ) ORDER BY p.rk)
      FROM (
        SELECT m.*, row_number() OVER (ORDER BY (m.ex_status = 'approved') DESC, m.ex_name, m.exercise_id, m."order", m.id) AS rk
        FROM matched m
        ORDER BY rk
        LIMIT v_limit OFFSET v_offset
      ) p
    ), '[]'::jsonb),
    'viewer', jsonb_build_object('is_curator', v_is_curator)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_queue(UUID, JSONB, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_queue(UUID, JSONB, INT, INT) TO authenticated, service_role;

-- ============================================================================
-- catalog_media_match: normalized file names -> best exercise candidates.
-- Names arrive normalized (packages/shared normalizeMediaFilename): lower
-- case, extension and numeric prefixes stripped, separators to spaces.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.catalog_media_match(p_clinician_id UUID, p_names TEXT[])
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_names IS NULL OR cardinality(p_names) = 0 OR cardinality(p_names) > 100 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_names');
  END IF;

  RETURN jsonb_build_object('items', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', n.name, 'candidates', c.candidates) ORDER BY n.ord), '[]'::jsonb)
    FROM unnest(p_names) WITH ORDINALITY AS n(name, ord)
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'name_en', s.name_en, 'status', s.status,
        'is_clinic_owned', s.clinic_id IS NOT NULL, 'score', round(s.score::numeric, 2),
        'media_count', (SELECT count(*) FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = s.id)
      ) ORDER BY s.score DESC, s.name), '[]'::jsonb) AS candidates
      FROM (
        SELECT ex.id, ex.name, ex.name_en, ex.status, ex.clinic_id,
          GREATEST(
            extensions.similarity(lower(COALESCE(ex.name_en, '')), lower(n.name)),
            extensions.similarity(lower(ex.name), lower(n.name)),
            CASE WHEN app.exercise_name_key(ex.name_en) = app.exercise_name_key(n.name) THEN 1 ELSE 0 END,
            CASE WHEN EXISTS (SELECT 1 FROM unnest(ex.aliases) a WHERE lower(a) = lower(n.name)) THEN 1 ELSE 0 END
          ) AS score
        FROM app.exercise ex
        WHERE ex.is_active AND ex.deleted_at IS NULL AND ex.status <> 'archived'
          AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
          AND NULLIF(btrim(n.name), '') IS NOT NULL
        ORDER BY 6 DESC, ex.name
        LIMIT 3
      ) s
      WHERE s.score >= 0.3
    ) c
  ));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_media_match(UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_media_match(UUID, TEXT[]) TO authenticated, service_role;

-- ============================================================================
-- set_exercise_video (legacy single-video endpoint): now scope-aware.
-- ============================================================================
CREATE OR REPLACE FUNCTION app.set_exercise_video(p_clinician_id UUID, p_exercise_id UUID, p_youtube_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_scope JSONB;
  v_target UUID;
  v_existing UUID;
BEGIN
  v_scope := app._media_scope(p_clinician_id, p_exercise_id);
  IF v_scope ? 'error' THEN
    RETURN v_scope;
  END IF;
  v_target := (v_scope ->> 'target_clinic_id')::uuid;
  SELECT id INTO v_existing FROM app.exercise_media
  WHERE exercise_id = p_exercise_id AND kind = 'video' AND clinic_id IS NOT DISTINCT FROM v_target;

  IF p_youtube_id IS NULL OR p_youtube_id = '' THEN
    IF v_existing IS NOT NULL THEN
      RETURN app.catalog_media_remove(p_clinician_id, v_existing) || jsonb_build_object('video', NULL);
    END IF;
    RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'video', NULL);
  END IF;
  IF p_youtube_id !~ '^[A-Za-z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_youtube_id');
  END IF;
  IF v_existing IS NOT NULL THEN
    UPDATE app.exercise_media SET url = p_youtube_id, verified_by = p_clinician_id, verified_at = now() WHERE id = v_existing;
    RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'video', p_youtube_id);
  END IF;
  RETURN app.catalog_media_add(p_clinician_id, p_exercise_id,
    jsonb_build_object('kind', 'video', 'youtube_id', p_youtube_id, 'rights', 'embed', 'verify', true))
    || jsonb_build_object('video', p_youtube_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Every media read goes through app.exercise_media_visible: a clinic sees
-- master media plus its own, its own first. Bodies below are the current
-- (0031/0032) definitions with only the media access changed.
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
      EXISTS (SELECT 1 FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = ex.id) AS has_media,
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
        CASE WHEN m.kind = 'image' THEN m.url ELSE COALESCE(m.thumb_url, m.url) END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media_visible(v_clinic_id) m
      WHERE m.exercise_id = ex.id AND (m.kind IN ('gif', 'image') OR (m.kind = 'clip' AND m.thumb_url IS NOT NULL))
      ORDER BY (m.clinic_id IS NULL), m."order"
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
        CASE WHEN m.kind = 'image' THEN m.url ELSE COALESCE(m.thumb_url, m.url) END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media_visible(p_clinic_id) m
      WHERE m.exercise_id = ex.id AND (m.kind IN ('gif', 'image') OR (m.kind = 'clip' AND m.thumb_url IS NOT NULL))
      ORDER BY (m.clinic_id IS NULL), m."order"
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

CREATE OR REPLACE FUNCTION app.get_exercise(p_clinician_id uuid, p_exercise_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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
        'verified', m.verified_at IS NOT NULL, 'verified_at', m.verified_at,
        'start_sec', m.start_sec, 'end_sec', m.end_sec
      ) ORDER BY (m.clinic_id IS NULL), m."order")
      FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = ex.id
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
$function$;

CREATE OR REPLACE FUNCTION app._catalog_completeness_for(p_clinic_id uuid, p_exercise_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object('completeness', c.score, 'missing', to_jsonb(c.missing))
  FROM app.exercise_effective(p_clinic_id) e
  CROSS JOIN LATERAL app.exercise_completeness(
    e.name, e.name_en, e.body_region_id, e.instructions, e.description, e.key_cues,
    e.safety_notes, e.contraindications, e.muscles, e.start_position, e.difficulty,
    EXISTS (SELECT 1 FROM app.exercise_media_visible(p_clinic_id) m WHERE m.exercise_id = e.id)) c
  WHERE e.id = p_exercise_id;
$function$;

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

CREATE OR REPLACE FUNCTION app.catalog_search(p_clinician_id uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 60, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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
      (md.thumb_path IS NOT NULL OR EXISTS (SELECT 1 FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = e.id)) AS has_media,
      EXISTS (SELECT 1 FROM app.exercise_media_visible(v_clinic_id) m WHERE m.exercise_id = e.id AND m.verified_at IS NOT NULL) AS has_verified_media,
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
        CASE WHEN m.kind = 'image' THEN m.url ELSE COALESCE(m.thumb_url, m.url) END AS thumb_path,
        CASE WHEN m.kind = 'gif' THEN m.url END AS gif_path,
        m.verified_at IS NOT NULL AS verified
      FROM app.exercise_media_visible(v_clinic_id) m
      WHERE m.exercise_id = e.id AND (m.kind IN ('gif', 'image') OR (m.kind = 'clip' AND m.thumb_url IS NOT NULL))
      ORDER BY (m.clinic_id IS NULL), m."order"
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
      (v_media IS NULL
        OR (v_media = 'with' AND s.has_media) OR (v_media = 'without' AND NOT s.has_media)
        OR (v_media = 'verified' AND s.has_verified_media)
        OR (v_media = 'unverified' AND s.has_media AND NOT s.has_verified_media)) AS f_media,
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
        'thumb_path', p.thumb_path, 'gif_path', p.gif_path, 'media_verified', p.media_verified, 'has_verified_media', p.has_verified_media,
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
          jsonb_build_object('value', 'without', 'count', count(*) FILTER (WHERE NOT has_media)),
          jsonb_build_object('value', 'verified', 'count', count(*) FILTER (WHERE has_verified_media)),
          jsonb_build_object('value', 'unverified', 'count', count(*) FILTER (WHERE has_media AND NOT has_verified_media))
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
$function$;

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
            'width', m.width, 'height', m.height, 'start_sec', m.start_sec, 'end_sec', m.end_sec
          ) ORDER BY (m.clinic_id IS NULL), m."order")
          FROM app.exercise_media_visible(app.clinic_id_for_schema(v_schema)) m
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
            'width', m.width, 'height', m.height, 'start_sec', m.start_sec, 'end_sec', m.end_sec
          ) ORDER BY (m.clinic_id IS NULL), m."order")
          FROM app.exercise_media_visible(app.clinic_id_for_schema(v_schema)) m
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
