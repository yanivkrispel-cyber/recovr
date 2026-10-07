-- ============================================================================
-- 0063 — scheduling insights: prices and the calendar's big picture.
--
--   * appointment_type.price_ils (₪) and appointment.price_ils — a
--     per-appointment override (discount, special case); NULL means the
--     type's price. price_label stays as optional display text.
--   * app.calendar_summary — per clinic-local day: working minutes (weekly
--     hours minus blocked time), booked minutes inside them, free minutes and
--     how many standard-length appointments still fit (from now on), counts
--     by status, expected / realised / pending revenue. Computed here so the
--     week strip, the week and month overviews, phone and desktop all show
--     the same numbers.
--   * app.clinician_free_slots — open start times for the clinician's
--     "new appointment" suggestions (same rules as patients, minus the
--     minimum notice and horizon).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Price columns (per clinic), through add_clinic_columns()
-- ---------------------------------------------------------------------------

-- Same body as 0062, plus the price columns.
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
-- 2. Payloads and writes that carry the price (bodies as 0062 + price)
-- ---------------------------------------------------------------------------

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
        price_ils    = CASE WHEN p_type ? 'price_ils' THEN (p_type ->> 'price_ils')::numeric ELSE price_ils END,
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
      INSERT INTO appointment_type (clinic_id, name, name_en, description, duration_min, price_label, price_ils,
                                    color, who_may_book, confirmation, active, sort)
      VALUES (
        v.clinic_id,
        btrim(p_type ->> 'name'),
        NULLIF(btrim(p_type ->> 'name_en'), ''),
        NULLIF(btrim(p_type ->> 'description'), ''),
        (p_type ->> 'duration_min')::int,
        NULLIF(btrim(p_type ->> 'price_label'), ''),
        (p_type ->> 'price_ils')::numeric,
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
  v_price    NUMERIC;
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
    v_price := (p_input ->> 'price_ils')::numeric;
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
                             status, source, note, price_ils, created_by, decided_by, decided_at)
    VALUES (v.clinic_id, v_pract, v_patient, v_type.id, v_start, v_start + make_interval(mins => v_minutes),
            'confirmed', 'clinician', NULLIF(btrim(p_input ->> 'note'), ''), v_price,
            p_clinician_id, p_clinician_id, now())
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

-- As 0062, plus `price_ils` (a number, or null to fall back to the type's).
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
               'duration_min', t.duration_min, 'price_label', t.price_label, 'price_ils', t.price_ils)
             ORDER BY t.sort, t.name), '[]'::jsonb)
      FROM appointment_type t WHERE t.active AND t.who_may_book = 'anyone'),
    'body_regions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.sort_order), '[]'::jsonb)
      FROM app.body_region r)
  );
END;
$fn$;

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
               'duration_min', t.duration_min, 'price_label', t.price_label, 'price_ils', t.price_ils,
               'confirmation', t.confirmation) ORDER BY t.sort, t.name)
      FROM appointment_type t
      WHERE t.active AND t.who_may_book IN ('anyone', 'existing')
        AND v.status <> 'discharged'
        AND EXISTS (SELECT 1 FROM availability_rule r WHERE r.practitioner_id = v.practitioner_id)
    ), '[]'::jsonb)
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The big picture
-- ---------------------------------------------------------------------------

-- Total length, in minutes, of a set of time ranges.
CREATE OR REPLACE FUNCTION app._sched_minutes(p tstzmultirange)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(round(sum(extract(epoch FROM upper(r) - lower(r))) / 60), 0)::int FROM unnest(p) r;
$fn$;

