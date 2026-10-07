-- ============================================================================
-- 0065 — reminders and self-service changes (T-36, first half).
--
--   * Reminder e-mails before each confirmed appointment, at two configurable
--     points (defaults 48 h and 3 h; either can be off). A point is skipped
--     when the person was told about the appointment after it had already
--     passed (booked, approved or moved inside the window — that e-mail did
--     the job). app.booking_reminders_due / app.booking_reminder_mark are
--     driven by the notifications dispatcher, which already runs every minute
--     with its secret in Vault.
--   * Patients change the time themselves — from the e-mail's manage link or
--     in the app — inside the free-cancellation window, to a slot that is
--     open under the booking rules. The clinician gets a push.
--   * appointment.late_cancel: the clinician marks a cancellation inside the
--     window as a late one by the patient; the appointment payload carries
--     the patient's no-shows and late cancellations of the last year.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns (per clinic), through add_clinic_columns()
-- ---------------------------------------------------------------------------

-- Same body as 0064, plus the reminder / move / late-cancel columns.
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

  -- 0062
  PERFORM add_clinic_scheduling_tables(p_schema);

  -- 0063
  EXECUTE format($f$
    ALTER TABLE %1$I.appointment_type ADD COLUMN IF NOT EXISTS price_ils NUMERIC(10,2)
      CHECK (price_ils IS NULL OR (price_ils >= 0 AND price_ils <= 100000));
    ALTER TABLE %1$I.appointment ADD COLUMN IF NOT EXISTS price_ils NUMERIC(10,2)
      CHECK (price_ils IS NULL OR (price_ils >= 0 AND price_ils <= 100000));
  $f$, p_schema);

  -- 0064
  EXECUTE format($f$
    ALTER TABLE %1$I.booking_request ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'public'
      CHECK (source IN ('public', 'clinician'));
    ALTER TABLE %1$I.booking_request ALTER COLUMN email DROP NOT NULL;
  $f$, p_schema);

  -- 0065
  EXECUTE format($f$
    ALTER TABLE %1$I.appointment ADD COLUMN IF NOT EXISTS reminded_first_at TIMESTAMPTZ;
    ALTER TABLE %1$I.appointment ADD COLUMN IF NOT EXISTS reminded_second_at TIMESTAMPTZ;
    ALTER TABLE %1$I.appointment ADD COLUMN IF NOT EXISTS moved_at TIMESTAMPTZ;
    ALTER TABLE %1$I.appointment ADD COLUMN IF NOT EXISTS late_cancel BOOLEAN NOT NULL DEFAULT false;
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
      PERFORM lock_down_schema(r.s);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Settings: the two reminder points
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.scheduling_settings(p_clinic_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  SELECT jsonb_build_object(
           'booking_enabled', false,
           'practitioner_id', NULL,
           'slot_step_min', 30,
           'buffer_min', 0,
           'min_notice_min', 180,
           'horizon_days', 42,
           'free_cancel_hours', 24,
           'contact_address', '',
           'contact_phone', '',
           'reminder_first_h', 48,
           'reminder_second_h', 3
         )
         || COALESCE((SELECT settings -> 'scheduling' FROM app.clinic WHERE id = p_clinic_id), '{}'::jsonb);
$fn$;

-- As 0062, plus reminder_first_h (0 = off, 24, 48, 72) and
-- reminder_second_h (0 = off, 1, 2, 3, 6, 12).
CREATE OR REPLACE FUNCTION app.scheduling_update_settings(p_clinician_id UUID, p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v       RECORD;
  v_new   JSONB;
  v_slug  TEXT;
  v_int   INT;
  v_txt   TEXT;
  k       TEXT;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT COALESCE(settings -> 'scheduling', '{}'::jsonb), booking_slug
  INTO v_new, v_slug
  FROM app.clinic WHERE id = v.clinic_id
  FOR UPDATE;

  BEGIN
    FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
      CASE k
        WHEN 'booking_enabled' THEN
          IF jsonb_typeof(p_patch -> k) <> 'boolean' THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], p_patch -> k);
        WHEN 'practitioner_id' THEN
          IF jsonb_typeof(p_patch -> k) = 'null' THEN
            v_new := jsonb_set(v_new, ARRAY[k], 'null'::jsonb);
          ELSIF NOT EXISTS (SELECT 1 FROM app."user"
                            WHERE id = (p_patch ->> k)::uuid AND clinic_id = v.clinic_id AND status = 'active') THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          ELSE
            v_new := jsonb_set(v_new, ARRAY[k], to_jsonb((p_patch ->> k)::uuid));
          END IF;
        WHEN 'slot_step_min' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int NOT IN (10, 15, 20, 30, 60) THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'buffer_min' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int < 0 OR v_int > 60 OR v_int % 5 <> 0 THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'min_notice_min' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int < 0 OR v_int > 10080 THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'horizon_days' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int < 1 OR v_int > 180 THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'free_cancel_hours' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int < 0 OR v_int > 168 THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'reminder_first_h' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int NOT IN (0, 24, 48, 72) THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'reminder_second_h' THEN
          v_int := (p_patch ->> k)::int;
          IF v_int IS NULL OR v_int NOT IN (0, 1, 2, 3, 6, 12) THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_int));
        WHEN 'contact_address', 'contact_phone' THEN
          v_txt := btrim(COALESCE(p_patch ->> k, ''));
          v_int := (CASE k WHEN 'contact_address' THEN 200 ELSE 30 END);
          IF length(v_txt) > v_int THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          v_new := jsonb_set(v_new, ARRAY[k], to_jsonb(v_txt));
        WHEN 'booking_slug' THEN
          v_txt := NULLIF(lower(btrim(COALESCE(p_patch ->> k, ''))), '');
          IF v_txt IS NOT NULL AND v_txt !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN
            RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
          END IF;
          IF v_txt IS NOT NULL AND EXISTS (SELECT 1 FROM app.clinic
                                           WHERE booking_slug = v_txt AND id <> v.clinic_id) THEN
            RETURN jsonb_build_object('error', 'slug_taken');
          END IF;
          v_slug := v_txt;
        ELSE
          RETURN jsonb_build_object('error', 'validation_failed', 'field', k);
      END CASE;
    END LOOP;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  -- Turning the public page on: bookings land in the caller's calendar
  -- unless someone else was chosen, and the page needs an address.
  IF COALESCE((v_new ->> 'booking_enabled')::boolean, false) THEN
    IF v_new ->> 'practitioner_id' IS NULL THEN
      v_new := jsonb_set(v_new, '{practitioner_id}', to_jsonb(p_clinician_id));
    END IF;
    IF v_slug IS NULL THEN
      RETURN jsonb_build_object('error', 'slug_required');
    END IF;
  END IF;

  BEGIN
    UPDATE app.clinic
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{scheduling}', v_new),
        booking_slug = v_slug,
        updated_at = now()
    WHERE id = v.clinic_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'slug_taken');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'update_scheduling_settings', 'clinic', v.clinic_id);

  RETURN jsonb_build_object('settings', app.scheduling_settings(v.clinic_id), 'booking_slug', v_slug);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Payloads
