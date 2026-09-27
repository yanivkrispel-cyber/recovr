-- 0054: make the notifications-dispatch cron job actually reach the edge
-- function on hosted Supabase, and stop a stale backlog from ever flushing.
--
-- 0009 read the dispatcher URL/secret from `app.dispatch_url` /
-- `app.dispatch_secret` DB settings and fell back to the local-only
-- http://kong:8000. Those settings were never set in prod, so every run since
-- launch failed with "Couldn't resolve host name" — and pg_cron still reports
-- the job as succeeded, because net.http_post only enqueues the request.
--
-- The URL and secret now come from Supabase Vault (per environment, no
-- redeploy, and the secret never appears in cron.job's command text):
--   SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1/notifications-dispatch',
--                              'notifications_dispatch_url');
--   SELECT vault.create_secret('<DISPATCH_SECRET>', 'notifications_dispatch_secret');
-- The DB settings and the kong fallback still apply when the Vault rows are
-- absent, so local dev keeps working unchanged.

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
        url := COALESCE(
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notifications_dispatch_url'),
          current_setting('app.dispatch_url', true),
          'http://kong:8000/functions/v1/notifications-dispatch'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-dispatch-secret', COALESCE(
            (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notifications_dispatch_secret'),
            current_setting('app.dispatch_secret', true),
            '')),
        body := '{}'::jsonb
      );
    $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_net/pg_cron/vault unavailable (%); trigger notifications-dispatch by other means', SQLERRM;
END
$cron$;

-- A notification that couldn't go out within 24h of its slot is no longer
-- useful ("today's workout is waiting" three days late). Expire it instead of
-- handing it to the dispatcher, so an outage — like the one above — never
-- ends in a burst of stale pushes once delivery recovers.
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
    EXECUTE format(
      'UPDATE %I.notification
          SET status = ''failed'',
              payload = payload || jsonb_build_object(''error'', ''expired'')
        WHERE status IN (''pending'', ''deferred'')
          AND scheduled_for < now() - interval ''24 hours''',
      'clinic_' || v_slug
    );
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
REVOKE ALL ON FUNCTION app.notifications_due(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notifications_due(INT) TO service_role;
