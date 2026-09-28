-- ============================================================================
-- Patient session feedback in the clinician app.
--
-- The patient app records per-exercise feedback on session_item (pain 0-10,
-- difficulty, free-text note, skipped + reason), but nothing on the
-- clinician side read it: the History tab and activity cards only showed a
-- session's status and completion %, and a note reached the clinician only
-- inside a pain_spike push. This adds:
--
--   1. app.patient_sessions — recent sessions with every item's feedback,
--      for the History tab's per-session detail and the Overview's
--      "recent notes" card.
--   2. patient.feedback_seen_at + app.mark_feedback_seen — when the clinic
--      last looked at this patient's feedback. One marker per patient (not
--      per clinician): patients have one primary clinician, and "has anyone
--      at the clinic seen this note" is the question the badge answers.
--   3. app.unseen_feedback — per-patient count of notes the clinic hasn't
--      seen, for the "new note" badge on the dashboard and patient list.
--      Uses synced_at (server time), not logged_at: an offline session
--      logged yesterday and synced today is still new today.
-- ============================================================================

CREATE OR REPLACE FUNCTION add_clinic_columns(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format($f$
    ALTER TABLE %1$I.plan ADD COLUMN IF NOT EXISTS base_protocol_version_id UUID
      REFERENCES app.protocol_version(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS plan_base_protocol_version_idx ON %1$I.plan(base_protocol_version_id);

    -- 0059
    ALTER TABLE %1$I.patient ADD COLUMN IF NOT EXISTS feedback_seen_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS session_item_note_synced_idx ON %1$I.session_item(synced_at)
      WHERE note IS NOT NULL AND btrim(note) <> '';
  $f$, p_schema);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT 'clinic_' || slug AS s FROM app.clinic LOOP
    IF to_regnamespace(r.s) IS NOT NULL THEN
      PERFORM add_clinic_columns(r.s);
      -- Don't light the badge for the whole back catalogue on day one, but
      -- do for the last week: those notes were never visible anywhere.
      EXECUTE format('UPDATE %I.patient SET feedback_seen_at = now() - interval ''7 days'' WHERE feedback_seen_at IS NULL', r.s);
    END IF;
  END LOOP;
END $$;

-- --- 1. Sessions with per-exercise feedback ---------------------------------

CREATE OR REPLACE FUNCTION app.patient_sessions(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_limit INT DEFAULT 30
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT jsonb_build_object(
    'feedback_seen_at', (SELECT feedback_seen_at FROM patient WHERE id = p_patient_id),
    'sessions', COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.id, 'date', s.date, 'status', s.status,
      'items_planned', s.items_planned, 'items_done', s.items_done,
      'completion_ratio', s.completion_ratio,
      'items', COALESCE(items.list, '[]'::jsonb)
    ) ORDER BY s.date DESC), '[]'::jsonb)
  )
  INTO v_result
  FROM (
    SELECT * FROM session
    WHERE patient_id = p_patient_id
    ORDER BY date DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 120)
  ) s
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', si.id, 'exercise_id', pe.exercise_id, 'name', ex.name, 'name_en', ex.name_en,
      'sets_done', si.sets_done, 'reps_done', si.reps_done, 'load_used', si.load_used,
      'pain_score', si.pain_score, 'difficulty', si.difficulty,
      'skipped', si.skipped, 'skip_reason', si.skip_reason,
      'note', NULLIF(btrim(si.note), ''),
      'logged_at', si.logged_at, 'synced_at', si.synced_at
    ) ORDER BY si.logged_at, pe."order") AS list
    FROM session_item si
    JOIN plan_exercise pe ON pe.id = si.plan_exercise_id
    JOIN app.exercise ex ON ex.id = pe.exercise_id
    WHERE si.session_id = s.id
  ) items ON true;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'read', 'patient_sessions', p_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --- 2. Seen marker ---------------------------------------------------------

CREATE OR REPLACE FUNCTION app.mark_feedback_seen(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_rows INT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE patient SET feedback_seen_at = now()
  WHERE id = p_patient_id AND deleted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --- 3. Unseen notes per patient --------------------------------------------

CREATE OR REPLACE FUNCTION app.unseen_feedback(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'patient_id', x.patient_id, 'count', x.cnt, 'latest_at', x.latest_at
  )), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT s.patient_id, count(*) AS cnt, max(si.synced_at) AS latest_at
    FROM session_item si
    JOIN session s ON s.id = si.session_id
    JOIN patient p ON p.id = s.patient_id AND p.deleted_at IS NULL
    WHERE si.note IS NOT NULL AND btrim(si.note) <> ''
      AND si.synced_at > COALESCE(p.feedback_seen_at, '-infinity'::timestamptz)
    GROUP BY s.patient_id
  ) x;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.patient_sessions(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.patient_sessions(UUID, UUID, INT) TO service_role;
REVOKE ALL ON FUNCTION app.mark_feedback_seen(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.mark_feedback_seen(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION app.unseen_feedback(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unseen_feedback(UUID) TO service_role;
