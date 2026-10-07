-- ============================================================================
-- Scheduling invariants (0062) against the local database.
--
--   docker exec -i supabase_db_recoveryos psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/scheduling.test.sql
--
-- Needs the demo seed (clinic_demo, clinician 2222…, patient "דנה רז" with a
-- patient login). Everything runs in one transaction that is rolled back, so
-- the database is left as it was. A failed assertion aborts with its label.
-- Independent of whatever else the calendar holds: it works on a day two
-- months out, compares counts against a baseline, and finds its own rows by id.
-- ============================================================================

BEGIN;

CREATE FUNCTION pg_temp.eq(actual ANYELEMENT, expected ANYELEMENT, label TEXT) RETURNS VOID AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok  %', label;
END $$ LANGUAGE plpgsql;

-- Local wall-clock time on test day D → timestamptz.
CREATE FUNCTION pg_temp.at(p_day DATE, p_time TEXT) RETURNS TIMESTAMPTZ AS $$
  SELECT (p_day + p_time::time) AT TIME ZONE 'Asia/Jerusalem';
$$ LANGUAGE sql;

DO $test$
DECLARE
  doc   CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  pt    CONSTANT UUID := '7c75eb99-ca61-4c7f-87f4-145ba1c02686';  -- דנה רז
  pauth UUID;
  d     DATE := (now() AT TIME ZONE 'Asia/Jerusalem')::date + 60;
  base_pending INT;
  r     JSONB;
  t_eval UUID;
  t_tx   UUID;
  a1     UUID;
  a2     UUID;
  a3     UUID;
  req    UUID;
  req2   UUID;
  off1   UUID;
  n      INT;
