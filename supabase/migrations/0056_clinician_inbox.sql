-- Clinician message inbox: one row per patient who has a conversation, with
-- the latest message (preview) and the patient's unread count, newest first.
-- Feeds the clinician app's Messages screen (GET /messages?inbox=1). Doesn't
-- mark anything read — opening a thread (thread_for_clinician) still does.
-- Previews are message content, so the read is audited like a thread read.
-- Service role only (0047 default privileges; explicit here as in 0052).

CREATE OR REPLACE FUNCTION app.inbox_clinician(p_clinician_id UUID)
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

  -- Latest message per patient via message_patient_idx (patient_id, sent_at DESC).
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'patient_id',   p.id,
             'name',         p.name,
             'status',       p.status,
             'last_body',    left(last.body, 160),
             'last_sender',  last.sender_type,
             'last_sent_at', last.sent_at,
             'unread',       (SELECT count(*) FROM message u
                               WHERE u.patient_id = p.id AND u.sender_type = 'patient' AND u.read_at IS NULL)
           )
           ORDER BY last.sent_at DESC), '[]'::jsonb)
  INTO v_out
  FROM patient p
  CROSS JOIN LATERAL (
    SELECT m.body, m.sender_type, m.sent_at
    FROM message m
    WHERE m.patient_id = p.id
    ORDER BY m.sent_at DESC
    LIMIT 1
  ) last
  WHERE p.deleted_at IS NULL;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'read', 'message_inbox', p_clinician_id);

  RETURN jsonb_build_object('conversations', v_out);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION app.inbox_clinician(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.inbox_clinician(UUID) TO service_role;