-- ---------------------------------------------------------------------------

-- As 0063, plus late_cancel, moved_at, the reminder stamps and — for a
-- patient card — no-shows and late cancellations of the past year.
CREATE OR REPLACE FUNCTION app._sched_appointment_json(p_appointment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'id', a.id,
      'practitioner_id', a.practitioner_id,
      'starts_at', a.starts_at,
      'ends_at', a.ends_at,
      'status', a.status,
      'source', a.source,
      'note', a.note,
      'price_ils', a.price_ils,
      'created_at', a.created_at,
      'decided_at', a.decided_at,
      'cancelled_by', a.cancelled_by,
      'cancelled_at', a.cancelled_at,
      'cancel_reason', a.cancel_reason,
      'late_cancel', a.late_cancel,
      'moved_at', a.moved_at,
      'reminded_first_at', a.reminded_first_at,
      'reminded_second_at', a.reminded_second_at,
      'type', jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'duration_min', t.duration_min,
                                 'price_ils', t.price_ils),
      'patient', CASE WHEN p.id IS NULL THEN NULL
                      ELSE jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status,
                                              'phone', p.phone, 'email', p.email) END,
      'lead', CASE WHEN br.id IS NULL THEN NULL
                   ELSE jsonb_build_object(
                     'request_id', br.id, 'name', br.name, 'phone', br.phone, 'email', br.email,
                     'patient_id', br.patient_id,
                     'body_region', CASE WHEN rg.id IS NULL THEN NULL
                                         ELSE jsonb_build_object('id', rg.id, 'name', rg.name) END) END,
      'history', CASE WHEN p.id IS NULL THEN NULL ELSE (
        SELECT jsonb_build_object(
                 'no_show', count(*) FILTER (WHERE h.status = 'no_show'),
                 'late_cancel', count(*) FILTER (WHERE h.status = 'cancelled' AND h.late_cancel))
        FROM appointment h
        WHERE h.patient_id = p.id AND h.id <> a.id
          AND h.starts_at > now() - interval '365 days' AND h.starts_at < now()) END
    )
    FROM appointment a
    JOIN appointment_type t ON t.id = a.type_id
    LEFT JOIN patient p ON p.id = a.patient_id
    LEFT JOIN booking_request br ON br.id = a.booking_request_id
    LEFT JOIN app.body_region rg ON rg.id = br.body_region_id
    WHERE a.id = p_appointment_id
  );
