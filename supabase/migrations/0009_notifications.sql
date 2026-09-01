-- 0009_notifications.sql
-- T-18 Notifications — the six RULES §5 events, server-side.
--
-- Events (Notification Templates.dc.html):
--   daily_reminder   push  -> patient    planned day not started by 18:00 local
--   adherence_drop   push  -> clinician  from the adherence_drop alert
--   plan_updated     push  -> patient    a non-reorder plan_version was saved
--   phase_approved   push  -> patient    a forward phase_transition was approved
--   weekly_digest    email -> clinician  Sunday 08:00 local, opt-in, counts only
--   pain_spike       push  -> clinician  from the pain_spike alert (urgent)
--
-- Global rules:
--   * Quiet hours 21:30–07:30 patient-local: a non-urgent notification landing
--     in the window is deferred to the next 07:30 local. pain_spike is urgent
--     and always sends now.
--   * A patient receives at most 2 push/day.
--   * Every category is opt-out-able except pain_spike -> clinician.
--     weekly_digest is opt-IN (absent pref = off).
--   * dedupe_key is UNIQUE on notification; enqueue is ON CONFLICT DO NOTHING.
--
-- Rows are produced by app.notifications_reconcile (reconciles from alert /
-- phase_transition / plan_version / schedule state — no write-time hooks) run
-- every 2 min by app.notifications_sweep (pg_cron). The notifications-dispatch
-- edge function drains app.notifications_due() and sends Web Push / email.
-- The quiet-hours + cap logic is mirrored in packages/shared/src/notifications.ts.

-- ---------------------------------------------------------------------------
-- preferences (opt-out, and opt-in for the digest)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.notification_pref (
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user', 'patient')),
  recipient_id   UUID NOT NULL,
  category       TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_type, recipient_id, category)
);

