-- Let a clinic attach a single supplementary YouTube video to an exercise it
-- owns. The clinician pastes a URL or bare id; packages/shared's
-- parseYouTubeId() resolves it to the 11-char video id client-side, and this
-- RPC re-validates that shape server-side. Only the id is stored in
-- app.exercise_media.url ('video' was already a valid `kind` — see
-- 0001_initial_schema.sql — just never populated) — no Storage upload, no
-- signed-URL cache entry, since the thumbnail/embed URLs are derived from the
-- id on read (packages/shared/src/youtube.ts).
--
-- One video per exercise: re-calling with a new id replaces it, NULL/'' clears
-- it. Unlike dataset-ingested media (unverified until reviewed — see
-- scripts/ingest-exercises.ts, CLAUDE.md §Media), a clinician attaching their
-- own video is content they authored, so it's verified immediately and
-- reaches the patient app / print program on save without a separate review
-- step.

CREATE UNIQUE INDEX IF NOT EXISTS exercise_media_one_video_idx
  ON app.exercise_media(exercise_id) WHERE kind = 'video';

CREATE OR REPLACE FUNCTION app.set_exercise_video(
  p_clinician_id UUID,
  p_exercise_id UUID,
  p_youtube_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_owns BOOLEAN;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Only clinic-owned exercises are editable (same rule as
  -- delete_custom_exercise / create_custom_exercise): system-library rows must
  -- be duplicated into a clinic copy first.
  SELECT EXISTS (
    SELECT 1 FROM app.exercise
    WHERE id = p_exercise_id AND source = 'clinic' AND clinic_id = v_clinic_id AND deleted_at IS NULL
  ) INTO v_owns;
  IF NOT v_owns THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF p_youtube_id IS NULL OR p_youtube_id = '' THEN
    DELETE FROM app.exercise_media WHERE exercise_id = p_exercise_id AND kind = 'video';
    RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'video', NULL);
  END IF;

  IF p_youtube_id !~ '^[A-Za-z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_youtube_id');
  END IF;

  INSERT INTO app.exercise_media (exercise_id, kind, url, "order", verified_by, verified_at)
  VALUES (p_exercise_id, 'video', p_youtube_id, 2, p_clinician_id, now())
  ON CONFLICT (exercise_id) WHERE kind = 'video'
  DO UPDATE SET url = EXCLUDED.url, verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at;

  RETURN jsonb_build_object('ok', true, 'id', p_exercise_id, 'video', p_youtube_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.set_exercise_video(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_exercise_video(UUID, UUID, TEXT) TO authenticated, service_role;