-- How many appointments of p_len minutes fit, one after another, in the gaps.
CREATE OR REPLACE FUNCTION app._sched_fits(p tstzmultirange, p_len INT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(sum(floor(extract(epoch FROM upper(r) - lower(r)) / 60 / p_len)), 0)::int FROM unnest(p) r;
$fn$;

-- Per clinic-local day of [p_from, p_to] (≤ 62 days) for one practitioner:
--   available_min  weekly hours minus blocked time
--   booked_min     live appointments inside those hours (so utilisation ≤ 100%)
--   free_min       available minus booked
--   open_slots     standard-length appointments that still fit from now on
--   appointments / pending / attended / no_show / cancelled
--   revenue_expected (confirmed + attended), revenue_realised (attended),
--   revenue_pending (requests awaiting approval); price = the appointment's
--   own price, else its type's.
-- `slot_min` is the standard length: the most common among the active types
-- patients can book (45 when there are none).
CREATE OR REPLACE FUNCTION app.calendar_summary(p_clinician_id UUID, p_from DATE, p_to DATE, p_practitioner_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v          RECORD;
  c          RECORD;
  v_pract    UUID;
  v_slot     INT;
  d          DATE;
  v_start    TIMESTAMPTZ;
  v_end      TIMESTAMPTZ;
  v_windows  tstzmultirange;
  v_off      tstzmultirange;
  v_busy     tstzmultirange;
  v_avail    tstzmultirange;
  v_free     tstzmultirange;
  v_open     tstzmultirange;
  v_day      JSONB;
  v_days     JSONB := '[]'::jsonb;
  t_avail INT := 0; t_booked INT := 0; t_free INT := 0; t_open INT := 0;
  t_appts INT := 0; t_pending INT := 0; t_attended INT := 0; t_noshow INT := 0; t_cancelled INT := 0;
  t_rev_exp NUMERIC := 0; t_rev_real NUMERIC := 0; t_rev_pend NUMERIC := 0;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  v_pract := COALESCE(p_practitioner_id, p_clinician_id);
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_pract AND clinic_id = v.clinic_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT duration_min INTO v_slot
  FROM appointment_type
  WHERE active AND who_may_book <> 'clinician_only'
  GROUP BY duration_min
  ORDER BY count(*) DESC, duration_min
  LIMIT 1;
  v_slot := COALESCE(v_slot, 45);

  FOR d IN SELECT g::date FROM generate_series(p_from, p_to, interval '1 day') g LOOP
    v_start := d::timestamp AT TIME ZONE v.tz;
    v_end := (d + 1)::timestamp AT TIME ZONE v.tz;

    SELECT COALESCE(range_agg(tstzrange((d + r.start_time) AT TIME ZONE v.tz, (d + r.end_time) AT TIME ZONE v.tz, '[)')),
                    '{}'::tstzmultirange)
    INTO v_windows
    FROM availability_rule r
    WHERE r.practitioner_id = v_pract AND r.weekday = extract(dow FROM d)::int;

    SELECT COALESCE(range_agg(tstzrange(t.starts_at, t.ends_at, '[)') * tstzrange(v_start, v_end, '[)')),
                    '{}'::tstzmultirange)
    INTO v_off
    FROM time_off t
    WHERE t.practitioner_id = v_pract AND t.starts_at < v_end AND t.ends_at > v_start;

    SELECT COALESCE(range_agg(tstzrange(a.starts_at, a.ends_at, '[)') * tstzrange(v_start, v_end, '[)')),
                    '{}'::tstzmultirange)
    INTO v_busy
    FROM appointment a
    WHERE a.practitioner_id = v_pract
      AND a.status IN ('pending', 'confirmed', 'attended', 'no_show')
      AND a.starts_at < v_end AND a.ends_at > v_start;

    v_avail := v_windows - v_off;
    v_free := v_avail - v_busy;
    v_open := v_free * tstzmultirange(tstzrange(GREATEST(now(), v_start), GREATEST(now(), v_end), '[)'));

    SELECT
      count(*) FILTER (WHERE a.status IN ('pending', 'confirmed', 'attended', 'no_show')) AS appts,
      count(*) FILTER (WHERE a.status = 'pending') AS pending,
      count(*) FILTER (WHERE a.status = 'attended') AS attended,
      count(*) FILTER (WHERE a.status = 'no_show') AS no_show,
      count(*) FILTER (WHERE a.status IN ('cancelled', 'declined')) AS cancelled,
      COALESCE(sum(COALESCE(a.price_ils, t.price_ils, 0)) FILTER (WHERE a.status IN ('confirmed', 'attended')), 0) AS rev_exp,
      COALESCE(sum(COALESCE(a.price_ils, t.price_ils, 0)) FILTER (WHERE a.status = 'attended'), 0) AS rev_real,
      COALESCE(sum(COALESCE(a.price_ils, t.price_ils, 0)) FILTER (WHERE a.status = 'pending'), 0) AS rev_pend
    INTO c
    FROM appointment a
    JOIN appointment_type t ON t.id = a.type_id
    WHERE a.practitioner_id = v_pract AND a.starts_at >= v_start AND a.starts_at < v_end;

    v_day := jsonb_build_object(
      'date', d,
      'available_min', app._sched_minutes(v_avail),
      'booked_min', app._sched_minutes(v_busy * v_avail),
      'free_min', app._sched_minutes(v_free),
      'open_slots', app._sched_fits(v_open, v_slot),
      'appointments', c.appts,
      'pending', c.pending,
      'attended', c.attended,
      'no_show', c.no_show,
      'cancelled', c.cancelled,
      'revenue_expected', c.rev_exp,
      'revenue_realised', c.rev_real,
      'revenue_pending', c.rev_pend);
    v_days := v_days || v_day;

    t_avail := t_avail + (v_day ->> 'available_min')::int;
    t_booked := t_booked + (v_day ->> 'booked_min')::int;
    t_free := t_free + (v_day ->> 'free_min')::int;
    t_open := t_open + (v_day ->> 'open_slots')::int;
    t_appts := t_appts + c.appts;
    t_pending := t_pending + c.pending;
    t_attended := t_attended + c.attended;
    t_noshow := t_noshow + c.no_show;
    t_cancelled := t_cancelled + c.cancelled;
    t_rev_exp := t_rev_exp + c.rev_exp;
    t_rev_real := t_rev_real + c.rev_real;
    t_rev_pend := t_rev_pend + c.rev_pend;
  END LOOP;

  RETURN jsonb_build_object(
    'timezone', v.tz,
    'slot_min', v_slot,
    'days', v_days,
    'totals', jsonb_build_object(
      'available_min', t_avail, 'booked_min', t_booked, 'free_min', t_free, 'open_slots', t_open,
      'appointments', t_appts, 'pending', t_pending, 'attended', t_attended, 'no_show', t_noshow,
      'cancelled', t_cancelled, 'revenue_expected', t_rev_exp, 'revenue_realised', t_rev_real,
      'revenue_pending', t_rev_pend,
      'utilisation', CASE WHEN t_avail > 0 THEN round(t_booked * 100.0 / t_avail)::int ELSE 0 END));
END;
$fn$;

-- Free start times for the clinician's own "new appointment" suggestions:
-- the patient rules (weekly hours, step grid, buffer, blocked time) without
-- the minimum notice or the booking horizon. ≤ 31 days per call.
CREATE OR REPLACE FUNCTION app.clinician_free_slots(p_clinician_id UUID, p_type_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v     RECORD;
  v_dur INT;
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 31 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  SELECT duration_min INTO v_dur FROM appointment_type WHERE id = p_type_id AND active;
  IF v_dur IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('slots', (
    SELECT COALESCE(jsonb_agg(f.slot_start ORDER BY f.slot_start), '[]'::jsonb)
    FROM app._sched_free_slots(v.schema_name, p_clinician_id, v_dur, p_from, p_to,
                               app.scheduling_settings(v.clinic_id) || '{"min_notice_min": 0, "horizon_days": 400}'::jsonb,
                               v.tz) f));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Privileges (service_role only) + the scoped self-check
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE sched_fn AS
SELECT p.oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'app' AND p.proname IN (
         '_sched_appointment_json', 'appointment_type_save', 'appointment_create', 'appointment_update',
         'public_booking_profile', 'me_appointments', '_sched_minutes', '_sched_fits',
         'calendar_summary', 'clinician_free_slots'))
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
