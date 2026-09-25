-- Performance: take the per-patient work off the clinician read path and the
-- patient write path. Results are unchanged; see each section.
--
-- 1. resolve_clinic_for_patient() probed every clinic schema with dynamic SQL
--    until it found the patient: O(clinics) on every patient endpoint and,
--    via public.recompute_adherence(), twice per row of the dashboard /
--    patient list. Now a directory lookup (app.patient_clinic) plus one
--    indexed existence check; the scan remains only as a first-time fallback
--    that fills the directory.
--
-- 2. clinic_patient_summary() (dashboard KPIs + patient list) called
--    recompute_adherence() twice per patient. That function *writes* (upserts
--    the 7-day window into adherence_daily) and scans the patient's whole
--    session history 7 times. The summary now computes the same 7-day figure
--    set-based and read-only, once per patient. Same formula as
--    adherence_recompute (RULES §1): planned days in [ref-6, ref], a planned
--    day counts as completed when any non-skipped item was logged on it (in
--    the patient's timezone); NULL when nothing was planned. adherence_daily
--    is still maintained by the write path, the 15-minute alerts sweep and
--    the nightly sweep.
--
-- 3. adherence_recompute(): one bounded pass over the window's items instead
--    of a full-history scan per day, and its upsert skips rows whose values
--    didn't change (the alerts sweep re-runs it for every active patient
--    every 15 minutes, so most of those updates were no-ops).
--
-- 4. write_session_items() ran adherence_recompute() and then
--    alerts_recompute(), which runs it again first thing for the patient's
--    local today. The direct call is now made only when the session isn't
--    today's (late offline sync), where its window differs.

-- ------------------------------------------------------------------------ 1
CREATE TABLE IF NOT EXISTS app.patient_clinic (
  patient_id  UUID PRIMARY KEY,
  schema_name TEXT NOT NULL
);
ALTER TABLE app.patient_clinic ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.patient_clinic FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.patient_clinic TO service_role;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT 'clinic_' || slug AS s FROM app.clinic LOOP
    IF to_regclass(format('%I.patient', r.s)) IS NOT NULL THEN
      EXECUTE format(
        'INSERT INTO app.patient_clinic (patient_id, schema_name)
         SELECT id, %L FROM %I.patient
         ON CONFLICT (patient_id) DO NOTHING', r.s, r.s);
    END IF;
  END LOOP;
END $$;

-- VOLATILE (was STABLE): the fallback path writes the directory. Every caller
-- is a VOLATILE plpgsql function or a direct service-role RPC.
CREATE OR REPLACE FUNCTION app.resolve_clinic_for_patient(p_patient_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
AS $$
DECLARE
  v_schema TEXT;
  v_found BOOLEAN;
BEGIN
  SELECT schema_name INTO v_schema FROM app.patient_clinic WHERE patient_id = p_patient_id;
  IF v_schema IS NOT NULL AND to_regclass(format('%I.patient', v_schema)) IS NOT NULL THEN
    -- Still verify: a hard-deleted patient must keep resolving to NULL.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.patient WHERE id = $1)', v_schema)
      INTO v_found USING p_patient_id;
    IF v_found THEN
      RETURN v_schema;
    END IF;
  END IF;

  -- First lookup for a patient created after 0051 (or a stale entry).
  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.patient WHERE id = $1)', v_schema)
      INTO v_found USING p_patient_id;
    IF v_found THEN
      BEGIN
        INSERT INTO app.patient_clinic (patient_id, schema_name)
        VALUES (p_patient_id, v_schema)
        ON CONFLICT (patient_id) DO UPDATE SET schema_name = EXCLUDED.schema_name;
      EXCEPTION WHEN OTHERS THEN
        NULL; -- caching is best-effort (e.g. a read-only transaction)
      END;
      RETURN v_schema;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------------------ 2
