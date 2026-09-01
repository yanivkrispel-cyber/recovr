-- 0011_settings.sql
-- T-20 Settings & assessment cadence.
--
-- GET/PATCH /settings -> per clinic: adherence threshold (50-95, step 5),
-- units (metric|imperial), per-type alert toggles (pain_spike stays locked
-- on), assessment interval, and this clinician's weekly-digest opt-in.
-- Everything lives in app.clinic.settings (JSONB) except the digest, which
-- is a per-user app.notification_pref row (T-18).
--
-- Assessment overdue: due_at = last measurement (or plan start) +
-- settings.assessment_interval_days (default 14). Surfaced per patient by
-- app.assessment_status.

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.clinic_setting_int(p_clinic_id UUID, p_key TEXT, p_default INT)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((c.settings ->> p_key)::int, p_default) FROM app.clinic c WHERE c.id = p_clinic_id;
$$;

-- Is an alert type enabled for a clinic? pain_spike can never be disabled.
CREATE OR REPLACE FUNCTION app.alert_type_enabled(p_clinic_id UUID, p_type TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_type = 'pain_spike' THEN true
    ELSE COALESCE(
      (SELECT (c.settings -> 'alerts' ->> p_type)::boolean FROM app.clinic c WHERE c.id = p_clinic_id),
      true)
  END;
$$;

-- ---------------------------------------------------------------------------
-- read / write clinic settings
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.get_clinic_settings(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id UUID;
  v_s         JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user"
  WHERE id = p_clinician_id AND role IN ('clinician', 'admin') AND status = 'active';
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT settings INTO v_s FROM app.clinic WHERE id = v_clinic_id;
  v_s := COALESCE(v_s, '{}'::jsonb);

  RETURN jsonb_build_object(
    'adherence_threshold',      COALESCE((v_s ->> 'adherence_threshold')::int, 70),
    'units',                    COALESCE(v_s ->> 'units', 'metric'),
    'assessment_interval_days', COALESCE((v_s ->> 'assessment_interval_days')::int, 14),
    'alerts', jsonb_build_object(
      'adherence_drop',     app.alert_type_enabled(v_clinic_id, 'adherence_drop'),
      'pain_spike',         true,
      'ready_for_advance',  app.alert_type_enabled(v_clinic_id, 'ready_for_advance'),
      'inactive',           app.alert_type_enabled(v_clinic_id, 'inactive'),
      'assessment_overdue', app.alert_type_enabled(v_clinic_id, 'assessment_overdue')
    ),
    'weekly_digest', app.notif_enabled('user', p_clinician_id, 'weekly_digest')
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.update_clinic_settings(p_clinician_id UUID, p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id UUID;
  v_slug      TEXT;
  v_new       JSONB;
  v_alerts    JSONB;
  v_int       INT;
  v_txt       TEXT;
  k           TEXT;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user"
  WHERE id = p_clinician_id AND role IN ('clinician', 'admin') AND status = 'active';
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT settings, slug INTO v_new, v_slug FROM app.clinic WHERE id = v_clinic_id;
  v_new := COALESCE(v_new, '{}'::jsonb);

  IF p_patch ? 'adherence_threshold' THEN
    v_int := (p_patch ->> 'adherence_threshold')::int;
    IF v_int < 50 OR v_int > 95 OR v_int % 5 <> 0 THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'adherence_threshold');
    END IF;
    v_new := jsonb_set(v_new, '{adherence_threshold}', to_jsonb(v_int));
  END IF;

  IF p_patch ? 'units' THEN
    v_txt := p_patch ->> 'units';
    IF v_txt NOT IN ('metric', 'imperial') THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'units');
    END IF;
    v_new := jsonb_set(v_new, '{units}', to_jsonb(v_txt));
  END IF;

  IF p_patch ? 'assessment_interval_days' THEN
    v_int := (p_patch ->> 'assessment_interval_days')::int;
    IF v_int < 7 OR v_int > 180 THEN
      RETURN jsonb_build_object('error', 'validation_failed', 'message', 'assessment_interval_days');
    END IF;
    v_new := jsonb_set(v_new, '{assessment_interval_days}', to_jsonb(v_int));
  END IF;

  IF p_patch ? 'alerts' THEN
    v_alerts := COALESCE(v_new -> 'alerts', '{}'::jsonb);
    FOR k IN SELECT jsonb_object_keys(p_patch -> 'alerts') LOOP
      CONTINUE WHEN k = 'pain_spike';  -- locked on
      CONTINUE WHEN k NOT IN ('adherence_drop', 'ready_for_advance', 'inactive', 'assessment_overdue');
      v_alerts := jsonb_set(v_alerts, ARRAY[k], to_jsonb((p_patch -> 'alerts' ->> k)::boolean));
    END LOOP;
    v_new := jsonb_set(v_new, '{alerts}', v_alerts);
  END IF;

  UPDATE app.clinic SET settings = v_new, updated_at = now() WHERE id = v_clinic_id;

  IF p_patch ? 'weekly_digest' THEN
    PERFORM app.set_notification_pref('user', p_clinician_id, 'weekly_digest', (p_patch ->> 'weekly_digest')::boolean);
  END IF;

  -- close open alerts of any type just disabled
  PERFORM app.alerts_close_disabled('clinic_' || v_slug);

  RETURN app.get_clinic_settings(p_clinician_id);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- alert toggles enforcement
-- ---------------------------------------------------------------------------

-- Re-declared from 0008 with the clinic toggle gate at the top: a disabled
-- type never fires. (Dedupe logic below is unchanged.)
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
  IF NOT app.alert_type_enabled((SELECT clinic_id FROM patient WHERE id = p_patient_id), p_type) THEN
    RETURN false;
  END IF;

  IF p_type = 'ready_for_advance' THEN
    RETURN NOT EXISTS (
      SELECT 1 FROM alert
      WHERE patient_id = p_patient_id
        AND type = 'ready_for_advance'
        AND (payload ->> 'phase_n')::int IS NOT DISTINCT FROM p_phase_n
    );
  END IF;

  v_hours := CASE p_type WHEN 'pain_spike' THEN 24 ELSE 168 END;
  RETURN NOT EXISTS (
    SELECT 1 FROM alert
    WHERE patient_id = p_patient_id
      AND type = p_type
      AND created_at > p_now - make_interval(hours => v_hours)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.alerts_close_disabled(p_schema TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_n INT;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);
  WITH upd AS (
    UPDATE alert a SET state = 'auto_closed', reviewed_at = now()
    FROM patient p
    WHERE a.patient_id = p.id
      AND a.state = 'open'
      AND NOT app.alert_type_enabled(p.clinic_id, a.type)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;
  RETURN v_n;
END;
$fn$;

-- Re-declared from 0008 to also close alerts of disabled types each sweep.
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
    PERFORM app.alerts_close_disabled(v_schema);
  END LOOP;
  RETURN v_total;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- assessment cadence
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.assessment_status(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema     TEXT;
  v_clinic     UUID;
  v_interval   INT;
  v_last       TIMESTAMPTZ;
  v_plan_start TIMESTAMPTZ;
  v_due        DATE;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT clinic_id INTO v_clinic FROM patient WHERE id = p_patient_id AND deleted_at IS NULL;
  IF v_clinic IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_interval := app.clinic_setting_int(v_clinic, 'assessment_interval_days', 14);
  SELECT max(measured_at) INTO v_last FROM measurement WHERE patient_id = p_patient_id AND deleted_at IS NULL;
  SELECT started_at INTO v_plan_start FROM plan WHERE patient_id = p_patient_id;

  v_due := (COALESCE(v_last, v_plan_start, now())::date) + v_interval;

  RETURN jsonb_build_object(
    'interval_days', v_interval,
    'last_measured_at', v_last,
    'due_at', v_due,
    'days_overdue', GREATEST(0, (CURRENT_DATE - v_due)),
    'overdue', CURRENT_DATE > v_due
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.get_clinic_settings(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.update_clinic_settings(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.alerts_close_disabled(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assessment_status(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.clinic_setting_int(UUID, TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.alert_type_enabled(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.get_clinic_settings(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.update_clinic_settings(UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.alerts_close_disabled(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app.assessment_status(UUID, UUID) TO authenticated, service_role;
