-- MFA policy inputs in one query, for edge functions that verify the caller's
-- JWT locally (supabase/functions/_shared/auth.ts) and therefore no longer get
-- the user's factor list from auth.getUser(). See _shared/mfa.ts for the
-- policy. Service role only (0047 default privileges).
CREATE OR REPLACE FUNCTION app.mfa_state(p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'role', (SELECT u.role FROM app."user" u WHERE u.id = p_user_id),
    'enrolled', EXISTS (
      SELECT 1 FROM auth.mfa_factors f
      WHERE f.user_id = p_user_id AND f.status = 'verified'
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION app.mfa_state(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.mfa_state(UUID) TO service_role;
