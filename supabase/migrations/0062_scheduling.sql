-- ============================================================================
-- 0062 — M6 scheduling foundation: T-34 (availability + clinician calendar)
-- and T-35 (public booking page + patient-app booking).
--
-- Where things live
--   * app.clinic.booking_slug + app.clinic.settings->'scheduling' — clinic
--     level (public page address, booking rules). Read through
--     app.scheduling_settings(), which fills in defaults.
--   * clinic_<slug>.appointment_type / availability_rule / time_off /
--     booking_request / appointment — per clinic, next to the patient rows
--     they reference. Created by add_clinic_scheduling_tables(), which
--     add_clinic_columns() now calls, so provision_clinic(), seed.sql and
--     scripts/apply-to-all-clinics.ts pick the tables up unchanged.
--
-- Invariants
--   * No double booking, enforced by the database: appointment carries an
--     exclusion constraint over (practitioner, time range) for the live
--     statuses, and a trigger refuses appointment/time-off overlaps under a
--     per-practitioner advisory lock (two tables can't share one constraint).
--   * Patients and website visitors can only book a slot that
--     app._sched_free_slots() offers (availability minus appointments,
--     buffer, time off, minimum notice, booking horizon). The clinician may
--     book anywhere that doesn't overlap.
--   * A website request becomes an appointment only after its e-mail code is
--     verified; unverified requests hold nothing and are purged after a day.
--   * Approving a website request confirms the appointment. The patient card
--     is opened later through the existing add-patient flow
--     (booking_link_patient links it), so a no-show leaves no stray card.
--
-- Everything here is reached through edge functions on the service role
-- (0047): no client-role grants, and the self-check at the end fails the
-- migration if one slips through.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. Clinic level: public booking address + scheduling settings
-- ---------------------------------------------------------------------------

ALTER TABLE app.clinic ADD COLUMN IF NOT EXISTS booking_slug TEXT;
ALTER TABLE app.clinic DROP CONSTRAINT IF EXISTS clinic_booking_slug_format;
ALTER TABLE app.clinic ADD CONSTRAINT clinic_booking_slug_format
  CHECK (booking_slug IS NULL OR booking_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
CREATE UNIQUE INDEX IF NOT EXISTS clinic_booking_slug_idx
  ON app.clinic (booking_slug) WHERE booking_slug IS NOT NULL;

-- Stored settings over defaults. Mirrored by SCHEDULING_DEFAULTS in
-- packages/shared/src/scheduling.ts.
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
           'contact_phone', ''
         )
         || COALESCE((SELECT settings -> 'scheduling' FROM app.clinic WHERE id = p_clinic_id), '{}'::jsonb);
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Per-clinic tables
-- ---------------------------------------------------------------------------

-- Refuses an appointment that overlaps blocked time, and blocked time that
-- overlaps a live appointment. The advisory lock queues one practitioner's
-- calendar writes behind each other, so the check sees whatever a concurrent
-- transaction just committed (each statement in a VOLATILE function takes a
-- fresh snapshot under READ COMMITTED).
CREATE OR REPLACE FUNCTION app.sched_overlap_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_hit BOOLEAN;
BEGIN
  -- Nested, not AND-ed: PL/pgSQL evaluates the whole condition, and a
  -- time_off row has no status field.
  IF TG_TABLE_NAME = 'appointment' THEN
    IF NEW.status NOT IN ('pending', 'confirmed', 'attended', 'no_show') THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sched:' || NEW.practitioner_id::text, 0));

  IF TG_TABLE_NAME = 'appointment' THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.time_off t
                       WHERE t.practitioner_id = $1
                         AND tstzrange(t.starts_at, t.ends_at, ''[)'') && tstzrange($2, $3, ''[)''))',
      TG_TABLE_SCHEMA)
    INTO v_hit USING NEW.practitioner_id, NEW.starts_at, NEW.ends_at;
    IF v_hit THEN
      RAISE EXCEPTION 'appointment overlaps blocked time'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'appointment_time_off';
    END IF;
  ELSE
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.appointment a
                       WHERE a.practitioner_id = $1
                         AND a.status IN (''pending'', ''confirmed'', ''attended'', ''no_show'')
                         AND tstzrange(a.starts_at, a.ends_at, ''[)'') && tstzrange($2, $3, ''[)''))',
      TG_TABLE_SCHEMA)
    INTO v_hit USING NEW.practitioner_id, NEW.starts_at, NEW.ends_at;
    IF v_hit THEN
      RAISE EXCEPTION 'blocked time overlaps appointments'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'time_off_appointment';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION add_clinic_scheduling_tables(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS %1$I.appointment_type (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id     UUID NOT NULL REFERENCES app.clinic(id),
      name          TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
      name_en       TEXT CHECK (name_en IS NULL OR length(name_en) <= 60),
      description   TEXT CHECK (description IS NULL OR length(description) <= 200),
      duration_min  INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
      price_label   TEXT CHECK (price_label IS NULL OR length(price_label) <= 40),
      color         TEXT NOT NULL DEFAULT 'gold'
                      CHECK (color IN ('navy', 'gold', 'green', 'clay', 'slate')),
      who_may_book  TEXT NOT NULL DEFAULT 'existing'
                      CHECK (who_may_book IN ('anyone', 'existing', 'clinician_only')),
      confirmation  TEXT NOT NULL DEFAULT 'auto' CHECK (confirmation IN ('manual', 'auto')),
      active        BOOLEAN NOT NULL DEFAULT true,
      sort          INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Weekly working hours in clinic-local wall-clock time; weekday 0 = Sunday.
    CREATE TABLE IF NOT EXISTS %1$I.availability_rule (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id        UUID NOT NULL REFERENCES app.clinic(id),
      practitioner_id  UUID NOT NULL REFERENCES app."user"(id),
      weekday          SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time       TIME NOT NULL,
      end_time         TIME NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (end_time > start_time)
    );
    CREATE INDEX IF NOT EXISTS availability_rule_practitioner_idx
      ON %1$I.availability_rule (practitioner_id, weekday);

    -- One-off blocked time (vacation, conference).
    CREATE TABLE IF NOT EXISTS %1$I.time_off (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id        UUID NOT NULL REFERENCES app.clinic(id),
      practitioner_id  UUID NOT NULL REFERENCES app."user"(id),
      starts_at        TIMESTAMPTZ NOT NULL,
      ends_at          TIMESTAMPTZ NOT NULL,
      reason           TEXT CHECK (reason IS NULL OR length(reason) <= 120),
      created_by       UUID REFERENCES app."user"(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at),
      CHECK (ends_at - starts_at <= interval '120 days')
    );
    CREATE INDEX IF NOT EXISTS time_off_practitioner_range_idx
      ON %1$I.time_off USING gist (practitioner_id, tstzrange(starts_at, ends_at, '[)'));

    -- A website visitor's request. The code_* columns gate it until the
    -- e-mail is verified; the appointment is created only then.
    CREATE TABLE IF NOT EXISTS %1$I.booking_request (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id          UUID NOT NULL REFERENCES app.clinic(id),
      practitioner_id    UUID NOT NULL REFERENCES app."user"(id),
      type_id            UUID NOT NULL REFERENCES %1$I.appointment_type(id),
      starts_at          TIMESTAMPTZ NOT NULL,
      name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
      phone              TEXT NOT NULL CHECK (phone ~ '^\+?[0-9]{9,15}$'),
      email              TEXT NOT NULL CHECK (length(email) <= 254
                                              AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
      body_region_id     UUID REFERENCES app.body_region(id),
      consent_version    TEXT NOT NULL,
      consent_at         TIMESTAMPTZ NOT NULL,
      code_hash          TEXT,
      code_expires_at    TIMESTAMPTZ,
      code_attempts      INT NOT NULL DEFAULT 0,
      codes_sent         INT NOT NULL DEFAULT 1,
      email_verified_at  TIMESTAMPTZ,
      ip_hash            TEXT,
      patient_id         UUID REFERENCES %1$I.patient(id),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS booking_request_unverified_idx
      ON %1$I.booking_request (created_at) WHERE email_verified_at IS NULL;
    CREATE INDEX IF NOT EXISTS booking_request_email_idx ON %1$I.booking_request (lower(email));

    CREATE TABLE IF NOT EXISTS %1$I.appointment (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id           UUID NOT NULL REFERENCES app.clinic(id),
      practitioner_id     UUID NOT NULL REFERENCES app."user"(id),
      patient_id          UUID REFERENCES %1$I.patient(id),
      booking_request_id  UUID REFERENCES %1$I.booking_request(id),
      type_id             UUID NOT NULL REFERENCES %1$I.appointment_type(id),
      starts_at           TIMESTAMPTZ NOT NULL,
      ends_at             TIMESTAMPTZ NOT NULL,
      status              TEXT NOT NULL CHECK (status IN (
                            'pending', 'confirmed', 'attended', 'no_show',
                            'cancelled', 'declined', 'expired')),
      source              TEXT NOT NULL CHECK (source IN ('clinician', 'patient_app', 'public')),
      note                TEXT CHECK (note IS NULL OR length(note) <= 500),
      created_by          UUID REFERENCES app."user"(id),
      decided_by          UUID REFERENCES app."user"(id),
      decided_at          TIMESTAMPTZ,
      cancelled_by        TEXT CHECK (cancelled_by IS NULL OR cancelled_by IN ('clinician', 'patient', 'system')),
      cancelled_at        TIMESTAMPTZ,
      cancel_reason       TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at),
      CHECK (ends_at - starts_at <= interval '12 hours'),
      CHECK (patient_id IS NOT NULL OR booking_request_id IS NOT NULL),
      CONSTRAINT appointment_no_overlap EXCLUDE USING gist (
        practitioner_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      ) WHERE (status IN ('pending', 'confirmed', 'attended', 'no_show'))
    );
    CREATE INDEX IF NOT EXISTS appointment_patient_idx
      ON %1$I.appointment (patient_id, starts_at) WHERE patient_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS appointment_request_idx
      ON %1$I.appointment (booking_request_id) WHERE booking_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS appointment_pending_idx
      ON %1$I.appointment (starts_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS appointment_type_idx ON %1$I.appointment (type_id);

    DROP TRIGGER IF EXISTS appointment_overlap_guard ON %1$I.appointment;
    CREATE TRIGGER appointment_overlap_guard
      BEFORE INSERT OR UPDATE OF starts_at, ends_at, practitioner_id, status ON %1$I.appointment
      FOR EACH ROW EXECUTE FUNCTION app.sched_overlap_guard();
    DROP TRIGGER IF EXISTS time_off_overlap_guard ON %1$I.time_off;
    CREATE TRIGGER time_off_overlap_guard
      BEFORE INSERT OR UPDATE OF starts_at, ends_at, practitioner_id ON %1$I.time_off
      FOR EACH ROW EXECUTE FUNCTION app.sched_overlap_guard();
  $f$, p_schema);
END;
$$ LANGUAGE plpgsql;

-- Same body as 0059, plus the scheduling tables.
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
-- 3. Internal helpers
-- ---------------------------------------------------------------------------

-- The caller's clinic, schema and timezone — NULL row when the id isn't an
-- active clinician/admin.
CREATE OR REPLACE FUNCTION app._sched_clinician(p_clinician_id UUID)
RETURNS TABLE (clinic_id UUID, schema_name TEXT, tz TEXT, role TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  SELECT u.clinic_id, 'clinic_' || c.slug, c.timezone, u.role
  FROM app."user" u
  JOIN app.clinic c ON c.id = u.clinic_id
  WHERE u.id = p_clinician_id AND u.role IN ('clinician', 'admin') AND u.status = 'active';
$fn$;

-- The signed-in patient's record, clinic and practitioner.
CREATE OR REPLACE FUNCTION app._sched_patient(p_patient_auth_id UUID)
RETURNS TABLE (patient_id UUID, clinic_id UUID, schema_name TEXT, tz TEXT,
               practitioner_id UUID, email TEXT, status TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
BEGIN
  SELECT pa.patient_id INTO v_patient_id FROM app.patient_auth pa WHERE pa.id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN;
  END IF;
  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT p.id, c.id, %L::text, c.timezone, p.primary_clinician_id, p.email, p.status
       FROM %I.patient p
       JOIN app.clinic c ON ''clinic_'' || c.slug = %L
      WHERE p.id = $1 AND p.deleted_at IS NULL',
    v_schema, v_schema, v_schema)
  USING v_patient_id;
END;
$fn$;

-- Bookable start times for one practitioner and duration over [p_from,
-- p_to] (clinic-local dates). A start is offered when [start, start+duration)
-- fits inside a working window, starts on the window's step grid, is at least
-- min_notice away, falls within the horizon, and keeps buffer_min clear of
-- every live appointment and all blocked time. Mirrored by freeSlots() in
-- packages/shared/src/scheduling.ts — keep the two in step.
CREATE OR REPLACE FUNCTION app._sched_free_slots(
  p_schema TEXT,
  p_practitioner_id UUID,
  p_duration_min INT,
  p_from DATE,
  p_to DATE,
  p_settings JSONB,
  p_tz TEXT
) RETURNS TABLE (slot_start TIMESTAMPTZ, slot_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
DECLARE
  v_step    INT := COALESCE((p_settings ->> 'slot_step_min')::int, 30);
  v_buffer  INT := COALESCE((p_settings ->> 'buffer_min')::int, 0);
  v_notice  INT := COALESCE((p_settings ->> 'min_notice_min')::int, 180);
  v_horizon INT := COALESCE((p_settings ->> 'horizon_days')::int, 42);
  v_today   DATE := (now() AT TIME ZONE p_tz)::date;
  v_from    DATE := GREATEST(p_from, v_today);
  v_to      DATE := LEAST(p_to, v_today + v_horizon);
BEGIN
  IF v_to < v_from OR p_duration_min IS NULL OR p_duration_min <= 0 OR v_step <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH days AS (
      SELECT g::date AS d FROM generate_series($1::date, $2::date, interval '1 day') g
    ),
    windows AS (
      SELECT ((days.d + r.start_time) AT TIME ZONE $3) AS ws,
             ((days.d + r.end_time) AT TIME ZONE $3) AS we
      FROM days
      JOIN %1$I.availability_rule r
        ON r.practitioner_id = $4 AND r.weekday = extract(dow FROM days.d)::int
    ),
    candidates AS (
      SELECT DISTINCT s AS cs, s + make_interval(mins => $5) AS ce
      FROM windows w,
           generate_series(w.ws, w.we - make_interval(mins => $5), make_interval(mins => $6)) s
    )
    SELECT c.cs, c.ce
    FROM candidates c
    WHERE c.cs >= now() + make_interval(mins => $7)
      AND NOT EXISTS (
        SELECT 1 FROM %1$I.appointment a
        WHERE a.practitioner_id = $4
          AND a.status IN ('pending', 'confirmed', 'attended', 'no_show')
          AND a.starts_at < c.ce + make_interval(mins => $8)
          AND a.ends_at > c.cs - make_interval(mins => $8))
      AND NOT EXISTS (
        SELECT 1 FROM %1$I.time_off t
        WHERE t.practitioner_id = $4
          AND t.starts_at < c.ce
          AND t.ends_at > c.cs)
    ORDER BY c.cs
  $q$, p_schema)
  USING v_from, v_to, p_tz, p_practitioner_id, p_duration_min, v_step, v_notice, v_buffer;
END;
$fn$;

-- Is p_start exactly one of the offered slots? Self-booking only ever lands
-- on a slot the picker showed.
CREATE OR REPLACE FUNCTION app._sched_slot_open(
  p_schema TEXT,
  p_practitioner_id UUID,
  p_duration_min INT,
  p_start TIMESTAMPTZ,
  p_settings JSONB,
  p_tz TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM app._sched_free_slots(p_schema, p_practitioner_id, p_duration_min,
                               (p_start AT TIME ZONE p_tz)::date, (p_start AT TIME ZONE p_tz)::date,
                               p_settings, p_tz)
    WHERE slot_start = p_start
  );
$fn$;

-- What a calendar write collided with, for the conflict error. Caller has
-- set search_path to the clinic schema.
CREATE OR REPLACE FUNCTION app._sched_conflicts(
  p_practitioner_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_exclude UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $fn$
BEGIN
  RETURN jsonb_build_object(
    'appointments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status,
               'name', COALESCE(p.name, br.name)) ORDER BY a.starts_at)
      FROM appointment a
      LEFT JOIN patient p ON p.id = a.patient_id
      LEFT JOIN booking_request br ON br.id = a.booking_request_id
      WHERE a.practitioner_id = p_practitioner_id
        AND a.status IN ('pending', 'confirmed', 'attended', 'no_show')
        AND a.id IS DISTINCT FROM p_exclude
        AND a.starts_at < p_to AND a.ends_at > p_from), '[]'::jsonb),
    'time_off', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'starts_at', t.starts_at, 'ends_at', t.ends_at, 'reason', t.reason)
             ORDER BY t.starts_at)
      FROM time_off t
      WHERE t.practitioner_id = p_practitioner_id
        AND t.starts_at < p_to AND t.ends_at > p_from), '[]'::jsonb)
  );
