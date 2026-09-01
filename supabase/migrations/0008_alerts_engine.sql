-- 0008_alerts_engine.sql
-- T-17 Alerts engine — computes the five RULES §4 clinician alerts server-side.
--
-- | type               | condition                                          | dedupe               |
-- |--------------------|----------------------------------------------------|----------------------|
-- | adherence_drop     | 7-day adherence < clinic threshold (default 70)     | 1 / patient / 7 days |
-- | pain_spike         | reported pain >= 6/10, or +3 over the 14-day mean   | 1 / patient / 24h    |
-- | ready_for_advance  | every current-phase criterion is met               | once per phase       |
-- | inactive           | 4+ consecutive planned days with no logged session | 1 / patient / 7 days |
-- | assessment_overdue | current phase has an unmet `assessment` criterion, | 1 / patient / 7 days |
-- |                    | the phase is > 7 days old, and no measurement was   |                      |
-- |                    | recorded in the last 7 days                         |                      |
--
-- State machine: open -> reviewed (clinician acted) -> auto_closed (condition
-- resolved). A prior alert in ANY state suppresses a re-fire while it is still
-- inside its dedupe window, so review does not let an alert immediately
-- re-fire (QA Q-07).
--
-- Runs every 15 minutes (pg_cron) and inline on session write so a pain_spike
-- is raised immediately (RULES §5). The dedupe decision is mirrored, with
-- unit tests, in packages/shared/src/alerts.ts — keep them in sync.

-- ---------------------------------------------------------------------------
-- dedupe decision (mirrors packages/shared shouldFire())
-- ---------------------------------------------------------------------------