BEGIN
  SELECT id INTO pauth FROM app.patient_auth WHERE patient_id = pt;

  -- A clean slate for the parts that count: no backlog for the sweep, none
  -- of the test patient's own upcoming visits (limit / ownership checks).
  PERFORM app.scheduling_sweep();
  UPDATE clinic_demo.appointment SET status = 'cancelled'
  WHERE patient_id = pt AND status IN ('pending', 'confirmed') AND starts_at > now();
  DELETE FROM clinic_demo.booking_request br
  WHERE br.email_verified_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM clinic_demo.appointment a WHERE a.booking_request_id = br.id);
  base_pending := (app.booking_requests_count(doc) ->> 'count')::int;

  -- --- setup ---------------------------------------------------------------
  PERFORM app.scheduling_update_settings(doc, '{"horizon_days": 90}');
  r := app.scheduling_update_settings(doc, '{"booking_slug": "demo-test", "booking_enabled": true}');
  PERFORM pg_temp.eq(r -> 'settings' ->> 'practitioner_id', doc::text, 'enabling booking defaults the practitioner to the caller');

  r := app.scheduling_update_settings(doc, '{"slot_step_min": 7}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'slot step must be one of the offered values');
  r := app.scheduling_update_settings(doc, '{"booking_slug": "Bad Slug!"}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'slug format is enforced');
  r := app.scheduling_update_settings(doc, '{"unknown_key": 1}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'unknown settings keys are refused');

  r := app.appointment_type_save(doc, '{"name": "הערכה ראשונה", "duration_min": 60, "who_may_book": "anyone", "confirmation": "manual"}');
  t_eval := (r -> 'type' ->> 'id')::uuid;
  r := app.appointment_type_save(doc, '{"name": "טיפול", "duration_min": 45, "who_may_book": "existing", "confirmation": "auto"}');
  t_tx := (r -> 'type' ->> 'id')::uuid;
  r := app.appointment_type_save(doc, '{"name": "", "duration_min": 45}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'type name is required');
  r := app.appointment_type_save(doc, '{"name": "x", "duration_min": 2}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'type duration has a floor');

  r := app.availability_save(doc, NULL, (
    SELECT jsonb_agg(x) FROM (
      SELECT jsonb_build_object('weekday', w, 'start_time', '08:00', 'end_time', '12:00') x FROM generate_series(0, 6) w
      UNION ALL
      SELECT jsonb_build_object('weekday', w, 'start_time', '14:00', 'end_time', '18:00') FROM generate_series(0, 6) w
    ) s));
  PERFORM pg_temp.eq(jsonb_array_length(r -> 'availability'), 14, 'weekly hours saved');

  r := app.availability_save(doc, NULL, '[{"weekday": 1, "start_time": "08:00", "end_time": "12:00"},
                                         {"weekday": 1, "start_time": "11:00", "end_time": "13:00"}]');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'overlapping windows on one day are refused');
  r := app.availability_save(doc, NULL, '[{"weekday": 1, "start_time": "08:07", "end_time": "12:00"}]');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'window times are on 5-minute marks');

  -- --- slot generation -----------------------------------------------------
  r := app.public_booking_slots('demo-test', t_eval, d, d);
  PERFORM pg_temp.eq(jsonb_array_length(r -> 'slots'), 14, '60-min type: 7 morning + 7 afternoon starts on a 30-min grid');
  PERFORM pg_temp.eq((r -> 'slots' ->> 0)::timestamptz, pg_temp.at(d, '08:00'), 'first slot is the window start');
  PERFORM pg_temp.eq((r -> 'slots' ->> 6)::timestamptz, pg_temp.at(d, '11:00'), 'last morning slot ends exactly at window end');

  r := app.public_booking_slots('demo-test', t_tx, d, d);
  PERFORM pg_temp.eq(r ->> 'error', 'not_found', 'existing-patients-only type is not offered publicly');

  -- clinician books 09:00–09:45
  r := app.appointment_create(doc, jsonb_build_object('patient_id', pt, 'type_id', t_tx, 'starts_at', pg_temp.at(d, '09:00')));
  a1 := (r -> 'appointment' ->> 'id')::uuid;
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'status', 'confirmed', 'clinician bookings are confirmed');

  r := app.public_booking_slots('demo-test', t_eval, d, d);
  SELECT count(*) INTO n FROM jsonb_array_elements_text(r -> 'slots') s
  WHERE s::timestamptz < pg_temp.at(d, '12:00');
  PERFORM pg_temp.eq(n, 4, 'busy 09:00–09:45 leaves 08:00, 10:00, 10:30, 11:00 for a 60-min type');

  PERFORM app.scheduling_update_settings(doc, '{"buffer_min": 15}');
  r := app.public_booking_slots('demo-test', t_eval, d, d);
  SELECT count(*) INTO n FROM jsonb_array_elements_text(r -> 'slots') s
  WHERE s::timestamptz < pg_temp.at(d, '12:00');
  PERFORM pg_temp.eq(n, 3, 'a 15-min buffer also drops 08:00 (ends 09:00, inside the buffer)');
  PERFORM app.scheduling_update_settings(doc, '{"buffer_min": 0}');

  -- --- overlap protection ---------------------------------------------------
  r := app.appointment_create(doc, jsonb_build_object('patient_id', pt, 'type_id', t_tx, 'starts_at', pg_temp.at(d, '09:30')));
  PERFORM pg_temp.eq(r ->> 'error', 'conflict', 'overlapping clinician booking is refused');
  PERFORM pg_temp.eq(r -> 'conflicts' -> 'appointments' -> 0 ->> 'id', a1::text, 'conflict names the appointment in the way');

  r := app.time_off_create(doc, jsonb_build_object('starts_at', pg_temp.at(d, '10:00'), 'ends_at', pg_temp.at(d, '11:00'), 'reason', 'כנס'));
  off1 := (r -> 'time_off' ->> 'id')::uuid;
  PERFORM pg_temp.eq(off1 IS NOT NULL, true, 'time off saved');
  r := app.appointment_create(doc, jsonb_build_object('patient_id', pt, 'type_id', t_tx, 'starts_at', pg_temp.at(d, '10:30')));
  PERFORM pg_temp.eq(r ->> 'error', 'conflict', 'booking into blocked time is refused');
  r := app.time_off_create(doc, jsonb_build_object('starts_at', pg_temp.at(d, '09:15'), 'ends_at', pg_temp.at(d, '09:20')));
  PERFORM pg_temp.eq(r ->> 'error', 'conflict', 'blocking time over an appointment is refused');

  r := app.public_booking_slots('demo-test', t_eval, d, d);
  SELECT count(*) INTO n FROM jsonb_array_elements_text(r -> 'slots') s
  WHERE s::timestamptz < pg_temp.at(d, '12:00');
  PERFORM pg_temp.eq(n, 2, 'blocked 10:00–11:00 leaves 08:00 and 11:00');

  BEGIN
    INSERT INTO clinic_demo.appointment (clinic_id, practitioner_id, patient_id, type_id, starts_at, ends_at, status, source)
    VALUES ('11111111-1111-1111-1111-111111111111', doc, pt, t_tx, pg_temp.at(d, '09:10'), pg_temp.at(d, '09:20'), 'pending', 'clinician');
    RAISE EXCEPTION 'FAIL exclusion constraint let an overlapping row in';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ok  database refuses an overlapping row written directly';
  END;

  -- --- website booking ------------------------------------------------------
  r := app.public_booking_request('demo-test', jsonb_build_object(
         'type_id', t_eval, 'starts_at', pg_temp.at(d, '14:00'), 'name', 'נוי שחר', 'phone', '0501234567',
         'email', 'Dana.Demo@example.test', 'consent', true), 'hash-1', 'ip');
  req := (r ->> 'request_id')::uuid;
  PERFORM pg_temp.eq(r ->> 'email', 'dana.demo@example.test', 'e-mail is stored lower-cased');

  r := app.public_booking_request('demo-test', jsonb_build_object(
         'type_id', t_eval, 'starts_at', pg_temp.at(d, '14:10'), 'name', 'x y', 'phone', '0501234567',
         'email', 'a@b.co', 'consent', true), 'h', 'ip');
  PERFORM pg_temp.eq(r ->> 'error', 'slot_taken', 'a start time that is not an offered slot is refused');
  r := app.public_booking_request('demo-test', jsonb_build_object(
         'type_id', t_eval, 'starts_at', pg_temp.at(d, '14:00'), 'name', 'x y', 'phone', '0501234567',
         'email', 'a@b.co', 'consent', false), 'h', 'ip');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'consent is required');

  r := app.public_booking_slots('demo-test', t_eval, d, d);
  SELECT count(*) INTO n FROM jsonb_array_elements_text(r -> 'slots') s WHERE s::timestamptz = pg_temp.at(d, '14:00');
  PERFORM pg_temp.eq(n, 1, 'an unverified request holds nothing');

  r := app.public_booking_confirm('demo-test', req, 'wrong', NULL);
  PERFORM pg_temp.eq(r ->> 'error', 'invalid_code', 'wrong code is refused');
  PERFORM pg_temp.eq((r ->> 'attempts_left')::int, 4, 'attempts are counted');

  r := app.public_booking_confirm('demo-test', req, 'hash-1', NULL);
  PERFORM pg_temp.eq(r ->> 'status', 'pending', 'manual-confirmation type lands as pending');
  a2 := (r ->> 'appointment_id')::uuid;
  r := app.public_booking_confirm('demo-test', req, 'hash-1', NULL);
  PERFORM pg_temp.eq(r ->> 'repeat', 'true', 'a double submit reports the same booking');

  SELECT count(*) INTO n FROM clinic_demo.notification WHERE event_key = 'booking_request' AND dedupe_key = 'booking_request:' || a2;
  PERFORM pg_temp.eq(n, 1, 'the practitioner gets a push for the new request');

  r := app.public_booking_request('demo-test', jsonb_build_object(
         'type_id', t_eval, 'starts_at', pg_temp.at(d, '15:00'), 'name', 'נוי שחר', 'phone', '0501234567',
         'email', 'dana.demo@example.test', 'consent', true), 'hash-2', 'ip');
  PERFORM pg_temp.eq(r ->> 'error', 'already_booked', 'one upcoming website booking per e-mail');

  r := app.booking_requests(doc);
  SELECT x INTO r FROM jsonb_array_elements(r -> 'requests') x WHERE x ->> 'id' = a2::text;
  PERFORM pg_temp.eq(r IS NOT NULL, true, 'request queue lists the pending request');
  PERFORM pg_temp.eq(r -> 'matches' -> 0 ->> 'id', pt::text, 'matched to the patient with the same e-mail');
  PERFORM pg_temp.eq((app.booking_requests_count(doc) ->> 'count')::int, base_pending + 1, 'badge count');

  -- slot taken between request and code → pick another time with the same code
  r := app.public_booking_request('demo-test', jsonb_build_object(
         'type_id', t_eval, 'starts_at', pg_temp.at(d, '16:00'), 'name', 'עמית', 'phone', '+972521112233',
         'email', 'amit@example.test', 'consent', true), 'hash-3', 'ip');
  req2 := (r ->> 'request_id')::uuid;
  PERFORM app.appointment_create(doc, jsonb_build_object('patient_id', pt, 'type_id', t_tx, 'starts_at', pg_temp.at(d, '16:00')));
  r := app.public_booking_confirm('demo-test', req2, 'hash-3', NULL);
  PERFORM pg_temp.eq(r ->> 'error', 'slot_taken', 'slot taken meanwhile is reported');
  r := app.public_booking_confirm('demo-test', req2, 'hash-3', pg_temp.at(d, '17:00'));
  PERFORM pg_temp.eq(r ->> 'status', 'pending', 'same code books another free time');
  a3 := (r ->> 'appointment_id')::uuid;

  -- --- status transitions -----------------------------------------------------
  r := app.appointment_update(doc, a2, '{"status": "attended"}');
  PERFORM pg_temp.eq(r ->> 'error', 'invalid_transition', 'pending cannot jump to attended');
  r := app.appointment_update(doc, a2, '{"status": "confirmed"}');
  PERFORM pg_temp.eq(r ->> 'change', 'confirmed', 'approve');
  r := app.appointment_update(doc, a2, jsonb_build_object('starts_at', pg_temp.at(d, '09:00')));
  PERFORM pg_temp.eq(r ->> 'error', 'conflict', 'moving onto a taken time is refused');
  r := app.appointment_update(doc, a2, jsonb_build_object('starts_at', pg_temp.at(d, '14:30')));
  PERFORM pg_temp.eq(r ->> 'change', 'moved', 'move');
  r := app.appointment_update(doc, a2, '{"status": "cancelled", "cancel_reason": "מחלה"}');
  PERFORM pg_temp.eq(r ->> 'change', 'cancelled', 'cancel');
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'cancelled_by', 'clinician', 'cancel records who');
  r := app.appointment_update(doc, a2, '{"status": "confirmed"}');
  PERFORM pg_temp.eq(r ->> 'change', 'confirmed', 'restore a cancelled appointment');
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'cancel_reason', NULL, 'restore clears the cancellation');
  r := app.appointment_update(doc, a1, '{"status": "attended"}');
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'status', 'attended', 'mark attended');

  r := app.calendar_range(doc, pg_temp.at(d, '00:00'), pg_temp.at(d + 1, '00:00'));
  PERFORM pg_temp.eq(jsonb_array_length(r -> 'appointments'), 4, 'calendar shows the day''s appointments');
  PERFORM pg_temp.eq(jsonb_array_length(r -> 'time_off'), 1, 'calendar shows blocked time');

  r := app.booking_link_patient(doc, req, pt);
  PERFORM pg_temp.eq(r ->> 'ok', 'true', 'website request linked to a patient card');
  SELECT count(*) INTO n FROM clinic_demo.appointment WHERE booking_request_id = req AND patient_id = pt;
  PERFORM pg_temp.eq(n, 1, 'linking carries over to the request''s appointment');

  -- --- patient app ---------------------------------------------------------
  r := app.me_appointments(pauth);
  SELECT count(*) INTO n FROM jsonb_array_elements(r -> 'types') x WHERE (x ->> 'id')::uuid IN (t_eval, t_tx);
  PERFORM pg_temp.eq(n, 2, 'patient can book both types');
  r := app.me_appointment_book(pauth, t_tx, pg_temp.at(d, '11:15'));
  PERFORM pg_temp.eq(r ->> 'error', 'slot_taken', 'off-grid start is refused for patients too');
  r := app.me_appointment_book(pauth, t_tx, pg_temp.at(d, '11:00'));
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'status', 'confirmed', 'auto-confirm type books straight away');
  a1 := (r -> 'appointment' ->> 'id')::uuid;
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'can_cancel', 'true', 'cancellable outside the window');

  -- Bring it within a week, then require 7 days' notice.
  UPDATE clinic_demo.appointment SET starts_at = now() + interval '3 days', ends_at = now() + interval '3 days 45 minutes'
  WHERE id = a1;
  PERFORM app.scheduling_update_settings(doc, '{"free_cancel_hours": 168}');
  r := app.me_appointment_cancel(pauth, a1);
  PERFORM pg_temp.eq(r ->> 'error', 'too_late', 'inside the free-cancellation window the patient must call');
  PERFORM app.scheduling_update_settings(doc, '{"free_cancel_hours": 24}');
  r := app.me_appointment_cancel(pauth, a1);
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'status', 'cancelled', 'patient cancels in time');
  r := app.me_appointment_cancel(pauth, a3);
  PERFORM pg_temp.eq(r ->> 'error', 'not_found', 'a patient cannot touch someone else''s appointment');
  r := app.me_appointment_cancel(pauth, a1);
  PERFORM pg_temp.eq(r ->> 'error', 'not_cancellable', 'an already cancelled appointment cannot be cancelled again');

  -- --- e-mail context never carries the name ----------------------------------
  r := app.appointment_email_context('11111111-1111-1111-1111-111111111111', a2);
  PERFORM pg_temp.eq(r ->> 'to', 'dana.demo@example.test', 'e-mail goes to the patient');
  PERFORM pg_temp.eq(position('דנה' IN r::text) = 0 AND position('נוי' IN r::text) = 0, true, 'no names in the e-mail context');

  -- --- sweep ---------------------------------------------------------------
  INSERT INTO clinic_demo.appointment (clinic_id, practitioner_id, patient_id, type_id, starts_at, ends_at, status, source)
  VALUES ('11111111-1111-1111-1111-111111111111', doc, pt, t_tx, now() - interval '400 days', now() - interval '400 days' + interval '45 minutes', 'pending', 'patient_app');
  UPDATE clinic_demo.booking_request SET created_at = now() - interval '2 days'
  WHERE id = (SELECT id FROM clinic_demo.booking_request WHERE email = 'dana.demo@example.test' LIMIT 1);
  INSERT INTO clinic_demo.booking_request (clinic_id, practitioner_id, type_id, starts_at, name, phone, email, consent_version, consent_at, code_hash, created_at)
  VALUES ('11111111-1111-1111-1111-111111111111', doc, t_eval, now(), 'old one', '0500000000', 'old@example.test', 'v', now(), 'h', now() - interval '2 days');
  r := app.scheduling_sweep();
  PERFORM pg_temp.eq((r ->> 'expired')::int, 1, 'sweep expires a pending request whose time passed');
  PERFORM pg_temp.eq((r ->> 'purged')::int, 1, 'sweep purges only requests that never became an appointment');

  RAISE NOTICE 'all scheduling checks passed';
