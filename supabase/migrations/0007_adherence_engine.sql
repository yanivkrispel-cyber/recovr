-- 0007_adherence_engine.sql
-- T-16 Adherence engine — brings the adherence number to RULES §1 exactly.
--
-- RULES §1: adherence = training days completed / training days planned, over a
-- rolling 7-day window.
--   * planned day   — the patient's current phase schedules a training day on
--                     that patient-local date. Explicit weekdays come from
--                     plan_exercise.schedule->'days'; when no exercise pins
--                     explicit days the phase is "daily"; a phase with no
--                     (non-deleted) exercises schedules nothing.
--   * completed day — a planned day on which the patient logged >= 1 non-skipped
--                     session_item (a PARTIAL day counts as completed).
--   * rest day      — not a planned day; excluded from BOTH numerator and
--                     denominator.
--   * result        — integer percent, rounded half-up; NULL when the window
--                     holds no planned day (no divide-by-zero, UI shows "--").
--   * per-day completion_ratio (items done / phase exercise count) is stored for
--                     the clinician's detail views only, never the headline.
--
-- Day bucketing is patient-local and DST-aware (`... AT TIME ZONE
-- patient.timezone`). Recompute runs on every session write and nightly at
-- 02:00 patient-local (pg_cron, hourly sweep).
--
-- A literal TS mirror of this logic, with the timezone/DST/rounding unit tests
-- T-16 calls for, lives in packages/shared/src/adherence.ts — keep them in sync.

-- ---------------------------------------------------------------------------
-- pure helpers
-- ---------------------------------------------------------------------------

-- Weekday key of a date, matching packages/shared weekdayKey(): 'sun'..'sat'.
CREATE OR REPLACE FUNCTION app.weekday_key(p_date DATE)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[EXTRACT(DOW FROM p_date)::int + 1];
$$;

-- Is p_date a scheduled training day, given the current phase's exercise count
-- and its unioned explicit weekday set (NULL => daily)?
CREATE OR REPLACE FUNCTION app.adherence_day_planned(p_ex_count INT, p_sched TEXT[], p_date DATE)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_ex_count, 0) = 0 THEN false
    WHEN p_sched IS NULL             THEN true
    ELSE app.weekday_key(p_date) = ANY (p_sched)
  END;
$$;

-- ---------------------------------------------------------------------------
-- engine
-- ---------------------------------------------------------------------------

