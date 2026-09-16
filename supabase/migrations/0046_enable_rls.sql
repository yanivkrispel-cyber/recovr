-- Enable Row-Level Security across all app-schema tables.
--
-- Every table in `app` is exposed via PostgREST (see [api].schemas in
-- supabase/config.toml) and previously carried a blanket
-- `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated` with no RLS
-- policy anywhere in the migration history. That meant any signed-in
-- clinician/patient JWT (issued by Supabase Auth) could read or write
-- every row of every table directly via the REST API -- bypassing the
-- edge functions, and clinic isolation, entirely. That includes
-- app.user.password_hash/mfa_secret and
-- app.patient_auth.password_hash/invite_token. Flagged by Supabase's
-- security advisor as rls_disabled_in_public / sensitive_columns_exposed.
--
-- Every read/write the app itself performs goes through edge functions
-- using the service_role key, which bypasses RLS (BYPASSRLS on Supabase's
-- service_role), so enabling RLS with no policies is safe: `authenticated`
-- is denied by default and nothing else changes.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'app'
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- enable_rls_for_schema(schema) -- shared helper so provision_clinic(),
-- the demo seed, and scripts/apply-to-all-clinics.ts all lock a clinic
-- schema down the same way, without duplicating the loop everywhere.
-- clinic_<slug> schemas aren't listed in [api].schemas today, so
-- PostgREST can't reach them, but this is cheap defense in depth in case
-- that ever changes.
CREATE OR REPLACE FUNCTION enable_rls_for_schema(p_schema TEXT) RETURNS VOID AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    EXECUTE format('SELECT tablename FROM pg_tables WHERE schemaname = %L', p_schema)
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', p_schema, r.tablename);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Apply it to every already-provisioned clinic schema right now.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT schemaname FROM pg_tables WHERE schemaname LIKE 'clinic\_%'
  LOOP
    PERFORM enable_rls_for_schema(r.schemaname);
  END LOOP;
END $$;

-- Keep every future clinic schema locked down the same way as soon as
-- it's provisioned.
CREATE OR REPLACE FUNCTION provision_clinic(
  p_name TEXT,
  p_timezone TEXT DEFAULT 'Asia/Jerusalem'
) RETURNS TEXT AS $$
DECLARE
  v_slug TEXT;
  v_clinic_id UUID;
  v_schema TEXT;
BEGIN
  v_slug := regexp_replace(
    lower(unaccent(p_name || '-' || extract(epoch from now())::TEXT)),
    '[^a-z0-9-]', '', 'g'
  );

  INSERT INTO app.clinic (name, slug, timezone)
  VALUES (p_name, v_slug, p_timezone)
  RETURNING id INTO v_clinic_id;

  v_schema := 'clinic_' || v_slug;
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
  PERFORM create_clinic_tables(v_schema);
  PERFORM enable_rls_for_schema(v_schema);

  RETURN v_schema;
END;
$$ LANGUAGE plpgsql;