END;
$fn$;

-- Clinician-facing appointment payload. Caller has set search_path.
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
      'created_at', a.created_at,
      'decided_at', a.decided_at,
      'cancelled_by', a.cancelled_by,
      'cancelled_at', a.cancelled_at,
      'cancel_reason', a.cancel_reason,
      'type', jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color, 'duration_min', t.duration_min),
      'patient', CASE WHEN p.id IS NULL THEN NULL
                      ELSE jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status) END,
      'lead', CASE WHEN br.id IS NULL THEN NULL
                   ELSE jsonb_build_object(
                     'request_id', br.id, 'name', br.name, 'phone', br.phone, 'email', br.email,
                     'patient_id', br.patient_id,
                     'body_region', CASE WHEN rg.id IS NULL THEN NULL
                                         ELSE jsonb_build_object('id', rg.id, 'name', rg.name) END) END
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

-- Patient-facing appointment payload (no internal note). Caller has set
-- search_path.
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
                    AND a.starts_at - now() > make_interval(hours => p_free_cancel_hours)
    )
    FROM appointment a
    JOIN appointment_type t ON t.id = a.type_id
    WHERE a.id = p_appointment_id
  );
END;
$fn$;

-- Contact details shown on the booking page and in e-mails.
CREATE OR REPLACE FUNCTION app._sched_clinic_public(p_clinic_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'name', c.name,
    'address', NULLIF(s ->> 'contact_address', ''),
    'phone', NULLIF(s ->> 'contact_phone', ''),
    'timezone', c.timezone,
    'booking_slug', CASE WHEN (s ->> 'booking_enabled')::boolean THEN c.booking_slug END
  )
  FROM app.clinic c, LATERAL (SELECT app.scheduling_settings(c.id) AS s) st
  WHERE c.id = p_clinic_id;
