-- 0010_messaging.sql
-- T-19 Messaging — one two-way thread per patient (message table, 0001).
--
--   GET/POST /patients/:id/messages   (clinician)  -> app.thread_for_clinician / app.send_message_clinician
--   GET/POST /me/messages             (patient)    -> app.thread_for_patient   / app.send_message_patient
--
-- Reading a thread marks the *other* party's messages read (read receipt:
-- the sender then sees read_at on their own messages). A new message enqueues
-- a `new_message` push through the T-18 engine (category `messages`, opt-out
-- able, 5-minute dedupe bucket so a burst is one push).

-- ---------------------------------------------------------------------------
-- clinician side
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.thread_for_clinician(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_name   TEXT;
  v_msgs   JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT name INTO v_name FROM patient WHERE id = p_patient_id AND deleted_at IS NULL;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');   -- cross-clinic id => 404
  END IF;

  UPDATE message SET read_at = now()
  WHERE patient_id = p_patient_id AND sender_type = 'patient' AND read_at IS NULL;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('id', m.id, 'sender_type', m.sender_type, 'body', m.body,
                              'sent_at', m.sent_at, 'read_at', m.read_at)
           ORDER BY m.sent_at), '[]'::jsonb)
  INTO v_msgs FROM message m WHERE m.patient_id = p_patient_id;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'read', 'message_thread', p_patient_id);

  RETURN jsonb_build_object('patient', jsonb_build_object('id', p_patient_id, 'name', v_name),
                            'messages', v_msgs);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.send_message_clinician(p_clinician_id UUID, p_patient_id UUID, p_body TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema  TEXT;
  v_body    TEXT := btrim(COALESCE(p_body, ''));
  v_ptz     TEXT;
  v_pname   TEXT;
  v_cname   TEXT;
  v_row     JSONB;
BEGIN
  IF v_body = '' OR length(v_body) > 4000 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'body_length');
  END IF;

  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT timezone, name INTO v_ptz, v_pname FROM patient WHERE id = p_patient_id AND deleted_at IS NULL;
  IF v_ptz IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  SELECT name INTO v_cname FROM app."user" WHERE id = p_clinician_id;

  INSERT INTO message (patient_id, sender_type, sender_id, body)
  VALUES (p_patient_id, 'clinician', p_clinician_id, v_body)
  RETURNING jsonb_build_object('id', id, 'sender_type', sender_type, 'body', body,
                               'sent_at', sent_at, 'read_at', read_at) INTO v_row;

  PERFORM app.notification_enqueue(
    v_schema, 'patient', p_patient_id, 'new_message', 'push', 'messages', v_ptz,
    jsonb_build_object('from_name', COALESCE(v_cname, 'המטפל'),
                       'preview', left(v_body, 120)),
    'notif:new_message:' || p_patient_id || ':' ||
      to_char(date_trunc('hour', now()) + (floor(EXTRACT(MINUTE FROM now()) / 5) * interval '5 min'), 'YYYYMMDDHH24MI'),
    false);

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION app.messages_unread_clinician(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_out    JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'total', COALESCE(sum(c), 0),
    'by_patient', COALESCE(jsonb_object_agg(patient_id::text, c) FILTER (WHERE c > 0), '{}'::jsonb)
  )
  INTO v_out
  FROM (
    SELECT patient_id, count(*) AS c
    FROM message
    WHERE sender_type = 'patient' AND read_at IS NULL
    GROUP BY patient_id
  ) s;

  RETURN v_out;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- patient side
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.thread_for_patient(p_patient_auth_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema     TEXT;
  v_msgs       JSONB;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE message SET read_at = now()
  WHERE patient_id = v_patient_id AND sender_type = 'clinician' AND read_at IS NULL;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('id', m.id, 'sender_type', m.sender_type, 'body', m.body,
                              'sent_at', m.sent_at, 'read_at', m.read_at)
           ORDER BY m.sent_at), '[]'::jsonb)
  INTO v_msgs FROM message m WHERE m.patient_id = v_patient_id;

  RETURN jsonb_build_object('messages', v_msgs);
END;
$fn$;

CREATE OR REPLACE FUNCTION app.send_message_patient(p_patient_auth_id UUID, p_body TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema     TEXT;
  v_body       TEXT := btrim(COALESCE(p_body, ''));
  v_clin       UUID;
  v_ctz        TEXT;
  v_pname      TEXT;
  v_row        JSONB;
BEGIN
  IF v_body = '' OR length(v_body) > 4000 THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'body_length');
  END IF;

  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT primary_clinician_id, name INTO v_clin, v_pname FROM patient WHERE id = v_patient_id;
  SELECT timezone INTO v_ctz FROM app.clinic c
  WHERE c.id = (SELECT clinic_id FROM patient WHERE id = v_patient_id);

  INSERT INTO message (patient_id, sender_type, sender_id, body)
  VALUES (v_patient_id, 'patient', v_patient_id, v_body)
  RETURNING jsonb_build_object('id', id, 'sender_type', sender_type, 'body', body,
                               'sent_at', sent_at, 'read_at', read_at) INTO v_row;

  PERFORM app.notification_enqueue(
    v_schema, 'user', v_clin, 'new_message', 'push', 'messages', COALESCE(v_ctz, 'Asia/Jerusalem'),
    jsonb_build_object('from_name', COALESCE(v_pname, 'מטופל'),
                       'preview', left(v_body, 120),
                       'patient_id', v_patient_id),
    'notif:new_message:' || v_clin || ':' || v_patient_id || ':' ||
      to_char(date_trunc('hour', now()) + (floor(EXTRACT(MINUTE FROM now()) / 5) * interval '5 min'), 'YYYYMMDDHH24MI'),
    false);

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION app.messages_unread_patient(p_patient_auth_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema     TEXT;
  v_n          INT;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN 0;
  END IF;
  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT count(*) INTO v_n
  FROM message
  WHERE patient_id = v_patient_id AND sender_type = 'clinician' AND read_at IS NULL;
  RETURN v_n;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.thread_for_clinician(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.send_message_clinician(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.messages_unread_clinician(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.thread_for_patient(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.send_message_patient(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.messages_unread_patient(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.thread_for_clinician(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.send_message_clinician(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.messages_unread_clinician(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.thread_for_patient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.send_message_patient(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.messages_unread_patient(UUID) TO authenticated, service_role;