-- Absent row => enabled, except weekly_digest which is opt-in. pain_spike to a
-- clinician can never be turned off.
CREATE OR REPLACE FUNCTION app.notif_enabled(
  p_recipient_type TEXT,
  p_recipient_id   UUID,
  p_category       TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN p_recipient_type = 'user' AND p_category = 'pain' THEN true
    WHEN p_category = 'weekly_digest' THEN EXISTS (
      SELECT 1 FROM app.notification_pref
      WHERE recipient_type = p_recipient_type AND recipient_id = p_recipient_id
        AND category = p_category AND enabled
    )
    ELSE NOT EXISTS (
      SELECT 1 FROM app.notification_pref
      WHERE recipient_type = p_recipient_type AND recipient_id = p_recipient_id
        AND category = p_category AND NOT enabled
    )
  END;
$$;

CREATE OR REPLACE FUNCTION app.set_notification_pref(
  p_recipient_type TEXT, p_recipient_id UUID, p_category TEXT, p_enabled BOOLEAN
) RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO app.notification_pref (recipient_type, recipient_id, category, enabled)
  VALUES (p_recipient_type, p_recipient_id, p_category, p_enabled)
  ON CONFLICT (recipient_type, recipient_id, category)
    DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
$$;

-- ---------------------------------------------------------------------------
-- quiet hours (mirrors packages/shared deferredSendAt)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.notif_defer_at(p_now TIMESTAMPTZ, p_tz TEXT, p_urgent BOOLEAN)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_local     TIMESTAMP;
  v_min       INT;
  v_target    TIMESTAMP;
BEGIN
  IF p_urgent THEN
    RETURN p_now;
  END IF;
  v_local := p_now AT TIME ZONE p_tz;
  v_min := EXTRACT(HOUR FROM v_local)::int * 60 + EXTRACT(MINUTE FROM v_local)::int;
  IF v_min >= 1290 OR v_min < 450 THEN               -- 21:30 .. 07:30
    v_target := date_trunc('day', v_local) + interval '7 hours 30 minutes';
    IF v_min >= 450 THEN                             -- evening -> next morning
      v_target := v_target + interval '1 day';
    END IF;
    RETURN v_target AT TIME ZONE p_tz;
  END IF;
  RETURN p_now;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- enqueue gate: opt-out, patient 2/day push cap, quiet-hours defer, dedupe
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.notification_enqueue(
  p_schema         TEXT,
  p_recipient_type TEXT,
  p_recipient_id   UUID,
  p_event_key      TEXT,
  p_channel        TEXT,
  p_category       TEXT,
  p_tz             TEXT,
  p_payload        JSONB,
  p_dedupe_key     TEXT,
  p_urgent         BOOLEAN
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_send_at TIMESTAMPTZ;
  v_status  TEXT;
  v_count   INT;
  v_id      UUID;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  IF NOT app.notif_enabled(p_recipient_type, p_recipient_id, p_category) THEN
    RETURN NULL;
  END IF;

  IF p_recipient_type = 'patient' AND p_channel = 'push' AND NOT p_urgent THEN
    SELECT count(*) INTO v_count
    FROM notification
    WHERE recipient_type = 'patient' AND recipient_id = p_recipient_id
      AND channel = 'push'
      AND status IN ('pending', 'deferred', 'sent')
      AND (scheduled_for AT TIME ZONE p_tz)::date = (now() AT TIME ZONE p_tz)::date;
    IF v_count >= 2 THEN
      RETURN NULL;
    END IF;
  END IF;

  v_send_at := app.notif_defer_at(now(), p_tz, p_urgent);
  v_status := CASE WHEN v_send_at > now() THEN 'deferred' ELSE 'pending' END;

  INSERT INTO notification (recipient_type, recipient_id, event_key, channel, payload, scheduled_for, status, dedupe_key)
  VALUES (p_recipient_type, p_recipient_id, p_event_key, p_channel, p_payload, v_send_at, v_status, p_dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- reconcile: derive due notifications for one clinic from current state
-- ---------------------------------------------------------------------------

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
    SELECT pv.id, pv.plan_id, pv.version, pv.created_at, pl.patient_id, p.timezone AS ptz
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
      WHERE pp.plan_version_id = r.id
    ),
    old_ex AS (
      SELECT pe.exercise_id, pe.sets, pe.reps, pe.load, pe.hold_sec, pe.rest_sec, pe.side
      FROM plan_phase pp JOIN plan_exercise pe ON pe.plan_phase_id = pp.id AND pe.deleted_at IS NULL
      WHERE pp.plan_version_id = v_prev_ver
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

CREATE OR REPLACE FUNCTION app.notifications_sweep()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug  TEXT;
  v_total INT := 0;
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_total := v_total + app.notifications_reconcile('clinic_' || v_slug);
  END LOOP;
  RETURN v_total;
END;
$fn$;

DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notifications-sweep') THEN
    PERFORM cron.unschedule('notifications-sweep');
  END IF;
  PERFORM cron.schedule('notifications-sweep', '*/2 * * * *', $job$SELECT app.notifications_sweep()$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); schedule app.notifications_sweep() every 2 min by other means', SQLERRM;
END
$cron$;

-- Drain the queue by pinging the notifications-dispatch edge function every
-- minute. URL + secret come from DB settings so this needs no redeploy per
-- environment:
--   ALTER DATABASE postgres SET app.dispatch_url = 'https://<ref>.functions.supabase.co/notifications-dispatch';
--   ALTER DATABASE postgres SET app.dispatch_secret = '<DISPATCH_SECRET>';
-- Needs pg_net; if absent, trigger the dispatcher by other means.
DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notifications-dispatch') THEN
    PERFORM cron.unschedule('notifications-dispatch');
  END IF;
  PERFORM cron.schedule(
    'notifications-dispatch', '* * * * *',
    $job$
      SELECT net.http_post(
        url := COALESCE(current_setting('app.dispatch_url', true),
                        'http://kong:8000/functions/v1/notifications-dispatch'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-dispatch-secret', COALESCE(current_setting('app.dispatch_secret', true), '')),
        body := '{}'::jsonb
      );
    $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_net/pg_cron unavailable (%); trigger notifications-dispatch by other means', SQLERRM;
END
$cron$;

-- ---------------------------------------------------------------------------
-- dispatch surface (consumed by the notifications-dispatch edge function)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.notifications_due(p_limit INT DEFAULT 200)
RETURNS TABLE (
  schema         TEXT,
  id             UUID,
  recipient_type TEXT,
  recipient_id   UUID,
  event_key      TEXT,
  channel        TEXT,
  payload        JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug TEXT;
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, n.id, n.recipient_type, n.recipient_id, n.event_key, n.channel, n.payload
         FROM %I.notification n
        WHERE n.status IN (''pending'', ''deferred'')
          AND n.scheduled_for <= now()
        ORDER BY n.scheduled_for
        LIMIT %s',
      'clinic_' || v_slug, 'clinic_' || v_slug, p_limit
    );
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION app.notification_mark(
  p_schema TEXT, p_id UUID, p_status TEXT, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);
  UPDATE notification
  SET status = p_status,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      payload = CASE WHEN p_error IS NOT NULL THEN payload || jsonb_build_object('error', p_error) ELSE payload END
  WHERE id = p_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- device tokens (Web Push subscriptions)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS app_device_token_endpoint_key ON app.device_token (endpoint);

CREATE OR REPLACE FUNCTION app.register_device_token(
  p_owner_type TEXT, p_owner_id UUID, p_endpoint TEXT, p_keys JSONB, p_platform TEXT
) RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO app.device_token (owner_type, owner_id, endpoint, keys, platform, last_seen_at)
  VALUES (p_owner_type, p_owner_id, p_endpoint, p_keys, p_platform, now())
  ON CONFLICT (endpoint) DO UPDATE
    SET owner_type = EXCLUDED.owner_type,
        owner_id   = EXCLUDED.owner_id,
        keys       = EXCLUDED.keys,
        platform   = EXCLUDED.platform,
        last_seen_at = now();
$$;

CREATE OR REPLACE FUNCTION app.delete_device_token(p_endpoint TEXT)
RETURNS VOID LANGUAGE sql AS $$
  DELETE FROM app.device_token WHERE endpoint = p_endpoint;
$$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.notification_enqueue(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notifications_reconcile(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notifications_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notifications_due(INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_mark(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.notif_enabled(TEXT, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.set_notification_pref(TEXT, UUID, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.notif_defer_at(TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.notification_enqueue(TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION app.notifications_reconcile(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app.notifications_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION app.notifications_due(INT) TO service_role;
GRANT EXECUTE ON FUNCTION app.notification_mark(TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app.register_device_token(TEXT, UUID, TEXT, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.delete_device_token(TEXT) TO authenticated, service_role;