END;
$fn$;

-- As 0062, plus can_move (the same window as cancelling).
CREATE OR REPLACE FUNCTION app._sched_patient_appointment_json(p_appointment_id UUID, p_free_cancel_hours INT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'id', a.id,
      'starts_at', a.starts_at,
      'ends_at', a.ends_at,
      'status', a.status,
      'type', jsonb_build_object('id', t.id, 'name', t.name, 'duration_min', t.duration_min),
      'can_cancel', a.status IN ('pending', 'confirmed')
                    AND a.starts_at - now() > make_interval(hours => p_free_cancel_hours),
      'can_move', a.status IN ('pending', 'confirmed')
                  AND a.starts_at - now() > make_interval(hours => p_free_cancel_hours)
    )
    FROM appointment a
    JOIN appointment_type t ON t.id = a.type_id
    WHERE a.id = p_appointment_id
  );
END;
$fn$;

-- As 0062, plus horizon_days (how far ahead a new time may be picked).
CREATE OR REPLACE FUNCTION app.public_appointment(p_clinic_id UUID, p_appointment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_tz     TEXT;
  v_set    JSONB;
  v_hours  INT;
  v_row    JSONB;
BEGIN
  SELECT 'clinic_' || slug, timezone INTO v_schema, v_tz FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);
  v_set := app.scheduling_settings(p_clinic_id);
  v_hours := (v_set ->> 'free_cancel_hours')::int;

  v_row := app._sched_patient_appointment_json(p_appointment_id, v_hours);
  IF v_row IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN jsonb_build_object('appointment', v_row, 'clinic', app._sched_clinic_public(p_clinic_id),
                            'free_cancel_hours', v_hours,
                            'horizon_days', (v_set ->> 'horizon_days')::int);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Patient moves (manage link or app)
-- ---------------------------------------------------------------------------