$fn$;

-- Tells the practitioner something happened to their calendar (push, via
-- the T-18 pipeline: quiet hours and opt-out apply). Caller has set
-- search_path.
CREATE OR REPLACE FUNCTION app._sched_notify_practitioner(
  p_schema TEXT,
  p_tz TEXT,
  p_event TEXT,
  p_appointment_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $fn$
DECLARE
  v RECORD;
BEGIN
  SELECT a.practitioner_id, a.starts_at, t.name AS type_name
  INTO v
  FROM appointment a JOIN appointment_type t ON t.id = a.type_id
  WHERE a.id = p_appointment_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM app.notification_enqueue(
    p_schema, 'user', v.practitioner_id, p_event, 'push', 'bookings', p_tz,
    jsonb_build_object(
      'appointment_id', p_appointment_id,
      'when', to_char(v.starts_at AT TIME ZONE p_tz, 'DD.MM HH24:MI'),
      'type_name', v.type_name),
    p_event || ':' || p_appointment_id::text,
    false);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Clinician: setup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.scheduling_setup(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  RETURN jsonb_build_object(
    'me', p_clinician_id,
    'role', v.role,
    'timezone', v.tz,
    'clinic_name', (SELECT name FROM app.clinic WHERE id = v.clinic_id),
    'booking_slug', (SELECT booking_slug FROM app.clinic WHERE id = v.clinic_id),
    'settings', app.scheduling_settings(v.clinic_id),
    'practitioners', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role) ORDER BY u.name), '[]'::jsonb)
      FROM app."user" u
      WHERE u.clinic_id = v.clinic_id AND u.status = 'active'),
    'types', (
      SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'clinic_id' - 'created_at' - 'updated_at' ORDER BY t.sort, t.name), '[]'::jsonb)
      FROM appointment_type t),
    'availability', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', r.id, 'practitioner_id', r.practitioner_id, 'weekday', r.weekday,
               'start_time', to_char(r.start_time, 'HH24:MI'), 'end_time', to_char(r.end_time, 'HH24:MI'))
             ORDER BY r.practitioner_id, r.weekday, r.start_time), '[]'::jsonb)
      FROM availability_rule r)
  );
END;
$fn$;

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

