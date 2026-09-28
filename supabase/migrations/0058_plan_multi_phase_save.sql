-- ============================================================================
-- Edit several phases of a patient's plan in one save.
--
-- 1. app.save_plan_version_phases — same semantics as save_plan_version
--    (0001), but takes an array of phase edits and writes them all into ONE
--    new plan_version. EditPlan keeps a draft per phase, so switching phases
--    no longer discards edits. An edit to a phase the plan doesn't have is
--    rejected (phase_not_found) instead of being silently dropped, as the old
--    function did for unreached phases. save_plan_version is left in place so
--    a not-yet-redeployed plan function keeps working.
--
-- 2. notifications_reconcile — plan_updated now compares only the patient's
--    current phase. Since 0057 plans hold every phase, and a clinician
--    adjusting a phase the patient hasn't reached shouldn't push "your plan
--    was updated" for something they can't see yet. Otherwise identical to
--    0009.
-- ============================================================================

-- p_phases: [{phase_n, exercises: [...], removal_reasons: {plan_exercise_id: reason}, criteria: [...]|null}]
-- Exercise/criterion element shapes are the same as save_plan_version's.
CREATE OR REPLACE FUNCTION app.save_plan_version_phases(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_base_version INT,
  p_phases JSONB,
  p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_plan_id UUID;
  v_old_version_id UUID;
  v_old_version_n INT;
  v_new_version_id UUID;
  v_old_phase RECORD;
  v_new_phase_id UUID;
  v_edits JSONB := '{}'::jsonb;
  v_edit JSONB;
  v_phase_n INT;
  v_old_active_ids UUID[];
  v_submitted_ids UUID[];
  v_removed_ids UUID[];
  v_removed_all UUID[] := ARRAY[]::uuid[];
  v_reasons JSONB := '{}'::jsonb;
  v_missing_reason UUID;
  v_ex JSONB;
  v_crit JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id INTO v_plan_id FROM plan WHERE patient_id = p_patient_id;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id, version INTO v_old_version_id, v_old_version_n
  FROM plan_version WHERE plan_id = v_plan_id AND is_current = true;

  IF v_old_version_n IS DISTINCT FROM p_base_version THEN
    RETURN jsonb_build_object('error', 'plan_version_conflict', 'current_version', v_old_version_n);
  END IF;

  IF p_phases IS NULL OR jsonb_typeof(p_phases) != 'array' OR jsonb_array_length(p_phases) = 0 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'phases_required');
  END IF;

  -- Validate everything before the first write: an error returned (not
  -- raised) after a write would still commit it.
  FOR v_edit IN SELECT * FROM jsonb_array_elements(p_phases) LOOP
    v_phase_n := (v_edit->>'phase_n')::int;
    IF v_phase_n IS NULL OR jsonb_typeof(v_edit->'exercises') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_phase_edit');
    END IF;
    IF v_edits ? v_phase_n::text THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'duplicate_phase');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM plan_phase WHERE plan_version_id = v_old_version_id AND n = v_phase_n) THEN
      RETURN jsonb_build_object('error', 'phase_not_found', 'phase_n', v_phase_n);
    END IF;
    v_edits := v_edits || jsonb_build_object(v_phase_n::text, v_edit);

    SELECT array_agg(pe.id) INTO v_old_active_ids
    FROM plan_exercise pe
    JOIN plan_phase pp ON pp.id = pe.plan_phase_id
    WHERE pp.plan_version_id = v_old_version_id AND pp.n = v_phase_n AND pe.deleted_at IS NULL;

    SELECT array_agg((e->>'plan_exercise_id')::uuid) INTO v_submitted_ids
    FROM jsonb_array_elements(v_edit->'exercises') e
    WHERE e->>'plan_exercise_id' IS NOT NULL;

    SELECT array_agg(id) INTO v_removed_ids
    FROM unnest(COALESCE(v_old_active_ids, ARRAY[]::uuid[])) id
    WHERE id != ALL(COALESCE(v_submitted_ids, ARRAY[]::uuid[]));

    SELECT id INTO v_missing_reason
    FROM unnest(COALESCE(v_removed_ids, ARRAY[]::uuid[])) id
    WHERE NOT (COALESCE(v_edit->'removal_reasons', '{}'::jsonb) ? id::text)
       OR trim(v_edit->'removal_reasons'->>id::text) = '';

    IF v_missing_reason IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'removal_reason_required', 'phase_n', v_phase_n);
    END IF;

    v_removed_all := v_removed_all || COALESCE(v_removed_ids, ARRAY[]::uuid[]);
    v_reasons := v_reasons || COALESCE(v_edit->'removal_reasons', '{}'::jsonb);
  END LOOP;

  -- Flip the old version off first (plan_version_current_once).
  UPDATE plan_version SET is_current = false WHERE id = v_old_version_id;

  INSERT INTO plan_version (plan_id, version, created_by, note, is_current)
  VALUES (v_plan_id, v_old_version_n + 1, p_clinician_id, p_note, true)
  RETURNING id INTO v_new_version_id;

  FOR v_old_phase IN SELECT * FROM plan_phase WHERE plan_version_id = v_old_version_id ORDER BY n LOOP
    INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at, completed_at)
    VALUES (v_new_version_id, v_old_phase.n, v_old_phase.name, v_old_phase.duration_days, v_old_phase.started_at, v_old_phase.completed_at)
    RETURNING id INTO v_new_phase_id;

    v_edit := v_edits->(v_old_phase.n::text);

    IF v_edit IS NOT NULL AND jsonb_typeof(v_edit->'criteria') = 'array' THEN
      FOR v_crit IN SELECT * FROM jsonb_array_elements(v_edit->'criteria') LOOP
        INSERT INTO plan_criterion (
          plan_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at
        )
        SELECT
          v_new_phase_id, v_crit->>'type', v_crit->>'label', v_crit->>'label_en',
          v_crit->>'operator', (v_crit->>'value')::numeric, v_crit->>'unit', COALESCE((v_crit->>'order')::int, 0),
          COALESCE(
            (SELECT is_met FROM plan_criterion WHERE id = NULLIF(v_crit->>'id', '')::uuid),
            false
          ),
          (SELECT met_at FROM plan_criterion WHERE id = NULLIF(v_crit->>'id', '')::uuid);
      END LOOP;
    ELSE
      INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at)
      SELECT v_new_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at
      FROM plan_criterion WHERE plan_phase_id = v_old_phase.id;
    END IF;

    IF v_edit IS NOT NULL THEN
      FOR v_ex IN SELECT * FROM jsonb_array_elements(v_edit->'exercises') LOOP
        INSERT INTO plan_exercise (
          plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
          side, frequency_days_per_week, schedule, "order", clinician_note, source
        )
        SELECT
          v_new_phase_id, (v_ex->>'exercise_id')::uuid,
          (v_ex->>'sets')::int, (v_ex->>'reps')::int, (v_ex->>'load')::numeric, v_ex->>'load_unit',
          v_ex->>'tempo', (v_ex->>'hold_sec')::int, (v_ex->>'rest_sec')::int, v_ex->>'side',
          (v_ex->>'frequency_days_per_week')::int, v_ex->'schedule', COALESCE((v_ex->>'order')::int, 0), v_ex->>'clinician_note',
          CASE WHEN v_ex->>'plan_exercise_id' IS NULL THEN 'added'
               ELSE COALESCE((SELECT source FROM plan_exercise WHERE id = (v_ex->>'plan_exercise_id')::uuid), 'modified')
          END;
      END LOOP;

      -- Exercises removed now carry over soft-deleted with their reason; ones
      -- removed in earlier versions carry over unchanged.
      INSERT INTO plan_exercise (
        plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
        side, frequency_days_per_week, schedule, "order", clinician_note, source, removed_reason, deleted_at
      )
      SELECT
        v_new_phase_id, pe.exercise_id, pe.sets, pe.reps, pe.load, pe.load_unit, pe.tempo, pe.hold_sec, pe.rest_sec,
        pe.side, pe.frequency_days_per_week, pe.schedule, pe."order", pe.clinician_note, pe.source,
        CASE WHEN pe.deleted_at IS NULL THEN v_reasons->>pe.id::text ELSE pe.removed_reason END,
        COALESCE(pe.deleted_at, now())
      FROM plan_exercise pe
      WHERE pe.plan_phase_id = v_old_phase.id
        AND (pe.deleted_at IS NOT NULL OR pe.id = ANY(v_removed_all));
    ELSE
      INSERT INTO plan_exercise (
        plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
        side, frequency_days_per_week, schedule, "order", clinician_note, removed_reason, source, deleted_at
      )
      SELECT
        v_new_phase_id, pe.exercise_id, pe.sets, pe.reps, pe.load, pe.load_unit, pe.tempo, pe.hold_sec, pe.rest_sec,
        pe.side, pe.frequency_days_per_week, pe.schedule, pe."order", pe.clinician_note, pe.removed_reason, pe.source, pe.deleted_at
      FROM plan_exercise pe WHERE pe.plan_phase_id = v_old_phase.id;
    END IF;
  END LOOP;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'plan_edit', 'plan', v_plan_id);

  RETURN jsonb_build_object('ok', true, 'version', v_old_version_n + 1, 'plan_version_id', v_new_version_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.save_plan_version_phases(UUID, UUID, INT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.save_plan_version_phases(UUID, UUID, INT, JSONB, TEXT) TO service_role;

-- Re-declared from 0009; only section 3 (plan_updated) differs.
CREATE OR REPLACE FUNCTION app.notifications_reconcile(p_schema TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id  UUID;
  v_clinic_tz  TEXT;
  v_app_url    TEXT := COALESCE(current_setting('app.base_url', true), 'http://localhost:5173');
  r            RECORD;
  v_new        INT := 0;
  v_local      TIMESTAMP;
  v_today      DATE;
  v_planned    BOOLEAN;
  v_completed  BOOLEAN;
  v_added      INT;
  v_removed    INT;
  v_changed    INT;
  v_prev_ver   UUID;
  v_cnt        INT;
  v_ex_name    TEXT;
  v_note       TEXT;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT c.timezone, c.id INTO v_clinic_tz, v_clinic_id
  FROM app.clinic c WHERE ('clinic_' || c.slug) = p_schema;
  IF v_clinic_id IS NULL THEN
    RETURN 0;
  END IF;

  -- 1. pain_spike + adherence_drop — one notification per alert -----------
  FOR r IN
    SELECT a.id, a.type, a.payload, a.patient_id, p.name AS pname, p.timezone AS ptz,
           p.primary_clinician_id AS clin
    FROM alert a
    JOIN patient p ON p.id = a.patient_id
    WHERE a.type IN ('pain_spike', 'adherence_drop')
      AND a.created_at > now() - interval '2 days'
      AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.dedupe_key = 'notif:' || a.type || ':' || a.id)
  LOOP
    IF r.type = 'pain_spike' THEN
      SELECT ex.name, si.note
      INTO v_ex_name, v_note
      FROM session_item si
      JOIN session s ON s.id = si.session_id
      JOIN plan_exercise pe ON pe.id = si.plan_exercise_id
      JOIN exercise ex ON ex.id = pe.exercise_id
      WHERE s.patient_id = r.patient_id AND si.pain_score IS NOT NULL
      ORDER BY si.logged_at DESC LIMIT 1;

      PERFORM app.notification_enqueue(
        p_schema, 'user', r.clin, 'pain_spike', 'push', 'pain', v_clinic_tz,
        jsonb_build_object(
          'patient_id', r.patient_id,
          'patient_name', r.pname,
          'pain_score', (r.payload ->> 'pain'),
          'exercise_name', COALESCE(v_ex_name, ''),
          'patient_note', COALESCE(v_note, ''),
          'phase_number', (SELECT current_phase_n FROM plan WHERE patient_id = r.patient_id)),
        'notif:pain_spike:' || r.id, true);
      v_new := v_new + 1;
    ELSE
      PERFORM app.notification_enqueue(
        p_schema, 'user', r.clin, 'adherence_drop', 'push', 'adherence', v_clinic_tz,
        jsonb_build_object(
          'patient_id', r.patient_id,
          'patient_name', r.pname,
          'adherence_pct', (r.payload ->> 'adherence'),
          'days_done', (SELECT count(*) FROM adherence_daily WHERE patient_id = r.patient_id AND planned AND completed AND date > (now() AT TIME ZONE r.ptz)::date - 7),
          'days_planned', (SELECT count(*) FROM adherence_daily WHERE patient_id = r.patient_id AND planned AND date > (now() AT TIME ZONE r.ptz)::date - 7)),
        'notif:adherence_drop:' || r.id, false);
      v_new := v_new + 1;
    END IF;
  END LOOP;

  -- 2. phase_approved — one per forward phase_transition ----------------
  FOR r IN
    SELECT pt.id, pt.to_phase_n, pl.patient_id, p.timezone AS ptz,
           u.name AS clin_name, pp.name AS phase_name
    FROM phase_transition pt
    JOIN plan pl ON pl.id = pt.plan_id
    JOIN patient p ON p.id = pl.patient_id
    JOIN app."user" u ON u.id = pt.approved_by
    LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
    LEFT JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pt.to_phase_n
    WHERE pt.approved_at > now() - interval '2 days'
      AND pt.direction = 'forward'
      AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.dedupe_key = 'notif:phase_approved:' || pt.id)
  LOOP
    PERFORM app.notification_enqueue(
      p_schema, 'patient', r.patient_id, 'phase_approved', 'push', 'plan_updates', r.ptz,
      jsonb_build_object('phase_number', r.to_phase_n, 'phase_name', COALESCE(r.phase_name, ''),
                         'clinician_name', r.clin_name),
      'notif:phase_approved:' || r.id, false);
    v_new := v_new + 1;
  END LOOP;

  -- 3. plan_updated — a non-reorder plan_version, batched to 10 minutes ---
  FOR r IN
    SELECT pv.id, pv.plan_id, pv.version, pv.created_at, pl.patient_id, pl.current_phase_n, p.timezone AS ptz
    FROM plan_version pv
    JOIN plan pl ON pl.id = pv.plan_id
    JOIN patient p ON p.id = pl.patient_id
    WHERE pv.version > 1
      AND pv.created_at > now() - interval '2 days'
  LOOP
    SELECT id INTO v_prev_ver FROM plan_version
    WHERE plan_id = r.plan_id AND version = r.version - 1;
    IF v_prev_ver IS NULL THEN CONTINUE; END IF;

    WITH new_ex AS (
      SELECT pe.exercise_id, pe.sets, pe.reps, pe.load, pe.hold_sec, pe.rest_sec, pe.side
      FROM plan_phase pp JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
      WHERE pp.plan_version_id = r.id AND pp.n = r.current_phase_n
    ),
    old_ex AS (
      SELECT pe.exercise_id, pe.sets, pe.reps, pe.load, pe.hold_sec, pe.rest_sec, pe.side
      FROM plan_phase pp JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
      WHERE pp.plan_version_id = v_prev_ver AND pp.n = r.current_phase_n
    )
    SELECT
      (SELECT count(*) FROM new_ex n WHERE NOT EXISTS (SELECT 1 FROM old_ex o WHERE o.exercise_id = n.exercise_id)),
      (SELECT count(*) FROM old_ex o WHERE NOT EXISTS (SELECT 1 FROM new_ex n WHERE n.exercise_id = o.exercise_id)),
      (SELECT count(*) FROM new_ex n JOIN old_ex o ON o.exercise_id = n.exercise_id
        WHERE (n.sets, n.reps, n.load, n.hold_sec, n.rest_sec, n.side)
              IS DISTINCT FROM (o.sets, o.reps, o.load, o.hold_sec, o.rest_sec, o.side))
    INTO v_added, v_removed, v_changed;

    IF COALESCE(v_added, 0) + COALESCE(v_removed, 0) + COALESCE(v_changed, 0) = 0 THEN
      CONTINUE;  -- reorder-only: silent (RULES §3)
    END IF;

    PERFORM app.notification_enqueue(
      p_schema, 'patient', r.patient_id, 'plan_updated', 'push', 'plan_updates', r.ptz,
      jsonb_build_object('added_count', v_added, 'changed_count', v_changed, 'removed_count', v_removed,
                         'clinician_name', ''),
      'notif:plan_updated:' || r.patient_id || ':' ||
        to_char(date_trunc('hour', r.created_at)
                + (floor(EXTRACT(MINUTE FROM r.created_at) / 10) * interval '10 min'), 'YYYYMMDDHH24MI'),
      false);
    v_new := v_new + 1;
  END LOOP;

  -- 4. daily_reminder — planned day not started, past 18:00 local ------
  FOR r IN
    SELECT p.id, p.timezone AS ptz, pl.started_at
    FROM patient p
    JOIN plan pl ON pl.patient_id = p.id AND pl.status = 'active'
    WHERE p.status = 'active' AND p.deleted_at IS NULL
  LOOP
    v_local := now() AT TIME ZONE r.ptz;
    CONTINUE WHEN EXTRACT(HOUR FROM v_local)::int < 18;
    v_today := v_local::date;

    PERFORM app.adherence_recompute(p_schema, r.id, v_today);
    SELECT planned, completed INTO v_planned, v_completed
    FROM adherence_daily WHERE patient_id = r.id AND date = v_today;

    CONTINUE WHEN NOT COALESCE(v_planned, false) OR COALESCE(v_completed, false);
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM session s JOIN session_item si ON si.session_id = s.id
      WHERE s.patient_id = r.id AND s.date = v_today AND NOT si.skipped
    );

    SELECT count(*) INTO v_cnt
    FROM plan_version pv
    JOIN plan_phase pp ON pp.plan_version_id = pv.id
    JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
    JOIN plan pl2 ON pl2.id = pv.plan_id AND pl2.patient_id = r.id
    JOIN plan pl3 ON pl3.id = pv.plan_id
    WHERE pv.is_current AND pp.n = pl3.current_phase_n;

    PERFORM app.notification_enqueue(
      p_schema, 'patient', r.id, 'daily_reminder', 'push', 'daily_reminder', r.ptz,
      jsonb_build_object('exercise_count', v_cnt,
                         'duration_min', GREATEST(1, v_cnt * 4),
                         'day_number', (v_today - r.started_at::date) + 1),
      'notif:daily_reminder:' || r.id || ':' || to_char(v_today, 'YYYYMMDD'),
      false);
    v_new := v_new + 1;
  END LOOP;

  -- 5. weekly_digest — Sunday 08:00 local, opt-in ----------------------
  v_local := now() AT TIME ZONE v_clinic_tz;
  IF EXTRACT(DOW FROM v_local)::int = 0 AND EXTRACT(HOUR FROM v_local)::int = 8 THEN
    FOR r IN
      SELECT u.id, u.email
      FROM app."user" u
      WHERE u.clinic_id = v_clinic_id AND u.status = 'active'
    LOOP
      PERFORM app.notification_enqueue(
        p_schema, 'user', r.id, 'weekly_digest', 'email', 'weekly_digest', v_clinic_tz,
        jsonb_build_object(
          'patient_count',  (SELECT count(*) FROM patient WHERE status = 'active' AND deleted_at IS NULL),
          'attention_count',(SELECT count(*) FROM patient p2 WHERE p2.status = 'active' AND p2.deleted_at IS NULL
                              AND COALESCE(recompute_adherence(p2.id, CURRENT_DATE), 100) < 70),
          'avg_adherence',  (SELECT COALESCE(round(avg(x)), 0) FROM (
                              SELECT recompute_adherence(p3.id, CURRENT_DATE) x FROM patient p3
                              WHERE p3.status = 'active' AND p3.deleted_at IS NULL) s WHERE x IS NOT NULL),
          'ready_count',    (SELECT count(*) FROM alert WHERE type = 'ready_for_advance' AND state = 'open'),
          'overdue_count',  (SELECT count(*) FROM alert WHERE type = 'assessment_overdue' AND state = 'open'),
          'app_url',        v_app_url || '/app/dashboard'),
        'notif:weekly_digest:' || r.id || ':' || to_char(v_local::date, 'IYYY-"W"IW'),
        false);
      v_new := v_new + 1;
    END LOOP;
  END IF;

  RETURN v_new;
END;
$fn$;