-- Free starts for moving one appointment: its practitioner and length, the
-- clinic's booking rules (minimum notice, horizon). Caller set search_path.
CREATE OR REPLACE FUNCTION app._sched_patient_move_slots(p_schema TEXT, p_clinic_id UUID, p_tz TEXT,
                                                         p_appointment_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
AS $fn$
DECLARE
  a     RECORD;
  v_dur INT;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 31 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  SELECT * INTO a FROM appointment WHERE id = p_appointment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  v_dur := round(extract(epoch FROM (a.ends_at - a.starts_at)) / 60)::int;

  RETURN jsonb_build_object('slots', (
    SELECT COALESCE(jsonb_agg(f.slot_start ORDER BY f.slot_start), '[]'::jsonb)
    FROM app._sched_free_slots(p_schema, a.practitioner_id, v_dur, p_from, p_to,
                               app.scheduling_settings(p_clinic_id), p_tz) f
    WHERE f.slot_start <> a.starts_at));
END;
$fn$;

-- Inside the free-cancellation window only, to a slot open under the
-- booking rules; the reminders start over for the new time.
CREATE OR REPLACE FUNCTION app._sched_patient_move(p_schema TEXT, p_clinic_id UUID, p_tz TEXT,
                                                    p_appointment_id UUID, p_start TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
AS $fn$
DECLARE
  a       RECORD;
  v_set   JSONB := app.scheduling_settings(p_clinic_id);
  v_hours INT := (v_set ->> 'free_cancel_hours')::int;
  v_dur   INT;
BEGIN
  SELECT * INTO a FROM appointment WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF a.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('error', 'not_movable');
  END IF;
  IF a.starts_at - now() <= make_interval(hours => v_hours) THEN
    RETURN jsonb_build_object('error', 'too_late', 'free_cancel_hours', v_hours);
  END IF;
  IF p_start IS NULL OR p_start = a.starts_at THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  v_dur := round(extract(epoch FROM (a.ends_at - a.starts_at)) / 60)::int;
  IF NOT app._sched_slot_open(p_schema, a.practitioner_id, v_dur, p_start, v_set, p_tz) THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END IF;

  BEGIN
    UPDATE appointment
    SET starts_at = p_start,
        ends_at = p_start + make_interval(mins => v_dur),
        moved_at = now(),
        reminded_first_at = NULL,
        reminded_second_at = NULL,
        updated_at = now()
    WHERE id = a.id;
  EXCEPTION WHEN exclusion_violation THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END;

  PERFORM app._sched_notify_practitioner(p_schema, p_tz, 'booking_moved', a.id);

  RETURN jsonb_build_object('appointment', app._sched_patient_appointment_json(a.id, v_hours));
END;
$fn$;

CREATE OR REPLACE FUNCTION app.public_appointment_move_slots(p_clinic_id UUID, p_appointment_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_tz     TEXT;
BEGIN
  SELECT 'clinic_' || slug, timezone INTO v_schema, v_tz FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);
  RETURN app._sched_patient_move_slots(v_schema, p_clinic_id, v_tz, p_appointment_id, p_from, p_to);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.public_appointment_move(p_clinic_id UUID, p_appointment_id UUID, p_starts_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_tz     TEXT;
  v_res    JSONB;
BEGIN
  SELECT 'clinic_' || slug, timezone INTO v_schema, v_tz FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  v_res := app._sched_patient_move(v_schema, p_clinic_id, v_tz, p_appointment_id, p_starts_at);
  IF v_res ? 'error' THEN
    RETURN v_res;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', NULL, 'move_via_link', 'appointment', p_appointment_id);

  RETURN v_res || jsonb_build_object('clinic_id', p_clinic_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.me_appointment_move_slots(p_patient_auth_id UUID, p_appointment_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_patient(p_patient_auth_id);
  IF v.patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);
  -- Someone else's appointment is indistinguishable from a missing one.
  IF NOT EXISTS (SELECT 1 FROM appointment WHERE id = p_appointment_id AND patient_id = v.patient_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN app._sched_patient_move_slots(v.schema_name, v.clinic_id, v.tz, p_appointment_id, p_from, p_to);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.me_appointment_move(p_patient_auth_id UUID, p_appointment_id UUID, p_starts_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v     RECORD;
  v_res JSONB;
BEGIN
  SELECT * INTO v FROM app._sched_patient(p_patient_auth_id);
  IF v.patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);
  IF NOT EXISTS (SELECT 1 FROM appointment WHERE id = p_appointment_id AND patient_id = v.patient_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_res := app._sched_patient_move(v.schema_name, v.clinic_id, v.tz, p_appointment_id, p_starts_at);
  IF v_res ? 'error' THEN
    RETURN v_res;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'move', 'appointment', p_appointment_id);

  RETURN v_res || jsonb_build_object('clinic_id', v.clinic_id);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Clinician edits: a move restarts the reminders; cancelling can be
--    marked as a late cancellation by the patient
-- ---------------------------------------------------------------------------

-- As 0063, plus moved_at / reminder reset on a new start time, and
-- late_cancel (set when cancelling, cleared when the appointment comes back).
CREATE OR REPLACE FUNCTION app.appointment_update(p_clinician_id UUID, p_appointment_id UUID, p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v          RECORD;
  a          RECORD;
  v_status   TEXT;
  v_start    TIMESTAMPTZ;
  v_end      TIMESTAMPTZ;
  v_type     UUID;
  v_change   TEXT;
  v_reason   TEXT;
  v_price    NUMERIC;
  v_late     BOOLEAN;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT * INTO a FROM appointment WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  BEGIN
    v_status := COALESCE(p_patch ->> 'status', a.status);
    v_type := COALESCE((p_patch ->> 'type_id')::uuid, a.type_id);
    v_start := COALESCE((p_patch ->> 'starts_at')::timestamptz, a.starts_at);
    v_end := CASE
      WHEN p_patch ? 'ends_at' THEN (p_patch ->> 'ends_at')::timestamptz
      WHEN p_patch ? 'duration_min' THEN v_start + make_interval(mins => (p_patch ->> 'duration_min')::int)
      ELSE v_start + (a.ends_at - a.starts_at)
    END;
    v_reason := NULLIF(btrim(p_patch ->> 'cancel_reason'), '');
    v_price := CASE WHEN p_patch ? 'price_ils' THEN (p_patch ->> 'price_ils')::numeric ELSE a.price_ils END;
    v_late := CASE WHEN p_patch ? 'late_cancel' THEN (p_patch ->> 'late_cancel')::boolean END;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  IF v_type <> a.type_id AND NOT EXISTS (SELECT 1 FROM appointment_type WHERE id = v_type) THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  IF v_status <> a.status THEN
    IF NOT (
         (a.status = 'pending'   AND v_status IN ('confirmed', 'declined'))
      OR (a.status = 'confirmed' AND v_status IN ('cancelled', 'attended', 'no_show'))
      OR (a.status IN ('attended', 'no_show') AND v_status = 'confirmed')
      OR (a.status IN ('cancelled', 'declined') AND v_status = 'confirmed')
    ) THEN
      RETURN jsonb_build_object('error', 'invalid_transition');
    END IF;
    v_change := CASE
      WHEN a.status = 'pending' AND v_status = 'confirmed' THEN 'confirmed'
      WHEN v_status = 'declined' THEN 'declined'
      WHEN v_status = 'cancelled' THEN 'cancelled'
      WHEN a.status IN ('cancelled', 'declined') THEN 'confirmed'
      ELSE NULL
    END;
  END IF;

  IF (v_start, v_end) IS DISTINCT FROM (a.starts_at, a.ends_at) THEN
    IF v_status NOT IN ('pending', 'confirmed') THEN
      RETURN jsonb_build_object('error', 'invalid_transition');
    END IF;
    v_change := COALESCE(v_change, CASE WHEN v_status = 'confirmed' THEN 'moved' END);
  END IF;

  BEGIN
    UPDATE appointment SET
      status        = v_status,
      type_id       = v_type,
      starts_at     = v_start,
      ends_at       = v_end,
      price_ils     = v_price,
      note          = CASE WHEN p_patch ? 'note' THEN NULLIF(btrim(p_patch ->> 'note'), '') ELSE note END,
      decided_by    = CASE WHEN a.status = 'pending' AND v_status <> 'pending' THEN p_clinician_id ELSE decided_by END,
      decided_at    = CASE WHEN a.status = 'pending' AND v_status <> 'pending' THEN now() ELSE decided_at END,
      cancelled_by  = CASE WHEN v_status IN ('cancelled', 'declined') AND a.status <> v_status THEN 'clinician'
                           WHEN v_status IN ('cancelled', 'declined') THEN cancelled_by END,
      cancelled_at  = CASE WHEN v_status IN ('cancelled', 'declined') AND a.status <> v_status THEN now()
                           WHEN v_status IN ('cancelled', 'declined') THEN cancelled_at END,
      cancel_reason = CASE WHEN v_status IN ('cancelled', 'declined') THEN COALESCE(v_reason, cancel_reason) END,
      late_cancel   = CASE WHEN v_status = 'cancelled' AND a.status <> 'cancelled' THEN COALESCE(v_late, false)
                           WHEN v_status = 'cancelled' THEN COALESCE(v_late, late_cancel)
                           ELSE false END,
      moved_at      = CASE WHEN v_start <> a.starts_at THEN now() ELSE moved_at END,
      reminded_first_at  = CASE WHEN v_start <> a.starts_at THEN NULL ELSE reminded_first_at END,
      reminded_second_at = CASE WHEN v_start <> a.starts_at THEN NULL ELSE reminded_second_at END,
      updated_at    = now()
    WHERE id = a.id;
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('error', 'conflict',
        'conflicts', app._sched_conflicts(a.practitioner_id, v_start, v_end, a.id));
    WHEN check_violation THEN
      RETURN jsonb_build_object('error', 'validation_failed');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id,
          CASE WHEN v_status <> a.status THEN 'status:' || v_status
               WHEN v_change = 'moved' THEN 'move'
               ELSE 'edit' END,
          'appointment', a.id);

  RETURN jsonb_build_object(
    'appointment', app._sched_appointment_json(a.id),
    'change', v_change,
    'clinic_id', v.clinic_id);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Reminder queue (all clinics), for the dispatcher
-- ---------------------------------------------------------------------------

-- Confirmed upcoming appointments whose reminder point has come, that have
-- an address to write to, and whose person wasn't already told about them
-- after that point (booking / approval / move e-mail). Once the second point
-- has come, the first is no longer due.
CREATE OR REPLACE FUNCTION app.booking_reminders_due(p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  c        RECORD;
  v_set    JSONB;
  v_first  INT;
  v_second INT;
  v_rows   JSONB;
  v_out    JSONB := '[]'::jsonb;
BEGIN
  FOR c IN SELECT id, slug FROM app.clinic LOOP
    CONTINUE WHEN to_regclass(format('%I.appointment', 'clinic_' || c.slug)) IS NULL;
    v_set := app.scheduling_settings(c.id);
    v_first := COALESCE((v_set ->> 'reminder_first_h')::int, 0);
    v_second := COALESCE((v_set ->> 'reminder_second_h')::int, 0);
    CONTINUE WHEN v_first = 0 AND v_second = 0;

    EXECUTE format($q$
      SELECT COALESCE(jsonb_agg(q.x ORDER BY q.starts_at), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object('clinic_id', %2$L::uuid, 'appointment_id', a.id, 'stage', s.stage) AS x,
               a.starts_at
        FROM %1$I.appointment a
        LEFT JOIN %1$I.patient p ON p.id = a.patient_id
        LEFT JOIN %1$I.booking_request br ON br.id = a.booking_request_id
        CROSS JOIN LATERAL (VALUES ('first', %3$s), ('second', %4$s)) AS s(stage, hours)
        WHERE a.status = 'confirmed'
          AND a.starts_at > now()
          AND s.hours > 0
          AND now() >= a.starts_at - make_interval(hours => s.hours)
          AND COALESCE(NULLIF(btrim(p.email), ''), br.email) IS NOT NULL
          AND GREATEST(a.created_at, COALESCE(a.decided_at, a.created_at), COALESCE(a.moved_at, a.created_at))
              < a.starts_at - make_interval(hours => s.hours)
          AND CASE s.stage
                WHEN 'first' THEN a.reminded_first_at IS NULL
                                  AND (%4$s = 0 OR now() < a.starts_at - make_interval(hours => %4$s))
                ELSE a.reminded_second_at IS NULL
              END
        ORDER BY a.starts_at
        LIMIT %5$s
      ) q
    $q$, 'clinic_' || c.slug, c.id, v_first, v_second, p_limit) INTO v_rows;

    v_out := v_out || v_rows;
    EXIT WHEN jsonb_array_length(v_out) >= p_limit;
  END LOOP;

  RETURN jsonb_build_object('reminders', v_out);
END;
$fn$;

-- One attempt per point: the dispatcher marks it whether or not the e-mail
-- went out, so a bad address can't be retried every minute for two days.
CREATE OR REPLACE FUNCTION app.booking_reminder_mark(p_clinic_id UUID, p_appointment_id UUID, p_stage TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_schema TEXT;
BEGIN
  SELECT 'clinic_' || slug INTO v_schema FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL OR p_stage NOT IN ('first', 'second') THEN
    RETURN;
  END IF;
  EXECUTE format('UPDATE %I.appointment SET %I = now() WHERE id = $1',
                 v_schema, CASE p_stage WHEN 'first' THEN 'reminded_first_at' ELSE 'reminded_second_at' END)
  USING p_appointment_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Privileges (service_role only) + the scoped self-check
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE sched_fn AS
SELECT p.oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'app' AND p.proname IN (
         'scheduling_settings', 'scheduling_update_settings', '_sched_appointment_json',
         '_sched_patient_appointment_json', 'public_appointment', '_sched_patient_move_slots',
         '_sched_patient_move', 'public_appointment_move_slots', 'public_appointment_move',
         'me_appointment_move_slots', 'me_appointment_move', 'appointment_update',
         'booking_reminders_due', 'booking_reminder_mark'))
   OR (n.nspname = 'public' AND p.proname = 'add_clinic_columns');

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig FROM sched_fn LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

DO $$
DECLARE
  v_leaks TEXT;
BEGIN
  SELECT string_agg(format('%s EXECUTE %s', r.rolname, f.oid::regprocedure), ', ') INTO v_leaks
  FROM sched_fn f
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE has_function_privilege(r.rolname, f.oid, 'EXECUTE');

  IF v_leaks IS NOT NULL THEN
    RAISE EXCEPTION 'scheduling lockdown incomplete: %', v_leaks;
  END IF;
END $$;

DROP TABLE sched_fn;