-- Create (no id) or update (id) an appointment type. On update, keys left
-- out keep their value; a present null clears an optional text field.
CREATE OR REPLACE FUNCTION app.appointment_type_save(p_clinician_id UUID, p_type JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v    RECORD;
  v_id UUID;
  v_row JSONB;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_type IS NULL OR jsonb_typeof(p_type) <> 'object' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  BEGIN
    IF p_type ? 'id' AND jsonb_typeof(p_type -> 'id') <> 'null' THEN
      UPDATE appointment_type SET
        name         = CASE WHEN p_type ? 'name' THEN btrim(p_type ->> 'name') ELSE name END,
        name_en      = CASE WHEN p_type ? 'name_en' THEN NULLIF(btrim(p_type ->> 'name_en'), '') ELSE name_en END,
        description  = CASE WHEN p_type ? 'description' THEN NULLIF(btrim(p_type ->> 'description'), '') ELSE description END,
        duration_min = COALESCE((p_type ->> 'duration_min')::int, duration_min),
        price_label  = CASE WHEN p_type ? 'price_label' THEN NULLIF(btrim(p_type ->> 'price_label'), '') ELSE price_label END,
        color        = COALESCE(p_type ->> 'color', color),
        who_may_book = COALESCE(p_type ->> 'who_may_book', who_may_book),
        confirmation = COALESCE(p_type ->> 'confirmation', confirmation),
        active       = COALESCE((p_type ->> 'active')::boolean, active),
        sort         = COALESCE((p_type ->> 'sort')::int, sort),
        updated_at   = now()
      WHERE id = (p_type ->> 'id')::uuid
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        RETURN jsonb_build_object('error', 'not_found');
      END IF;
    ELSE
      INSERT INTO appointment_type (clinic_id, name, name_en, description, duration_min, price_label,
                                    color, who_may_book, confirmation, active, sort)
      VALUES (
        v.clinic_id,
        btrim(p_type ->> 'name'),
        NULLIF(btrim(p_type ->> 'name_en'), ''),
        NULLIF(btrim(p_type ->> 'description'), ''),
        (p_type ->> 'duration_min')::int,
        NULLIF(btrim(p_type ->> 'price_label'), ''),
        COALESCE(p_type ->> 'color', 'gold'),
        COALESCE(p_type ->> 'who_may_book', 'existing'),
        COALESCE(p_type ->> 'confirmation', 'auto'),
        COALESCE((p_type ->> 'active')::boolean, true),
        COALESCE((p_type ->> 'sort')::int, (SELECT COALESCE(max(sort), 0) + 1 FROM appointment_type))
      )
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN check_violation OR not_null_violation OR data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'save', 'appointment_type', v_id);

  SELECT to_jsonb(t) - 'clinic_id' - 'created_at' - 'updated_at' INTO v_row
  FROM appointment_type t WHERE t.id = v_id;
  RETURN jsonb_build_object('type', v_row);
END;
$fn$;

-- Replaces a practitioner's weekly hours. Clinicians edit their own; an
-- admin may edit anyone's in the clinic.
CREATE OR REPLACE FUNCTION app.availability_save(p_clinician_id UUID, p_practitioner_id UUID, p_rules JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  v_target UUID := COALESCE(p_practitioner_id, p_clinician_id);
  v_bad    BOOLEAN;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_target <> p_clinician_id AND v.role <> 'admin' THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_target AND clinic_id = v.clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' OR jsonb_array_length(p_rules) > 42 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  BEGIN
    WITH r AS (
      SELECT ord,
             (x ->> 'weekday')::int AS wd,
             (x ->> 'start_time')::time AS s,
             (x ->> 'end_time')::time AS e
      FROM jsonb_array_elements(p_rules) WITH ORDINALITY AS j(x, ord)
    )
    SELECT
      EXISTS (SELECT 1 FROM r
              WHERE wd IS NULL OR wd NOT BETWEEN 0 AND 6 OR s IS NULL OR e IS NULL OR e <= s
                 OR extract(minute FROM s)::int % 5 <> 0 OR extract(minute FROM e)::int % 5 <> 0
                 OR extract(second FROM s) <> 0 OR extract(second FROM e) <> 0)
      OR EXISTS (SELECT 1 FROM r a JOIN r b ON a.wd = b.wd AND a.ord < b.ord AND a.s < b.e AND b.s < a.e)
    INTO v_bad;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;
  IF v_bad THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  DELETE FROM availability_rule WHERE practitioner_id = v_target;
  INSERT INTO availability_rule (clinic_id, practitioner_id, weekday, start_time, end_time)
  SELECT v.clinic_id, v_target, (x ->> 'weekday')::int, (x ->> 'start_time')::time, (x ->> 'end_time')::time
  FROM jsonb_array_elements(p_rules) x;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'save_availability', 'user', v_target);

  RETURN jsonb_build_object('availability', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.id, 'practitioner_id', r.practitioner_id, 'weekday', r.weekday,
             'start_time', to_char(r.start_time, 'HH24:MI'), 'end_time', to_char(r.end_time, 'HH24:MI'))
           ORDER BY r.weekday, r.start_time), '[]'::jsonb)
    FROM availability_rule r WHERE r.practitioner_id = v_target));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Clinician: calendar
-- ---------------------------------------------------------------------------

-- Everything the calendar draws for [p_from, p_to): appointments (any
-- status; the client hides cancelled ones by default) with the patient's
-- current phase and server-computed adherence, blocked time, working hours.
CREATE OR REPLACE FUNCTION app.calendar_range(p_clinician_id UUID, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  v_appts  JSONB;
  v_off    JSONB;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '62 days' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  WITH summary AS MATERIALIZED (
    SELECT s.patient_id, s.phase_n, s.phase_name, s.adherence, s.is_invited, s.is_low_adherence
    FROM app.clinic_patient_summary(v.schema_name) s
  )
  SELECT COALESCE(jsonb_agg(
           app._sched_appointment_json(a.id)
           || jsonb_build_object('clinical', CASE WHEN sm.patient_id IS NULL THEN NULL ELSE jsonb_build_object(
                'phase_n', sm.phase_n, 'phase_name', sm.phase_name,
                'adherence', CASE WHEN sm.is_invited THEN NULL ELSE sm.adherence END,
                'low_adherence', COALESCE(sm.is_low_adherence, false) AND NOT sm.is_invited) END)
           ORDER BY a.starts_at), '[]'::jsonb)
  INTO v_appts
  FROM appointment a
  LEFT JOIN summary sm ON sm.patient_id = a.patient_id
  WHERE a.starts_at < p_to AND a.ends_at > p_from;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'practitioner_id', t.practitioner_id, 'starts_at', t.starts_at,
           'ends_at', t.ends_at, 'reason', t.reason) ORDER BY t.starts_at), '[]'::jsonb)
  INTO v_off
  FROM time_off t
  WHERE t.starts_at < p_to AND t.ends_at > p_from;

  RETURN jsonb_build_object(
    'timezone', v.tz,
    'appointments', v_appts,
    'time_off', v_off,
    'pending_count', (SELECT count(*) FROM appointment WHERE status = 'pending' AND starts_at > now())
  );
END;
$fn$;

