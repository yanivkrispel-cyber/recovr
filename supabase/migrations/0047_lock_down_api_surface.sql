-- Close the PostgREST RPC/table surface for client roles (anon, authenticated).
--
-- 0046 enabled RLS on app tables, but RLS does not apply to functions: ~100
-- app.* SECURITY DEFINER functions were still `GRANT EXECUTE ... TO
-- authenticated`, and many trust a caller-supplied identity
-- (p_clinician_id, p_patient_auth_id) or a raw schema name (p_schema). Since
-- `app` is PostgREST-exposed, any JWT holder could call /rest/v1/rpc/* with
-- `Content-Profile: app` and act as any clinician across any clinic — and
-- prod had public sign-up on, so a JWT was free. A patient account could
-- chain export_my_data -> plan_versions[].created_by (clinician id) ->
-- list_patients / patient_overview / anonymize_patient.
--
-- Prod also exposes `public` (dashboard setting, not what config.toml says),
-- where 0001 left unused copies of the clinic tables plus two SECURITY
-- DEFINER helpers, all reachable by `anon` with no login at all.
--
-- Neither frontend talks to PostgREST directly: every read/write goes
-- through an edge function on the service_role key. So client roles need no
-- privileges here at all; service_role keeps everything it had.

-- ---------------------------------------------------------------------------
-- 1. app schema
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA app FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA app TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO service_role;

-- Future objects. The built-in "functions are executable by PUBLIC" default
-- is global, and Postgres ignores a per-schema REVOKE of a global default,
-- so this one has to be global (it only affects functions postgres creates
-- from now on). The per-schema grants keep new app objects usable by the
-- edge functions without every migration having to remember a GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- ---------------------------------------------------------------------------
-- 2. clinic_<slug> schemas (not exposed today; defense in depth).
--    create_clinic_tables() grants client roles on every clinic schema it
--    builds, so provisioning must strip that again right after.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lock_down_schema(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  PERFORM enable_rls_for_schema(p_schema);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC, anon, authenticated', p_schema);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC, anon, authenticated', p_schema);
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC, anon, authenticated', p_schema);
  EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM PUBLIC, anon, authenticated', p_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role', p_schema);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO service_role', p_schema);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO service_role', p_schema);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'clinic\_%' LOOP
    PERFORM lock_down_schema(r.nspname);
  END LOOP;
END $$;

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
  PERFORM lock_down_schema(v_schema);

  RETURN v_schema;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. public schema: 0001's unused table copies + helper functions.
--    Tables are kept (measure_definition carries seeded reference rows);
--    they're just no longer reachable by client roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND pg_get_userbyid(c.relowner) = 'postgres'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', r.relname);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_userbyid(p.proowner) = 'postgres'
      -- leave extension-owned functions to their extension
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Self-check: fail the migration if any client role can still reach
--    anything we own in these schemas.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_leaks TEXT;
BEGIN
  SELECT string_agg(item, ', ') INTO v_leaks FROM (
    SELECT format('%s EXECUTE %s', r.rolname, p.oid::regprocedure) AS item
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE (n.nspname IN ('app', 'public') OR n.nspname LIKE 'clinic\_%')
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    UNION ALL
    SELECT format('%s TABLE %s.%s', r.rolname, n.nspname, c.relname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE (n.nspname IN ('app', 'public') OR n.nspname LIKE 'clinic\_%')
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND pg_get_userbyid(c.relowner) = 'postgres'
      AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE')
  ) leaks;

  IF v_leaks IS NOT NULL THEN
    RAISE EXCEPTION 'API lockdown incomplete: %', v_leaks;
  END IF;
END $$;
