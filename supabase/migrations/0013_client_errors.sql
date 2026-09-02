-- 0013_client_errors.sql — T-24 error tracking sink.
--
-- The ui ErrorBoundary POSTs render crashes, window errors and unhandled
-- rejections to the client-errors edge function, which lands them here. Rows
-- expire after 90 days (added to the nightly retention_purge).

CREATE TABLE IF NOT EXISTS app.client_error (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  stack       TEXT,
  context     TEXT,
  url         TEXT,
  user_agent  TEXT,
  actor_id    UUID,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_error_recent_idx ON app.client_error (received_at DESC);

CREATE OR REPLACE FUNCTION app.record_client_error(p JSONB, p_actor UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  INSERT INTO app.client_error (app, kind, message, stack, context, url, user_agent, actor_id)
  VALUES (
    left(COALESCE(p ->> 'app', ''), 40),
    left(COALESCE(p ->> 'kind', ''), 40),
    left(COALESCE(NULLIF(p ->> 'message', ''), '(no message)'), 2000),
    left(p ->> 'stack', 8000),
    left(p ->> 'context', 4000),
    left(p ->> 'url', 500),
    left(p ->> 'user_agent', 500),
    p_actor
  );
$$;

REVOKE ALL ON FUNCTION app.record_client_error(JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_client_error(JSONB, UUID) TO service_role;

-- fold client_error expiry into the nightly purge (0012)
CREATE OR REPLACE FUNCTION app.retention_purge()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_slug     TEXT;
  v_schema   TEXT;
  v_years    INT;
  v_cut      TIMESTAMPTZ;
  n          INT;
  v_audit    INT := 0;
  v_notif    INT := 0;
  v_patients INT := 0;
  v_errors   INT := 0;
BEGIN
  DELETE FROM app.client_error WHERE received_at < now() - interval '90 days';
  GET DIAGNOSTICS v_errors = ROW_COUNT;

  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_schema := 'clinic_' || v_slug;
    SELECT COALESCE((settings ->> 'retention_years')::int, retention_years, 7)
    INTO v_years FROM app.clinic WHERE slug = v_slug;
    v_cut := now() - make_interval(years => GREATEST(v_years, 1));

    EXECUTE format(
      'DELETE FROM app.audit_log a WHERE a.at < %1$L AND a.entity_type = ''patient''
         AND a.entity_id IN (SELECT id FROM %2$I.patient)',
      v_cut, v_schema);
    GET DIAGNOSTICS n = ROW_COUNT; v_audit := v_audit + n;

    EXECUTE format('DELETE FROM %I.notification WHERE scheduled_for < now() - interval ''1 year''', v_schema);
    GET DIAGNOSTICS n = ROW_COUNT; v_notif := v_notif + n;

    EXECUTE format(
      'DELETE FROM %1$I.phase_transition WHERE plan_id IN (
         SELECT pl.id FROM %1$I.plan pl JOIN %1$I.patient p ON p.id = pl.patient_id
         WHERE p.deleted_at IS NOT NULL AND p.deleted_at < %2$L);
       DELETE FROM %1$I.alert WHERE patient_id IN (
         SELECT id FROM %1$I.patient WHERE deleted_at IS NOT NULL AND deleted_at < %2$L);
       DELETE FROM %1$I.patient WHERE deleted_at IS NOT NULL AND deleted_at < %2$L;',
      v_schema, v_cut);
    GET DIAGNOSTICS n = ROW_COUNT; v_patients := v_patients + n;
  END LOOP;

  RETURN jsonb_build_object(
    'audit_log', v_audit, 'notifications', v_notif,
    'patients', v_patients, 'client_errors', v_errors
  );
END;
$fn$;