END
$test$;

-- --- 0063: prices and the big picture, on a day nothing else touches --------
DO $test$
DECLARE
  doc  CONSTANT UUID := '22222222-2222-2222-2222-222222222222';
  pt   CONSTANT UUID := '7c75eb99-ca61-4c7f-87f4-145ba1c02686';
  cid  CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
  d2   DATE := (now() AT TIME ZONE 'Asia/Jerusalem')::date + 61;
  r    JSONB;
  t1   UUID;
  t2   UUID;
  b    UUID;
BEGIN
  r := app.appointment_type_save(doc, '{"name": "טיפול מבחן", "duration_min": 45, "who_may_book": "existing", "price_ils": 300}');
  t1 := (r -> 'type' ->> 'id')::uuid;
  PERFORM pg_temp.eq((r -> 'type' ->> 'price_ils')::numeric, 300::numeric, 'type price saved');
  r := app.appointment_type_save(doc, '{"name": "הערכה מבחן", "duration_min": 60, "who_may_book": "anyone", "price_ils": 400}');
  t2 := (r -> 'type' ->> 'id')::uuid;
  r := app.appointment_type_save(doc, '{"name": "שלילי", "duration_min": 45, "price_ils": -5}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'negative price refused');

  PERFORM app.time_off_create(doc, jsonb_build_object('starts_at', pg_temp.at(d2, '10:00'), 'ends_at', pg_temp.at(d2, '11:00')));
  INSERT INTO clinic_demo.appointment (clinic_id, practitioner_id, patient_id, type_id, starts_at, ends_at, status, source, price_ils)
  VALUES (cid, doc, pt, t1, pg_temp.at(d2, '08:00'), pg_temp.at(d2, '08:45'), 'attended', 'clinician', NULL),
         (cid, doc, pt, t2, pg_temp.at(d2, '09:00'), pg_temp.at(d2, '10:00'), 'confirmed', 'clinician', 350),
         (cid, doc, pt, t1, pg_temp.at(d2, '14:00'), pg_temp.at(d2, '14:45'), 'pending', 'patient_app', NULL),
         (cid, doc, pt, t1, pg_temp.at(d2, '15:00'), pg_temp.at(d2, '15:45'), 'cancelled', 'clinician', NULL),
         (cid, doc, pt, t1, pg_temp.at(d2, '16:00'), pg_temp.at(d2, '16:45'), 'no_show', 'clinician', NULL);
  SELECT id INTO b FROM clinic_demo.appointment WHERE starts_at = pg_temp.at(d2, '09:00') AND practitioner_id = doc;

  r := app.calendar_summary(doc, d2, d2) -> 'days' -> 0;
  PERFORM pg_temp.eq((r ->> 'available_min')::int, 420, 'working minutes = weekly hours minus blocked time');
  PERFORM pg_temp.eq((r ->> 'booked_min')::int, 195, 'booked = live appointments (pending, confirmed, attended, no-show)');
  PERFORM pg_temp.eq((r ->> 'free_min')::int, 225, 'free = working minus booked');
  PERFORM pg_temp.eq((r ->> 'open_slots')::int, 3, 'open slots: 45-min appointments that fit the gaps (15 / 60 / 75 / 75 min)');
  PERFORM pg_temp.eq((r ->> 'appointments')::int, 4, 'appointment count excludes the cancelled one');
  PERFORM pg_temp.eq((r ->> 'pending')::int || '/' || (r ->> 'attended') || '/' || (r ->> 'no_show') || '/' || (r ->> 'cancelled'), '1/1/1/1', 'status counts');
  PERFORM pg_temp.eq((r ->> 'revenue_expected')::numeric, 650::numeric, 'expected revenue = attended + confirmed, override wins');
  PERFORM pg_temp.eq((r ->> 'revenue_realised')::numeric, 300::numeric, 'realised revenue = attended');
  PERFORM pg_temp.eq((r ->> 'revenue_pending')::numeric, 300::numeric, 'pending revenue = requests awaiting approval');

  r := app.appointment_update(doc, b, '{"price_ils": null}');
  PERFORM pg_temp.eq(r -> 'appointment' ->> 'price_ils', NULL, 'clearing the override falls back to the type');
  r := app.calendar_summary(doc, d2, d2) -> 'days' -> 0;
  PERFORM pg_temp.eq((r ->> 'revenue_expected')::numeric, 700::numeric, 'revenue follows the type price after clearing');
  r := app.appointment_update(doc, b, '{"price_ils": -1}');
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'negative override refused');

  r := app.calendar_summary(doc, d2, d2 + 63);
  PERFORM pg_temp.eq(r ->> 'error', 'validation_failed', 'summary range is capped');

  r := app.clinician_free_slots(doc, t1, d2, d2);
  PERFORM pg_temp.eq(jsonb_array_length(r -> 'slots'), 3, 'clinician suggestions: 11:00, 15:00 (cancelled slot is free), 17:00');
  PERFORM pg_temp.eq((r -> 'slots' ->> 0)::timestamptz, pg_temp.at(d2, '11:00'), 'first suggestion after the blocked hour');

  RAISE NOTICE 'all insight checks passed';
END
$test$;

ROLLBACK;