-- Clinician books a patient. Confirmed straight away; no availability or
-- notice rules (the clinician may book outside hours), only no overlap.
CREATE OR REPLACE FUNCTION app.appointment_create(p_clinician_id UUID, p_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v          RECORD;
  v_type     RECORD;
  v_patient  UUID;
  v_pract    UUID;
  v_start    TIMESTAMPTZ;
  v_minutes  INT;
  v_id       UUID;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  BEGIN
    v_patient := (p_input ->> 'patient_id')::uuid;
    v_start := (p_input ->> 'starts_at')::timestamptz;
    v_pract := COALESCE((p_input ->> 'practitioner_id')::uuid, p_clinician_id);
    SELECT * INTO v_type FROM appointment_type WHERE id = (p_input ->> 'type_id')::uuid AND active;
    v_minutes := COALESCE((p_input ->> 'duration_min')::int, v_type.duration_min);
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  IF v_patient IS NULL OR v_start IS NULL OR v_type.id IS NULL
     OR v_minutes IS NULL OR v_minutes < 5 OR v_minutes > 720 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = v_patient AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_pract AND clinic_id = v.clinic_id AND status = 'active') THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  BEGIN
    INSERT INTO appointment (clinic_id, practitioner_id, patient_id, type_id, starts_at, ends_at,
                             status, source, note, created_by, decided_by, decided_at)
    VALUES (v.clinic_id, v_pract, v_patient, v_type.id, v_start, v_start + make_interval(mins => v_minutes),
            'confirmed', 'clinician', NULLIF(btrim(p_input ->> 'note'), ''), p_clinician_id, p_clinician_id, now())
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('error', 'conflict',
        'conflicts', app._sched_conflicts(v_pract, v_start, v_start + make_interval(mins => v_minutes), NULL));
    WHEN check_violation THEN
      RETURN jsonb_build_object('error', 'validation_failed');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'create', 'appointment', v_id);

  RETURN jsonb_build_object('appointment', app._sched_appointment_json(v_id), 'clinic_id', v.clinic_id);
END;
$fn$;

-- Move / resize / retype / annotate, and status changes:
--   pending   -> confirmed (approve) | declined (decline)
--   confirmed -> cancelled | attended | no_show
--   attended | no_show -> confirmed            (undo a mark)
--   cancelled | declined -> confirmed          (restore, if the slot is free)
-- Returns `change` so the caller knows which e-mail, if any, to send.
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
    -- A moved request is approved at its new time in the same step.
    v_change := COALESCE(v_change, CASE WHEN v_status = 'confirmed' THEN 'moved' END);
  END IF;

  BEGIN
    UPDATE appointment SET
      status        = v_status,
      type_id       = v_type,
      starts_at     = v_start,
      ends_at       = v_end,
      note          = CASE WHEN p_patch ? 'note' THEN NULLIF(btrim(p_patch ->> 'note'), '') ELSE note END,
      decided_by    = CASE WHEN a.status = 'pending' AND v_status <> 'pending' THEN p_clinician_id ELSE decided_by END,
      decided_at    = CASE WHEN a.status = 'pending' AND v_status <> 'pending' THEN now() ELSE decided_at END,
      cancelled_by  = CASE WHEN v_status IN ('cancelled', 'declined') AND a.status <> v_status THEN 'clinician'
                           WHEN v_status IN ('cancelled', 'declined') THEN cancelled_by END,
      cancelled_at  = CASE WHEN v_status IN ('cancelled', 'declined') AND a.status <> v_status THEN now()
                           WHEN v_status IN ('cancelled', 'declined') THEN cancelled_at END,
      cancel_reason = CASE WHEN v_status IN ('cancelled', 'declined') THEN COALESCE(v_reason, cancel_reason) END,
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

CREATE OR REPLACE FUNCTION app.time_off_create(p_clinician_id UUID, p_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v       RECORD;
  v_pract UUID;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  v_id    UUID;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  BEGIN
    v_pract := COALESCE((p_input ->> 'practitioner_id')::uuid, p_clinician_id);
    v_start := (p_input ->> 'starts_at')::timestamptz;
    v_end := (p_input ->> 'ends_at')::timestamptz;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  IF v_pract <> p_clinician_id AND v.role <> 'admin' THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_pract AND clinic_id = v.clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  BEGIN
    INSERT INTO time_off (clinic_id, practitioner_id, starts_at, ends_at, reason, created_by)
    VALUES (v.clinic_id, v_pract, v_start, v_end, NULLIF(btrim(p_input ->> 'reason'), ''), p_clinician_id)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('error', 'conflict',
        'conflicts', app._sched_conflicts(v_pract, v_start, v_end, NULL));
    WHEN check_violation THEN
      RETURN jsonb_build_object('error', 'validation_failed');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'create', 'time_off', v_id);

  RETURN jsonb_build_object('time_off', (
    SELECT jsonb_build_object('id', t.id, 'practitioner_id', t.practitioner_id, 'starts_at', t.starts_at,
                              'ends_at', t.ends_at, 'reason', t.reason)
    FROM time_off t WHERE t.id = v_id));
END;
$fn$;

CREATE OR REPLACE FUNCTION app.time_off_delete(p_clinician_id UUID, p_time_off_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v       RECORD;
  v_pract UUID;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT practitioner_id INTO v_pract FROM time_off WHERE id = p_time_off_id;
  IF v_pract IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_pract <> p_clinician_id AND v.role <> 'admin' THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  DELETE FROM time_off WHERE id = p_time_off_id;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'delete', 'time_off', p_time_off_id);

  RETURN jsonb_build_object('ok', true);
END;
$fn$;

-- Requests waiting for a decision: upcoming pending appointments, from the
-- website or from patients' apps. Website requests carry possible matches
-- with existing patients (same e-mail, or same phone by its last 9 digits —
-- 050-… and +97250-… are the same number).
CREATE OR REPLACE FUNCTION app.booking_requests(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  RETURN jsonb_build_object('requests', COALESCE((
    SELECT jsonb_agg(
             app._sched_appointment_json(a.id)
             || jsonb_build_object('matches', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status) ORDER BY p.name)
                  FROM patient p
                  WHERE br.id IS NOT NULL AND br.patient_id IS NULL AND p.deleted_at IS NULL
                    AND (lower(p.email) = lower(br.email)
                         OR (length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9
                             AND right(regexp_replace(p.phone, '\D', '', 'g'), 9) = right(br.phone, 9)))
                ), '[]'::jsonb))
             ORDER BY a.starts_at)
    FROM appointment a
    LEFT JOIN booking_request br ON br.id = a.booking_request_id
    WHERE a.status = 'pending' AND a.starts_at > now()
  ), '[]'::jsonb));
END;
$fn$;