-- Assumes the clinic schema is already on the search_path (alerts_recompute
-- sets it). ready_for_advance is once-per-phase; the rest are rolling windows.
CREATE OR REPLACE FUNCTION app.alert_should_fire(
  p_type       TEXT,
  p_patient_id UUID,
  p_now        TIMESTAMPTZ,
  p_phase_n    INT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_hours INT;
BEGIN
  IF p_type = 'ready_for_advance' THEN
    RETURN NOT EXISTS (
      SELECT 1 FROM alert
      WHERE patient_id = p_patient_id
        AND type = 'ready_for_advance'
        AND (payload ->> 'phase_n')::int IS NOT DISTINCT FROM p_phase_n
    );
  END IF;

  v_hours := CASE p_type WHEN 'pain_spike' THEN 24 ELSE 168 END;  -- 24h vs 7 days
  RETURN NOT EXISTS (
    SELECT 1 FROM alert
    WHERE patient_id = p_patient_id
      AND type = p_type
      AND created_at > p_now - make_interval(hours => v_hours)
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- engine
-- ---------------------------------------------------------------------------

-- Recompute every alert type for one patient: raise a new alert where the
-- condition holds and the dedupe window allows it; auto-close any open alert
-- whose condition no longer holds. Returns the number of new alerts raised.
CREATE OR REPLACE FUNCTION app.alerts_recompute(p_schema TEXT, p_patient_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_now            TIMESTAMPTZ := now();
  v_tz             TEXT;
  v_clinic_id      UUID;
  v_threshold      NUMERIC;
  v_local_today    DATE;
  v_week           TEXT;
  v_day            TEXT;
  v_phase_id       UUID;
  v_phase_n        INT;
  v_phase_started  TIMESTAMPTZ;
  v_adh            NUMERIC;
  v_recent_pain    NUMERIC;
  v_mean14         NUMERIC;
  v_last_done      DATE;
  v_planned_since  INT;
  v_crit_total     INT;
  v_crit_unmet     INT;
  v_assess_unmet   INT;
  v_recent_measure INT;
  v_cond           BOOLEAN;
  v_new            INT := 0;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT p.timezone, p.clinic_id INTO v_tz, v_clinic_id
  FROM patient p WHERE p.id = p_patient_id AND p.deleted_at IS NULL;
  IF v_tz IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE((c.settings ->> 'adherence_threshold')::numeric, 70)
  INTO v_threshold FROM app.clinic c WHERE c.id = v_clinic_id;

  v_local_today := (v_now AT TIME ZONE v_tz)::date;
  v_week := to_char(v_now AT TIME ZONE v_tz, 'IYYY-"W"IW');
  v_day  := to_char(v_now AT TIME ZONE v_tz, 'YYYY-MM-DD');

  SELECT pp.id, pp.n, pp.started_at
  INTO v_phase_id, v_phase_n, v_phase_started
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
  JOIN plan_phase pp   ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = p_patient_id;

  -- refresh adherence_daily + the rolling number for the reads below
  v_adh := app.adherence_recompute(p_schema, p_patient_id, v_local_today);

  -- 1. adherence_drop -----------------------------------------------------
  v_cond := v_adh IS NOT NULL AND v_adh < v_threshold;
  IF v_cond THEN
    IF app.alert_should_fire('adherence_drop', p_patient_id, v_now) THEN
      INSERT INTO alert (patient_id, clinic_id, type, severity, payload, dedupe_key)
      VALUES (p_patient_id, v_clinic_id, 'adherence_drop',
              CASE WHEN v_adh < v_threshold - 20 THEN 'high' ELSE 'medium' END,
              jsonb_build_object('adherence', v_adh, 'threshold', v_threshold),
              'adherence_drop:' || p_patient_id || ':' || v_week);
      v_new := v_new + 1;
    END IF;
  ELSE
    UPDATE alert SET state = 'auto_closed', reviewed_at = v_now
    WHERE patient_id = p_patient_id AND type = 'adherence_drop' AND state = 'open';
  END IF;

  -- 2. pain_spike -------------------------------------------------------
  SELECT max(si.pain_score) INTO v_recent_pain
  FROM session_item si JOIN session s ON s.id = si.session_id
  WHERE s.patient_id = p_patient_id AND si.pain_score IS NOT NULL
    AND si.logged_at > v_now - interval '24 hours';

  SELECT avg(si.pain_score) INTO v_mean14
  FROM session_item si JOIN session s ON s.id = si.session_id
  WHERE s.patient_id = p_patient_id AND si.pain_score IS NOT NULL
    AND si.logged_at > v_now - interval '14 days';

  v_cond := v_recent_pain IS NOT NULL
        AND (v_recent_pain >= 6 OR (v_mean14 IS NOT NULL AND v_recent_pain >= v_mean14 + 3));
  IF v_cond THEN
    IF app.alert_should_fire('pain_spike', p_patient_id, v_now) THEN
      INSERT INTO alert (patient_id, clinic_id, type, severity, payload, dedupe_key)
      VALUES (p_patient_id, v_clinic_id, 'pain_spike', 'high',
              jsonb_build_object('pain', v_recent_pain, 'mean_14d', round(v_mean14, 1)),
              'pain_spike:' || p_patient_id || ':' || v_day);
      v_new := v_new + 1;
    END IF;
  ELSE
    UPDATE alert SET state = 'auto_closed', reviewed_at = v_now
    WHERE patient_id = p_patient_id AND type = 'pain_spike' AND state = 'open';
  END IF;

  -- 3. ready_for_advance ----------------------------------------------
  IF v_phase_id IS NOT NULL THEN
    PERFORM app.recompute_criteria(p_schema, v_phase_id);
  END IF;
  SELECT count(*), count(*) FILTER (WHERE NOT is_met)
  INTO v_crit_total, v_crit_unmet
  FROM plan_criterion WHERE plan_phase_id = v_phase_id;

  v_cond := v_phase_id IS NOT NULL AND COALESCE(v_crit_total, 0) > 0 AND v_crit_unmet = 0;
  IF v_cond THEN
    IF app.alert_should_fire('ready_for_advance', p_patient_id, v_now, v_phase_n) THEN
      INSERT INTO alert (patient_id, clinic_id, type, severity, payload, dedupe_key)
      VALUES (p_patient_id, v_clinic_id, 'ready_for_advance', 'medium',
              jsonb_build_object('phase_n', v_phase_n),
              'ready_for_advance:' || p_patient_id || ':phase' || v_phase_n);
      v_new := v_new + 1;
    END IF;
  ELSE
    UPDATE alert SET state = 'auto_closed', reviewed_at = v_now
    WHERE patient_id = p_patient_id AND type = 'ready_for_advance' AND state = 'open';
  END IF;

  -- 4. inactive ------------------------------------------------------
  SELECT max(date) INTO v_last_done
  FROM adherence_daily
  WHERE patient_id = p_patient_id AND planned AND completed AND date <= v_local_today;

  SELECT count(*) INTO v_planned_since
  FROM adherence_daily
  WHERE patient_id = p_patient_id AND planned
    AND date <= v_local_today
    AND date > COALESCE(v_last_done, v_local_today - 60);

  v_cond := COALESCE(v_planned_since, 0) >= 4;
  IF v_cond THEN
    IF app.alert_should_fire('inactive', p_patient_id, v_now) THEN
      INSERT INTO alert (patient_id, clinic_id, type, severity, payload, dedupe_key)
      VALUES (p_patient_id, v_clinic_id, 'inactive', 'medium',
              jsonb_build_object('planned_days_missed', v_planned_since,
                                 'last_active', v_last_done),
              'inactive:' || p_patient_id || ':' || v_week);
      v_new := v_new + 1;
    END IF;
  ELSE
    UPDATE alert SET state = 'auto_closed', reviewed_at = v_now
    WHERE patient_id = p_patient_id AND type = 'inactive' AND state = 'open';
  END IF;

  -- 5. assessment_overdue -----------------------------------------
  SELECT count(*) INTO v_assess_unmet
  FROM plan_criterion
  WHERE plan_phase_id = v_phase_id AND type = 'assessment' AND NOT is_met;

  SELECT count(*) INTO v_recent_measure
  FROM measurement
  WHERE patient_id = p_patient_id AND deleted_at IS NULL
    AND measured_at > v_now - interval '7 days';

  v_cond := COALESCE(v_assess_unmet, 0) > 0
        AND COALESCE(v_recent_measure, 0) = 0
        AND v_phase_started IS NOT NULL
        AND v_phase_started < v_now - interval '7 days';
  IF v_cond THEN
    IF app.alert_should_fire('assessment_overdue', p_patient_id, v_now) THEN
      INSERT INTO alert (patient_id, clinic_id, type, severity, payload, dedupe_key)
      VALUES (p_patient_id, v_clinic_id, 'assessment_overdue', 'medium',
              jsonb_build_object('phase_n', v_phase_n),
              'assessment_overdue:' || p_patient_id || ':' || v_week);
      v_new := v_new + 1;
    END IF;
  ELSE
    UPDATE alert SET state = 'auto_closed', reviewed_at = v_now
    WHERE patient_id = p_patient_id AND type = 'assessment_overdue' AND state = 'open';
  END IF;

  RETURN v_new;
END;
$fn$;

-- Every active patient in every clinic. Backstop for the write-time hooks.
CREATE OR REPLACE FUNCTION app.alerts_sweep()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug   TEXT;
  v_schema TEXT;
  r        RECORD;
  v_total  INT := 0;
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_schema := 'clinic_' || v_slug;
    FOR r IN EXECUTE format(
      'SELECT id FROM %I.patient WHERE status = %L AND deleted_at IS NULL',
      v_schema, 'active'
    )
    LOOP
      v_total := v_total + app.alerts_recompute(v_schema, r.id);
    END LOOP;
  END LOOP;
  RETURN v_total;
END;
$fn$;

DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alerts-sweep') THEN
    PERFORM cron.unschedule('alerts-sweep');
  END IF;
  PERFORM cron.schedule('alerts-sweep', '*/15 * * * *', $job$SELECT app.alerts_sweep()$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule app.alerts_sweep() every 15 min by other means', SQLERRM;
END
$cron$;

-- ---------------------------------------------------------------------------
-- write_session_items — raise alerts inline so a pain_spike is immediate
-- (re-declares the 0007 body with one added PERFORM)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.write_session_items(
  p_schema TEXT,
  p_session_id UUID,
  p_items JSONB,
  p_actor_patient_auth_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_caller_patient_id UUID;
  v_session_patient_id UUID;
  v_session_date DATE;
  v_planned INT;
  v_done INT;
  v_ratio NUMERIC;
  v_status TEXT;
  v_items JSONB;
BEGIN
  SELECT patient_id INTO v_caller_patient_id FROM app.patient_auth WHERE id = p_actor_patient_auth_id;
  IF v_caller_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT patient_id, date, items_planned INTO v_session_patient_id, v_session_date, v_planned
  FROM session WHERE id = p_session_id;

  IF v_session_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_session_patient_id != v_caller_patient_id THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  WITH input_items AS (
    SELECT
      (elem->>'id')::UUID AS id,
      p_session_id AS session_id,
      (elem->>'plan_exercise_id')::UUID AS plan_exercise_id,
      (elem->>'sets_done')::INT AS sets_done,
      (elem->>'reps_done')::INT AS reps_done,
      (elem->>'load_used')::NUMERIC AS load_used,
      (elem->>'pain_score')::NUMERIC AS pain_score,
      elem->>'difficulty' AS difficulty,
      COALESCE((elem->>'skipped')::BOOLEAN, false) AS skipped,
      elem->>'skip_reason' AS skip_reason,
      elem->>'note' AS note,
      (elem->>'logged_at')::TIMESTAMPTZ AS logged_at,
      now() AS synced_at
    FROM jsonb_array_elements(p_items) AS elem
  )
  INSERT INTO session_item (
    id, session_id, plan_exercise_id, sets_done, reps_done, load_used,
    pain_score, difficulty, skipped, skip_reason, note, logged_at, synced_at
  )
  SELECT id, session_id, plan_exercise_id, sets_done, reps_done, load_used,
    pain_score, difficulty, skipped, skip_reason, note, logged_at, synced_at
  FROM input_items
  ON CONFLICT (session_id, id) DO NOTHING;

  SELECT COALESCE(jsonb_agg(to_jsonb(si.*)), '[]'::jsonb) INTO v_items
  FROM session_item si
  WHERE si.session_id = p_session_id
    AND si.id IN (SELECT (elem->>'id')::UUID FROM jsonb_array_elements(p_items) AS elem);

  SELECT count(*) FILTER (WHERE NOT skipped) INTO v_done
  FROM session_item WHERE session_id = p_session_id;

  v_ratio := CASE WHEN v_planned > 0 THEN LEAST(v_done::NUMERIC / v_planned, 1) ELSE 0 END;
  v_status := CASE
    WHEN v_planned = 0 OR v_done = 0 THEN 'planned'
    WHEN v_done >= v_planned THEN 'completed'
    ELSE 'partial'
  END;

  UPDATE session
  SET items_done = v_done,
      completion_ratio = v_ratio,
      status = v_status,
      completed_at = CASE WHEN v_status = 'completed' THEN now() ELSE completed_at END,
      updated_at = now()
  WHERE id = p_session_id;

  -- Adherence (RULES §1) then alerts (RULES §4) — see 0007 / 0008 headers.
  PERFORM app.adherence_recompute(p_schema, v_session_patient_id, v_session_date);
  PERFORM app.alerts_recompute(p_schema, v_session_patient_id);

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_actor_patient_auth_id, 'write', 'session_item', p_session_id);

  RETURN jsonb_build_object('items', v_items);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.alert_should_fire(TEXT, UUID, TIMESTAMPTZ, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.alerts_recompute(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.alerts_sweep() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.alert_should_fire(TEXT, UUID, TIMESTAMPTZ, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.alerts_recompute(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.alerts_sweep() TO service_role;
