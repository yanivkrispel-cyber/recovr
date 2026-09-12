-- 0001's blanket GRANT ... ON ALL TABLES IN SCHEMA app only covered tables
-- that existed at the time it ran; every table added since has needed its
-- own grant (see the pattern in 0009_notifications.sql, where new tables are
-- reached only through SECURITY DEFINER functions instead). This table is
-- only ever touched by the service-role client inside edge functions.
GRANT SELECT, INSERT, UPDATE ON app.media_signed_url_cache TO service_role;