-- Recompute a patient's rolling-7-day adherence ending on p_ref_date
-- (patient-local; defaults to the patient's local "today"), materialize the
-- seven adherence_daily rows, and return the headline percent (or NULL).
CREATE OR REPLACE FUNCTION app.adherence_recompute(
  p_schema      TEXT,
  p_patient_id  UUID,
  p_ref_date    DATE DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_tz         TEXT;
  v_ref        DATE;
  v_ex_count   INT;
  v_sched      TEXT[];   -- explicit weekday keys; NULL = daily; {} = nothing scheduled
  v_planned    INT;
  v_completed  INT;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT timezone INTO v_tz FROM patient WHERE id = p_patient_id;
  IF v_tz IS NULL THEN
    RETURN NULL;                         -- unknown patient / wrong schema
  END IF;

  v_ref := COALESCE(p_ref_date, (now() AT TIME ZONE v_tz)::date);

  -- Current-phase schedule.
  WITH cur AS (
    SELECT pe.schedule
    FROM plan pl
    JOIN plan_version pv  ON pv.plan_id = pl.id AND pv.is_current
    JOIN plan_phase pp    ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
    JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
    WHERE pl.patient_id = p_patient_id
  )
  SELECT
    count(*)::int,
    CASE
      WHEN count(*) = 0                 THEN ARRAY[]::TEXT[]
      WHEN bool_or(schedule ? 'days')   THEN COALESCE((
        SELECT array_agg(DISTINCT d)
        FROM cur c, LATERAL jsonb_array_elements_text(c.schedule -> 'days') AS d
      ), ARRAY[]::TEXT[])
      ELSE NULL                         -- no explicit schedule anywhere => daily
    END
  INTO v_ex_count, v_sched
  FROM cur;

  -- Materialize the seven window days.
  INSERT INTO adherence_daily (patient_id, date, planned, completed, completion_ratio)
  SELECT
    p_patient_id,
    w.d,
    app.adherence_day_planned(v_ex_count, v_sched, w.d),
    app.adherence_day_planned(v_ex_count, v_sched, w.d) AND di.items_done > 0,
    CASE
      WHEN app.adherence_day_planned(v_ex_count, v_sched, w.d) AND v_ex_count > 0
      THEN LEAST(di.items_done::numeric / v_ex_count, 1)
      ELSE 0
    END
  FROM (SELECT gs::date AS d FROM generate_series(v_ref - 6, v_ref, INTERVAL '1 day') gs) w
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS items_done
    FROM session s
    JOIN session_item si ON si.session_id = s.id
    WHERE s.patient_id = p_patient_id
      AND si.skipped = false
      AND (si.logged_at AT TIME ZONE v_tz)::date = w.d
  ) di
  ON CONFLICT (patient_id, date) DO UPDATE
    SET planned          = EXCLUDED.planned,
        completed        = EXCLUDED.completed,
        completion_ratio = EXCLUDED.completion_ratio;

  -- Headline straight from what was just written.
  SELECT
    count(*) FILTER (WHERE planned),
    count(*) FILTER (WHERE planned AND completed)
  INTO v_planned, v_completed
  FROM adherence_daily
  WHERE patient_id = p_patient_id
    AND date BETWEEN v_ref - 6 AND v_ref;

  IF v_planned = 0 THEN
    RETURN NULL;
  END IF;
  RETURN round(v_completed::numeric * 100 / v_planned::numeric);  -- half-up per RULES §1
END;
$fn$;

-- Back-compat shim: existing callers (dashboard_kpis, list_patients,
-- clinic_patient_summary, patient_progress) call recompute_adherence(patient,
-- date) with the clinic schema already on the search_path. Resolve the schema
-- and delegate; the date they pass (server today) is treated as patient-local,
-- which only matters for the few hours around local midnight.
CREATE OR REPLACE FUNCTION public.recompute_adherence(p_patient_id UUID, p_date DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
BEGIN
  v_schema := app.resolve_clinic_for_patient(p_patient_id);
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN app.adherence_recompute(v_schema, p_patient_id, p_date);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- nightly recompute — 02:00 patient-local
-- ---------------------------------------------------------------------------

-- Run hourly. For each active patient it recomputes only while the wall clock
-- in that patient's own timezone is in the 02:00 hour, so every patient is
-- swept once per local day regardless of timezone or a DST shift. Refreshes
-- the local "yesterday" (now closed) and "today".
CREATE OR REPLACE FUNCTION app.adherence_nightly_sweep()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug    TEXT;
  v_schema  TEXT;
  r         RECORD;
  v_local   DATE;
  v_count   INT := 0;
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_schema := 'clinic_' || v_slug;
    FOR r IN EXECUTE format(
      'SELECT id, timezone FROM %I.patient WHERE status = %L AND deleted_at IS NULL',
      v_schema, 'active'
    )
    LOOP
      CONTINUE WHEN EXTRACT(HOUR FROM now() AT TIME ZONE r.timezone)::int <> 2;
      v_local := (now() AT TIME ZONE r.timezone)::date;
      PERFORM app.adherence_recompute(v_schema, r.id, v_local);
      PERFORM app.adherence_recompute(v_schema, r.id, v_local - 1);
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$fn$;

-- Register the hourly sweep. pg_cron may be unavailable on a bare local stack;
-- don't let that abort the migration (T-01: clean clone must `supabase start`).
DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'adherence-nightly-sweep') THEN
    PERFORM cron.unschedule('adherence-nightly-sweep');
  END IF;
  PERFORM cron.schedule('adherence-nightly-sweep', '0 * * * *', $job$SELECT app.adherence_nightly_sweep()$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule app.adherence_nightly_sweep() hourly by other means', SQLERRM;
END
$cron$;

-- ---------------------------------------------------------------------------
-- write_session_items — use the engine (fixes: a partial day now counts as
-- completed, and a fully-skipped planned day is recorded, not dropped)
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

  -- Adherence (adherence_daily materialization + rolling number) — RULES §1,
  -- see 0007 header. Owns the adherence_daily upsert for the whole window.
  PERFORM app.adherence_recompute(p_schema, v_session_patient_id, v_session_date);

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_actor_patient_auth_id, 'write', 'session_item', p_session_id);

  RETURN jsonb_build_object('items', v_items);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- grants (match 0001 style)
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.adherence_recompute(TEXT, UUID, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.adherence_nightly_sweep() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.weekday_key(DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.adherence_day_planned(INT, TEXT[], DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.adherence_recompute(TEXT, UUID, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.adherence_nightly_sweep() TO service_role;