CREATE OR REPLACE FUNCTION app.booking_requests_count(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
  n INT;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SELECT count(*) FROM %I.appointment WHERE status = ''pending'' AND starts_at > now()', v.schema_name)
  INTO n;
  RETURN jsonb_build_object('count', n);
END;
$fn$;

-- Ties a website request (and its appointments) to a patient card: an
-- existing patient, or the one the add-patient flow just created from it.
CREATE OR REPLACE FUNCTION app.booking_link_patient(p_clinician_id UUID, p_request_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v     RECORD;
  v_req RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT * INTO v_req FROM booking_request WHERE id = p_request_id AND email_verified_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  UPDATE booking_request SET patient_id = p_patient_id, updated_at = now() WHERE id = p_request_id;
  UPDATE appointment SET patient_id = p_patient_id, updated_at = now() WHERE booking_request_id = p_request_id;
  UPDATE patient SET phone = v_req.phone, updated_at = now()
  WHERE id = p_patient_id AND NULLIF(btrim(phone), '') IS NULL;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'link_booking_request', 'patient', p_patient_id);

  RETURN jsonb_build_object('ok', true);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Public booking page (no sign-in; the edge function rate-limits)
-- ---------------------------------------------------------------------------

-- The clinic behind a public slug, or NULL when unknown / booking is off.
CREATE OR REPLACE FUNCTION app._sched_public_clinic(p_slug TEXT)
RETURNS TABLE (clinic_id UUID, schema_name TEXT, tz TEXT, settings JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $fn$
  SELECT c.id, 'clinic_' || c.slug, c.timezone, s
  FROM app.clinic c, LATERAL (SELECT app.scheduling_settings(c.id) AS s) st
  WHERE c.booking_slug = lower(btrim(p_slug))
    AND (s ->> 'booking_enabled')::boolean
    AND s ->> 'practitioner_id' IS NOT NULL;
$fn$;

CREATE OR REPLACE FUNCTION app.public_booking_profile(p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_public_clinic(p_slug);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  RETURN jsonb_build_object(
    'clinic', app._sched_clinic_public(v.clinic_id),
    'settings', jsonb_build_object(
      'horizon_days', (v.settings ->> 'horizon_days')::int,
      'min_notice_min', (v.settings ->> 'min_notice_min')::int,
      'free_cancel_hours', (v.settings ->> 'free_cancel_hours')::int),
    'types', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'description', t.description,
               'duration_min', t.duration_min, 'price_label', t.price_label) ORDER BY t.sort, t.name), '[]'::jsonb)
      FROM appointment_type t WHERE t.active AND t.who_may_book = 'anyone'),
    'body_regions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.sort_order), '[]'::jsonb)
      FROM app.body_region r)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.public_booking_slots(p_slug TEXT, p_type_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v      RECORD;
  v_dur  INT;
BEGIN
  SELECT * INTO v FROM app._sched_public_clinic(p_slug);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 31 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT duration_min INTO v_dur FROM appointment_type
  WHERE id = p_type_id AND active AND who_may_book = 'anyone';
  IF v_dur IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('slots', (
    SELECT COALESCE(jsonb_agg(f.slot_start ORDER BY f.slot_start), '[]'::jsonb)
    FROM app._sched_free_slots(v.schema_name, (v.settings ->> 'practitioner_id')::uuid, v_dur,
                               p_from, p_to, v.settings, v.tz) f));
END;
$fn$;

-- Step 1 of a website booking: store the request, unverified. The edge
-- function generated the e-mail code and passes only its hash.
CREATE OR REPLACE FUNCTION app.public_booking_request(p_slug TEXT, p_input JSONB, p_code_hash TEXT, p_ip_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  v_type   RECORD;
  v_start  TIMESTAMPTZ;
  v_email  TEXT;
  v_region UUID;
  v_id     UUID;
BEGIN
  SELECT * INTO v FROM app._sched_public_clinic(p_slug);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF p_code_hash IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR (p_input ->> 'consent') IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  BEGIN
    SELECT * INTO v_type FROM appointment_type
    WHERE id = (p_input ->> 'type_id')::uuid AND active AND who_may_book = 'anyone';
    v_start := (p_input ->> 'starts_at')::timestamptz;
    v_email := lower(btrim(p_input ->> 'email'));
    v_region := NULLIF(p_input ->> 'body_region_id', '')::uuid;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;
  IF v_type.id IS NULL OR v_start IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  IF v_region IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.body_region WHERE id = v_region) THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  -- One upcoming website booking per e-mail address; the confirmation
  -- e-mail has the link to change it.
  IF EXISTS (
    SELECT 1 FROM appointment a JOIN booking_request br ON br.id = a.booking_request_id
    WHERE lower(br.email) = v_email AND a.status IN ('pending', 'confirmed') AND a.starts_at > now()
  ) THEN
    RETURN jsonb_build_object('error', 'already_booked');
  END IF;

  IF NOT app._sched_slot_open(v.schema_name, (v.settings ->> 'practitioner_id')::uuid, v_type.duration_min,
                              v_start, v.settings, v.tz) THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END IF;

  BEGIN
    INSERT INTO booking_request (clinic_id, practitioner_id, type_id, starts_at, name, phone, email,
                                 body_region_id, consent_version, consent_at, code_hash, code_expires_at,
                                 ip_hash)
    VALUES (v.clinic_id, (v.settings ->> 'practitioner_id')::uuid, v_type.id, v_start,
            btrim(p_input ->> 'name'), p_input ->> 'phone', v_email, v_region,
            COALESCE(NULLIF(p_input ->> 'consent_version', ''), 'booking-v1'), now(),
            p_code_hash, now() + interval '15 minutes', p_ip_hash)
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  RETURN jsonb_build_object('request_id', v_id, 'email', v_email);
END;
$fn$;

-- Step 2: the visitor typed the e-mail code. A right code verifies the
-- address and books (pending, or confirmed for auto-confirm types). If the
-- slot was taken meanwhile the code stays valid, so the visitor can pick
-- another time (p_starts_at) without a new code. Never raises: the attempt
-- counter must survive a wrong code.
CREATE OR REPLACE FUNCTION app.public_booking_confirm(p_slug TEXT, p_request_id UUID, p_code_hash TEXT, p_starts_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  r        RECORD;
  v_type   RECORD;
  v_start  TIMESTAMPTZ;
  v_status TEXT;
  v_appt   UUID;
BEGIN
  SELECT * INTO v FROM app._sched_public_clinic(p_slug);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT * INTO r FROM booking_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Already booked (a double submit): report it again.
  SELECT a.id, a.status INTO v_appt, v_status FROM appointment a
  WHERE a.booking_request_id = r.id ORDER BY a.created_at DESC LIMIT 1;
  IF v_appt IS NOT NULL THEN
    RETURN jsonb_build_object('status', v_status, 'appointment_id', v_appt, 'clinic_id', v.clinic_id,
                              'email', r.email, 'repeat', true);
  END IF;

  IF r.code_hash IS NULL OR r.code_attempts >= 5 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts');
  END IF;
  IF r.code_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'code_expired');
  END IF;
  IF p_code_hash IS DISTINCT FROM r.code_hash THEN
    UPDATE booking_request SET code_attempts = code_attempts + 1, updated_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('error', 'invalid_code', 'attempts_left', GREATEST(0, 4 - r.code_attempts));
  END IF;

  UPDATE booking_request SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
  WHERE id = r.id;

  SELECT * INTO v_type FROM appointment_type WHERE id = r.type_id;
  v_start := COALESCE(p_starts_at, r.starts_at);
  IF NOT v_type.active OR v_type.who_may_book <> 'anyone' THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF NOT app._sched_slot_open(v.schema_name, r.practitioner_id, v_type.duration_min, v_start, v.settings, v.tz) THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END IF;

  v_status := CASE WHEN v_type.confirmation = 'auto' THEN 'confirmed' ELSE 'pending' END;
  BEGIN
    INSERT INTO appointment (clinic_id, practitioner_id, booking_request_id, type_id, starts_at, ends_at,
                             status, source, decided_at)
    VALUES (v.clinic_id, r.practitioner_id, r.id, r.type_id, v_start,
            v_start + make_interval(mins => v_type.duration_min), v_status, 'public',
            CASE WHEN v_status = 'confirmed' THEN now() END)
    RETURNING id INTO v_appt;
  EXCEPTION WHEN exclusion_violation THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END;

  UPDATE booking_request SET starts_at = v_start, code_hash = NULL, updated_at = now() WHERE id = r.id;

  PERFORM app._sched_notify_practitioner(v.schema_name, v.tz,
    CASE WHEN v_status = 'pending' THEN 'booking_request' ELSE 'booking_new' END, v_appt);

  RETURN jsonb_build_object('status', v_status, 'appointment_id', v_appt, 'clinic_id', v.clinic_id,
                            'email', r.email);
END;
$fn$;

-- A fresh code for an unverified request (at most 3 codes per request).
CREATE OR REPLACE FUNCTION app.public_booking_resend(p_slug TEXT, p_request_id UUID, p_code_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v RECORD;
  r RECORD;
BEGIN
  SELECT * INTO v FROM app._sched_public_clinic(p_slug);
  IF v.clinic_id IS NULL OR p_code_hash IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT * INTO r FROM booking_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.code_hash IS NULL OR r.email_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF r.codes_sent >= 3 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts');
  END IF;

  UPDATE booking_request
  SET code_hash = p_code_hash, code_expires_at = now() + interval '15 minutes', code_attempts = 0,
      codes_sent = codes_sent + 1, updated_at = now()
  WHERE id = r.id;

  RETURN jsonb_build_object('email', r.email);
END;
$fn$;

-- The manage-link page. The edge function has verified the link's
-- signature, which binds the clinic and appointment ids.
CREATE OR REPLACE FUNCTION app.public_appointment(p_clinic_id UUID, p_appointment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_tz     TEXT;
  v_hours  INT;
  v_row    JSONB;
BEGIN
  SELECT 'clinic_' || slug, timezone INTO v_schema, v_tz FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);
  v_hours := (app.scheduling_settings(p_clinic_id) ->> 'free_cancel_hours')::int;

  v_row := app._sched_patient_appointment_json(p_appointment_id, v_hours);
  IF v_row IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN jsonb_build_object('appointment', v_row, 'clinic', app._sched_clinic_public(p_clinic_id),
                            'free_cancel_hours', v_hours);
END;
$fn$;

-- Cancel by the patient (manage link or app), inside the policy window
-- only; later than that, the patient contacts the clinic.
CREATE OR REPLACE FUNCTION app._sched_patient_cancel(p_schema TEXT, p_clinic_id UUID, p_tz TEXT, p_appointment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $fn$
DECLARE
  a       RECORD;
  v_hours INT := (app.scheduling_settings(p_clinic_id) ->> 'free_cancel_hours')::int;
BEGIN
  SELECT * INTO a FROM appointment WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF a.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('error', 'not_cancellable');
  END IF;
  IF a.starts_at - now() <= make_interval(hours => v_hours) THEN
    RETURN jsonb_build_object('error', 'too_late', 'free_cancel_hours', v_hours);
  END IF;

  UPDATE appointment
  SET status = 'cancelled', cancelled_by = 'patient', cancelled_at = now(), updated_at = now()
  WHERE id = a.id;

  PERFORM app._sched_notify_practitioner(p_schema, p_tz, 'booking_cancelled', a.id);

  RETURN jsonb_build_object('appointment', app._sched_patient_appointment_json(a.id, v_hours));
END;
$fn$;

CREATE OR REPLACE FUNCTION app.public_appointment_cancel(p_clinic_id UUID, p_appointment_id UUID)
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

  v_res := app._sched_patient_cancel(v_schema, p_clinic_id, v_tz, p_appointment_id);
  IF v_res ? 'error' THEN
    RETURN v_res;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', NULL, 'cancel_via_link', 'appointment', p_appointment_id);

  RETURN v_res || jsonb_build_object('clinic_id', p_clinic_id);
END;
$fn$;

-- What a booking e-mail needs: recipient, time, type and clinic contact.
-- Never the patient's name or anything clinical (CLAUDE.md rule 9).
CREATE OR REPLACE FUNCTION app.appointment_email_context(p_clinic_id UUID, p_appointment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
BEGIN
  SELECT 'clinic_' || slug INTO v_schema FROM app.clinic WHERE id = p_clinic_id;
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  RETURN (
    SELECT jsonb_build_object(
      'appointment_id', a.id,
      'clinic_id', p_clinic_id,
      'to', COALESCE(NULLIF(btrim(p.email), ''), br.email),
      'status', a.status,
      'starts_at', a.starts_at,
      'ends_at', a.ends_at,
      'updated_at', a.updated_at,
      'type_name', t.name,
      'cancel_reason', a.cancel_reason,
      'free_cancel_hours', (app.scheduling_settings(p_clinic_id) ->> 'free_cancel_hours')::int,
      'clinic', app._sched_clinic_public(p_clinic_id))
    FROM appointment a
    JOIN appointment_type t ON t.id = a.type_id
    LEFT JOIN patient p ON p.id = a.patient_id
    LEFT JOIN booking_request br ON br.id = a.booking_request_id
    WHERE a.id = p_appointment_id
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Patient app
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.me_appointments(p_patient_auth_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v       RECORD;
  v_set   JSONB;
  v_hours INT;
BEGIN
  SELECT * INTO v FROM app._sched_patient(p_patient_auth_id);
  IF v.patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);
  v_set := app.scheduling_settings(v.clinic_id);
  v_hours := (v_set ->> 'free_cancel_hours')::int;

  RETURN jsonb_build_object(
    'timezone', v.tz,
    'clinic', app._sched_clinic_public(v.clinic_id),
    'free_cancel_hours', v_hours,
    'horizon_days', (v_set ->> 'horizon_days')::int,
    'upcoming', COALESCE((
      SELECT jsonb_agg(app._sched_patient_appointment_json(a.id, v_hours) ORDER BY a.starts_at)
      FROM appointment a
      WHERE a.patient_id = v.patient_id AND a.status IN ('pending', 'confirmed') AND a.ends_at > now()
    ), '[]'::jsonb),
    'past', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.starts_at DESC)
      FROM (
        SELECT app._sched_patient_appointment_json(a.id, v_hours) AS j, a.starts_at
        FROM appointment a
        WHERE a.patient_id = v.patient_id
          AND (a.ends_at <= now() OR a.status NOT IN ('pending', 'confirmed'))
        ORDER BY a.starts_at DESC
        LIMIT 5
      ) x
    ), '[]'::jsonb),
    'types', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'description', t.description,
               'duration_min', t.duration_min, 'price_label', t.price_label,
               'confirmation', t.confirmation) ORDER BY t.sort, t.name)
      FROM appointment_type t
      WHERE t.active AND t.who_may_book IN ('anyone', 'existing')
        AND v.status <> 'discharged'
        AND EXISTS (SELECT 1 FROM availability_rule r WHERE r.practitioner_id = v.practitioner_id)
    ), '[]'::jsonb)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION app.me_appointment_slots(p_patient_auth_id UUID, p_type_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v     RECORD;
  v_dur INT;
BEGIN
  SELECT * INTO v FROM app._sched_patient(p_patient_auth_id);
  IF v.patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 31 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT duration_min INTO v_dur FROM appointment_type
  WHERE id = p_type_id AND active AND who_may_book IN ('anyone', 'existing');
  IF v_dur IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('slots', (
    SELECT COALESCE(jsonb_agg(f.slot_start ORDER BY f.slot_start), '[]'::jsonb)
    FROM app._sched_free_slots(v.schema_name, v.practitioner_id, v_dur, p_from, p_to,
                               app.scheduling_settings(v.clinic_id), v.tz) f));
END;
$fn$;

CREATE OR REPLACE FUNCTION app.me_appointment_book(p_patient_auth_id UUID, p_type_id UUID, p_starts_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  v_type   RECORD;
  v_set    JSONB;
  v_status TEXT;
  v_id     UUID;
BEGIN
  SELECT * INTO v FROM app._sched_patient(p_patient_auth_id);
  IF v.patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF v.status = 'discharged' THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);
  v_set := app.scheduling_settings(v.clinic_id);

  SELECT * INTO v_type FROM appointment_type
  WHERE id = p_type_id AND active AND who_may_book IN ('anyone', 'existing');
  IF v_type.id IS NULL OR p_starts_at IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  -- Keeps one patient from holding half the calendar.
  IF (SELECT count(*) FROM appointment
      WHERE patient_id = v.patient_id AND status IN ('pending', 'confirmed') AND starts_at > now()) >= 4 THEN
    RETURN jsonb_build_object('error', 'limit_reached');
  END IF;

  IF NOT app._sched_slot_open(v.schema_name, v.practitioner_id, v_type.duration_min, p_starts_at, v_set, v.tz) THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END IF;

  v_status := CASE WHEN v_type.confirmation = 'auto' THEN 'confirmed' ELSE 'pending' END;
  BEGIN
    INSERT INTO appointment (clinic_id, practitioner_id, patient_id, type_id, starts_at, ends_at,
                             status, source, decided_at)
    VALUES (v.clinic_id, v.practitioner_id, v.patient_id, v_type.id, p_starts_at,
            p_starts_at + make_interval(mins => v_type.duration_min), v_status, 'patient_app',
            CASE WHEN v_status = 'confirmed' THEN now() END)
    RETURNING id INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RETURN jsonb_build_object('error', 'slot_taken');
  END;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'book', 'appointment', v_id);

  PERFORM app._sched_notify_practitioner(v.schema_name, v.tz,
    CASE WHEN v_status = 'pending' THEN 'booking_request' ELSE 'booking_new' END, v_id);

  RETURN jsonb_build_object(
    'appointment', app._sched_patient_appointment_json(v_id, (v_set ->> 'free_cancel_hours')::int),
    'clinic_id', v.clinic_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.me_appointment_cancel(p_patient_auth_id UUID, p_appointment_id UUID)
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

  -- Someone else's appointment is indistinguishable from a missing one.
  IF NOT EXISTS (SELECT 1 FROM appointment WHERE id = p_appointment_id AND patient_id = v.patient_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_res := app._sched_patient_cancel(v.schema_name, v.clinic_id, v.tz, p_appointment_id);
  IF v_res ? 'error' THEN
    RETURN v_res;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'cancel', 'appointment', p_appointment_id);

  RETURN v_res || jsonb_build_object('clinic_id', v.clinic_id);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Sweep: expire undecided requests whose time has come, and purge
--    website requests that never became an appointment (unverified, or
--    verified but the visitor never picked a free time) — they only hold
--    contact details someone typed in, so they go after a day.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.scheduling_sweep()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug     TEXT;
  v_schema   TEXT;
  v_expired  INT := 0;
  v_purged   INT := 0;
  n          INT;
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_schema := 'clinic_' || v_slug;
    CONTINUE WHEN to_regclass(format('%I.appointment', v_schema)) IS NULL;

    EXECUTE format(
      'UPDATE %I.appointment
          SET status = ''expired'', cancelled_by = ''system'', cancelled_at = now(), updated_at = now()
        WHERE status = ''pending'' AND starts_at <= now()', v_schema);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_expired := v_expired + n;

    EXECUTE format(
      'DELETE FROM %I.booking_request br
        WHERE br.created_at < now() - interval ''1 day''
          AND NOT EXISTS (SELECT 1 FROM %I.appointment a WHERE a.booking_request_id = br.id)',
      v_schema, v_schema);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_purged := v_purged + n;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'purged', v_purged);
END;
$fn$;

DO $cron$
BEGIN
  PERFORM cron.schedule('scheduling-sweep', '*/10 * * * *', $job$SELECT app.scheduling_sweep()$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); run app.scheduling_sweep() every 10 min by other means', SQLERRM;
END
$cron$;

-- ---------------------------------------------------------------------------
-- 9. Privileges: service_role only (0047), then a self-check over what this
--    migration created. Scoped to it on purpose: an unrelated object elsewhere
--    in a database must not be able to block this deploy (0047 checks the
--    whole surface).
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE sched_fn AS
SELECT p.oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'app' AND (p.proname LIKE '\_sched%' OR p.proname IN (
         'sched_overlap_guard', 'scheduling_settings', 'scheduling_setup', 'scheduling_update_settings',
         'appointment_type_save', 'availability_save', 'calendar_range', 'appointment_create',
         'appointment_update', 'time_off_create', 'time_off_delete', 'booking_requests',
         'booking_requests_count', 'booking_link_patient', 'public_booking_profile',
         'public_booking_slots', 'public_booking_request', 'public_booking_confirm',
         'public_booking_resend', 'public_appointment', 'public_appointment_cancel',
         'appointment_email_context', 'me_appointments', 'me_appointment_slots',
         'me_appointment_book', 'me_appointment_cancel', 'scheduling_sweep')))
   OR (n.nspname = 'public' AND p.proname IN ('add_clinic_scheduling_tables', 'add_clinic_columns'));

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
  SELECT string_agg(item, ', ') INTO v_leaks FROM (
    SELECT format('%s EXECUTE %s', r.rolname, f.oid::regprocedure) AS item
    FROM sched_fn f
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE has_function_privilege(r.rolname, f.oid, 'EXECUTE')
    UNION ALL
    SELECT format('%s TABLE %s.%s', r.rolname, n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE ((n.nspname LIKE 'clinic\_%'
            AND c.relname IN ('appointment_type', 'availability_rule', 'time_off', 'booking_request', 'appointment'))
           OR (n.nspname = 'app' AND c.relname = 'clinic'))
      AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
  ) leaks;

  IF v_leaks IS NOT NULL THEN
    RAISE EXCEPTION 'scheduling lockdown incomplete: %', v_leaks;
  END IF;
END $$;

DROP TABLE sched_fn;