CREATE OR REPLACE FUNCTION app.clinic_patient_summary(p_schema TEXT)
RETURNS TABLE(
  patient_id UUID, name TEXT, name_en TEXT, protocol_name TEXT, phase_name TEXT,
  phase_n INTEGER, day INTEGER, adherence INTEGER, last_session_date DATE,
  is_ready BOOLEAN, is_low_adherence BOOLEAN, is_inactive BOOLEAN, is_invited BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  RETURN QUERY
  WITH active AS (
    SELECT p.id, p.timezone
    FROM patient p
    WHERE p.status = 'active' AND p.deleted_at IS NULL
  ),
  -- Current-phase exercise count + weekday schedule, as in adherence_recompute
  -- (across every plan the patient has, like its `cur` CTE).
  cur AS (
    SELECT pl.patient_id, pe.schedule
    FROM plan pl
    JOIN plan_version pv  ON pv.plan_id = pl.id AND pv.is_current
    JOIN plan_phase pp    ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
    JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
    WHERE pl.patient_id IN (SELECT id FROM active)
  ),
  sched AS (
    SELECT
      a.id,
      a.timezone,
      count(c.patient_id)::int AS ex_count,
      CASE
        WHEN count(c.patient_id) = 0     THEN ARRAY[]::TEXT[]
        WHEN bool_or(c.schedule ? 'days') THEN COALESCE((
          SELECT array_agg(DISTINCT d)
          FROM cur c2, LATERAL jsonb_array_elements_text(c2.schedule -> 'days') AS d
          WHERE c2.patient_id = a.id
        ), ARRAY[]::TEXT[])
        ELSE NULL
      END AS sched
    FROM active a
    LEFT JOIN cur c ON c.patient_id = a.id
    GROUP BY a.id, a.timezone
  ),
  done AS (
    SELECT s.patient_id, (si.logged_at AT TIME ZONE a.timezone)::date AS d
    FROM active a
    JOIN session s       ON s.patient_id = a.id
    JOIN session_item si ON si.session_id = s.id
    WHERE si.skipped = false
      AND si.logged_at >= ((CURRENT_DATE - 6)::timestamp AT TIME ZONE a.timezone)
      AND si.logged_at <  ((CURRENT_DATE + 1)::timestamp AT TIME ZONE a.timezone)
    GROUP BY 1, 2
  ),
  adh AS (
    SELECT
      sc.id,
      CASE WHEN count(*) FILTER (WHERE w.planned) = 0 THEN NULL
        ELSE round(
          (count(*) FILTER (WHERE w.planned AND dn.d IS NOT NULL))::numeric * 100
          / (count(*) FILTER (WHERE w.planned))::numeric)
      END AS pct
    FROM sched sc
    CROSS JOIN LATERAL (
      SELECT gs::date AS d, app.adherence_day_planned(sc.ex_count, sc.sched, gs::date) AS planned
      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, INTERVAL '1 day') gs
    ) w
    LEFT JOIN done dn ON dn.patient_id = sc.id AND dn.d = w.d
    GROUP BY sc.id
  )
  SELECT
    p.id,
    p.name,
    p.name_en,
    pr.name,
    pp.name,
    pl.current_phase_n,
    CASE WHEN pl.started_at IS NULL THEN NULL ELSE (CURRENT_DATE - pl.started_at::date) + 1 END,
    CASE WHEN p.status <> 'active' THEN NULL ELSE COALESCE(adh.pct::int, 0) END,
    (SELECT max(s.date) FROM session s WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')),
    (
      EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id)
      AND NOT EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id AND NOT pc.is_met)
    ),
    p.status = 'active' AND COALESCE(adh.pct < 70, false),
    p.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM session s
      WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')
        AND s.date >= CURRENT_DATE - 4
    ),
    p.status = 'invited'
  FROM patient p
  LEFT JOIN plan pl ON pl.patient_id = p.id
  LEFT JOIN app.protocol pr ON pr.id = pl.protocol_id
  LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  LEFT JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  LEFT JOIN adh ON adh.id = p.id
  WHERE p.status IN ('active', 'invited') AND p.deleted_at IS NULL;
END;
$$;

-- ------------------------------------------------------------------------ 3
CREATE OR REPLACE FUNCTION app.adherence_recompute(p_schema TEXT, p_patient_id UUID, p_ref_date DATE DEFAULT NULL)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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

  -- Materialize the seven window days. Items are counted in one pass bounded
  -- to the window (local midnight to local midnight), not per day over the
  -- whole history.
  INSERT INTO adherence_daily AS ad (patient_id, date, planned, completed, completion_ratio)
  SELECT
    p_patient_id,
    w.d,
    app.adherence_day_planned(v_ex_count, v_sched, w.d),
    app.adherence_day_planned(v_ex_count, v_sched, w.d) AND COALESCE(di.items_done, 0) > 0,
    CASE
      WHEN app.adherence_day_planned(v_ex_count, v_sched, w.d) AND v_ex_count > 0
      THEN LEAST(COALESCE(di.items_done, 0)::numeric / v_ex_count, 1)
      ELSE 0
    END
  FROM (SELECT gs::date AS d FROM generate_series(v_ref - 6, v_ref, INTERVAL '1 day') gs) w
  LEFT JOIN (
    SELECT (si.logged_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS items_done
    FROM session s
    JOIN session_item si ON si.session_id = s.id
    WHERE s.patient_id = p_patient_id
      AND si.skipped = false
      AND si.logged_at >= ((v_ref - 6)::timestamp AT TIME ZONE v_tz)
      AND si.logged_at <  ((v_ref + 1)::timestamp AT TIME ZONE v_tz)
    GROUP BY 1
  ) di ON di.d = w.d
  ON CONFLICT (patient_id, date) DO UPDATE
    SET planned          = EXCLUDED.planned,
        completed        = EXCLUDED.completed,
        completion_ratio = EXCLUDED.completion_ratio
    WHERE (ad.planned, ad.completed, ad.completion_ratio)
          IS DISTINCT FROM (EXCLUDED.planned, EXCLUDED.completed, EXCLUDED.completion_ratio);

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
$$;

-- ------------------------------------------------------------------------ 4
CREATE OR REPLACE FUNCTION app.write_session_items(p_schema TEXT, p_session_id UUID, p_items JSONB, p_actor_patient_auth_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_patient_id UUID;
  v_session_patient_id UUID;
  v_session_date DATE;
  v_planned INT;
  v_done INT;
  v_ratio NUMERIC;
  v_status TEXT;
  v_items JSONB;
  v_local_today DATE;
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
  -- alerts_recompute() recomputes adherence for the patient's local today
  -- first thing, so only a session from another day (late offline sync)
  -- needs its own window refreshed here.
  SELECT (now() AT TIME ZONE timezone)::date INTO v_local_today
  FROM patient WHERE id = v_session_patient_id;
  IF v_session_date IS DISTINCT FROM v_local_today THEN
    PERFORM app.adherence_recompute(p_schema, v_session_patient_id, v_session_date);
  END IF;
  PERFORM app.alerts_recompute(p_schema, v_session_patient_id);

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_actor_patient_auth_id, 'write', 'session_item', p_session_id);

  RETURN jsonb_build_object('items', v_items);
END;
$$;
