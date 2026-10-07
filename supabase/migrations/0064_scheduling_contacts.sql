-- ============================================================================
-- 0064 — book for someone who has no patient card yet.
--
-- A person calls or messages the clinic; the clinician books them straight
-- away from the calendar without opening a card (and without sending an app
-- invite). They are stored like a website visitor: a booking_request, now
-- with source 'clinician', so the calendar shows them as a new patient and
-- "open patient card" / linking to an existing card work unchanged.
--
--   * booking_request.source ('public' | 'clinician'); e-mail is optional for
--     clinician contacts (the public page still requires and verifies it).
--   * appointment_create accepts {"lead": {name, phone, email?}} in place of
--     patient_id: the request and the confirmed appointment are created
--     together (a clash rolls both back).
--   * booking_link_patient also links clinician contacts (no e-mail code).
--   * app.scheduling_contact_matches: existing cards with the same phone
--     (last 9 digits) or e-mail, offered before a duplicate contact is made.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. booking_request.source, optional e-mail (per clinic)
-- ---------------------------------------------------------------------------

-- Same body as 0063, plus the contact columns.
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
-- 2. appointment_create: a patient card or a new contact
-- ---------------------------------------------------------------------------

-- As 0063, plus {"lead": {"name", "phone", "email"?}} instead of patient_id.
CREATE OR REPLACE FUNCTION app.appointment_create(p_clinician_id UUID, p_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v          RECORD;
  v_type     RECORD;
  v_patient  UUID;
  v_lead     JSONB;
  v_name     TEXT;
  v_phone    TEXT;
  v_email    TEXT;
  v_request  UUID;
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
    v_lead := CASE WHEN jsonb_typeof(p_input -> 'lead') = 'object' THEN p_input -> 'lead' END;
    v_start := (p_input ->> 'starts_at')::timestamptz;
    v_pract := COALESCE((p_input ->> 'practitioner_id')::uuid, p_clinician_id);
    SELECT * INTO v_type FROM appointment_type WHERE id = (p_input ->> 'type_id')::uuid AND active;
    v_minutes := COALESCE((p_input ->> 'duration_min')::int, v_type.duration_min);
    v_price := (p_input ->> 'price_ils')::numeric;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END;

  -- Exactly one of: an existing card, or a new contact.
  IF (v_patient IS NULL) = (v_lead IS NULL) OR v_start IS NULL OR v_type.id IS NULL
     OR v_minutes IS NULL OR v_minutes < 5 OR v_minutes > 720 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;
  IF v_patient IS NOT NULL AND NOT EXISTS (SELECT 1 FROM patient WHERE id = v_patient AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_lead IS NOT NULL THEN
    v_name := btrim(COALESCE(v_lead ->> 'name', ''));
    v_phone := CASE WHEN btrim(COALESCE(v_lead ->> 'phone', '')) LIKE '+%' THEN '+' ELSE '' END
               || regexp_replace(COALESCE(v_lead ->> 'phone', ''), '\D', '', 'g');
    v_email := NULLIF(lower(btrim(COALESCE(v_lead ->> 'email', ''))), '');
    IF length(v_name) NOT BETWEEN 2 AND 80 OR v_phone !~ '^\+?[0-9]{9,15}$'
       OR (v_email IS NOT NULL AND (length(v_email) > 254
                                    OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) THEN
      RETURN jsonb_build_object('error', 'validation_failed');
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_pract AND clinic_id = v.clinic_id AND status = 'active') THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  BEGIN
    IF v_lead IS NOT NULL THEN
      -- Entered by the clinician: no e-mail code, nothing for the sweep to purge
      -- (it only removes requests that never got an appointment).
      INSERT INTO booking_request (clinic_id, practitioner_id, type_id, starts_at, name, phone, email,
                                   consent_version, consent_at, codes_sent, source)
      VALUES (v.clinic_id, v_pract, v_type.id, v_start, v_name, v_phone, v_email,
              'clinician', now(), 0, 'clinician')
      RETURNING id INTO v_request;
    END IF;

    INSERT INTO appointment (clinic_id, practitioner_id, patient_id, booking_request_id, type_id, starts_at, ends_at,
                             status, source, note, price_ils, created_by, decided_by, decided_at)
    VALUES (v.clinic_id, v_pract, v_patient, v_request, v_type.id, v_start, v_start + make_interval(mins => v_minutes),
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

-- ---------------------------------------------------------------------------
-- 3. Linking a request to a card: website requests once verified, clinician
--    contacts always
-- ---------------------------------------------------------------------------

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

  SELECT * INTO v_req FROM booking_request
  WHERE id = p_request_id AND (email_verified_at IS NOT NULL OR source = 'clinician')
  FOR UPDATE;
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
-- 4. Existing cards that look like a contact being typed in
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.scheduling_contact_matches(p_clinician_id UUID, p_phone TEXT, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v        RECORD;
  v_digits TEXT := right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 9);
  v_email  TEXT := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
BEGIN
  SELECT * INTO v FROM app._sched_clinician(p_clinician_id);
  IF v.clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v.schema_name);

  IF length(v_digits) < 9 AND v_email IS NULL THEN
    RETURN jsonb_build_object('matches', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('matches', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status) ORDER BY p.name)
    FROM patient p
    WHERE p.deleted_at IS NULL
      AND ((v_email IS NOT NULL AND lower(p.email) = v_email)
           OR (length(v_digits) = 9
               AND length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9
               AND right(regexp_replace(p.phone, '\D', '', 'g'), 9) = v_digits))
  ), '[]'::jsonb));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Privileges (service_role only) + the scoped self-check
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE sched_fn AS
SELECT p.oid
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE (n.nspname = 'app' AND p.proname IN ('appointment_create', 'booking_link_patient', 'scheduling_contact_matches'))
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
