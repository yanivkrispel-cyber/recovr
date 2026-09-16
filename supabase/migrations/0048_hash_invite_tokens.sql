-- Store patient invite tokens hashed, not in plaintext.
--
-- An invite token is a bearer credential: whoever holds it can set the
-- patient's password. Until now app.patient_auth.invite_token held the raw
-- value, so any read access to that table (a leaked backup, a future grant
-- mistake, the pre-0046 exposure) was enough to take over pending accounts.
--
-- Tokens are 256-bit random values, so an unsalted SHA-256 is sufficient
-- (no dictionary to attack). Stored values carry a 'sha256:' prefix so a
-- digest can never be mistaken for a raw 64-hex token.
--
-- Hashing happens in a trigger, so every writer (invite_patient,
-- create_patient_with_plan, create_patient_with_custom_plan, and anything
-- added later) is covered without touching them: they keep returning the
-- raw token once, for the email/link, while only the digest is stored.
-- The link is never read back from the database, so nothing else changes.

CREATE OR REPLACE FUNCTION app.hash_invite_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_token IS NULL THEN NULL
    WHEN p_token LIKE 'sha256:%' THEN p_token
    ELSE 'sha256:' || encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  END;
$$;

CREATE OR REPLACE FUNCTION app.patient_auth_hash_invite_token()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.invite_token := app.hash_invite_token(NEW.invite_token);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patient_auth_hash_invite_token ON app.patient_auth;
CREATE TRIGGER patient_auth_hash_invite_token
  BEFORE INSERT OR UPDATE OF invite_token ON app.patient_auth
  FOR EACH ROW EXECUTE FUNCTION app.patient_auth_hash_invite_token();

-- Existing pending invites: hash in place, so links already sent keep working.
UPDATE app.patient_auth
SET invite_token = invite_token
WHERE invite_token IS NOT NULL AND invite_token NOT LIKE 'sha256:%';

-- Lookups hash the presented token before comparing.
CREATE OR REPLACE FUNCTION app.resolve_invite(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_status TEXT;
  v_expires_at TIMESTAMPTZ;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  IF p_token IS NULL OR p_token LIKE 'sha256:%' THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  SELECT patient_id, status, invite_expires_at
  INTO v_patient_id, v_status, v_expires_at
  FROM app.patient_auth WHERE invite_token = app.hash_invite_token(p_token);

  IF v_patient_id IS NULL OR v_status != 'invited' THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;
  IF v_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'patient_id', p.id, 'name', p.name, 'email', p.email,
    'clinician_name', u.name
  )
  INTO v_result
  FROM patient p
  JOIN app."user" u ON u.id = p.primary_clinician_id
  WHERE p.id = v_patient_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION app.accept_patient_invite(
  p_token TEXT,
  p_new_auth_user_id UUID,
  p_consent_version TEXT
) RETURNS JSONB AS $$
DECLARE
  v_hash TEXT;
  v_patient_id UUID;
  v_status TEXT;
  v_expires_at TIMESTAMPTZ;
  v_schema TEXT;
BEGIN
  -- A caller must present the raw token, never the stored digest.
  IF p_token IS NULL OR p_token LIKE 'sha256:%' THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;
  v_hash := app.hash_invite_token(p_token);

  -- Row lock: two concurrent accepts of the same link can't both proceed.
  SELECT patient_id, status, invite_expires_at
  INTO v_patient_id, v_status, v_expires_at
  FROM app.patient_auth WHERE invite_token = v_hash
  FOR UPDATE;

  IF v_patient_id IS NULL OR v_status != 'invited' OR v_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  DELETE FROM app.patient_auth WHERE invite_token = v_hash;

  INSERT INTO app.patient_auth (id, patient_id, password_hash, status)
  VALUES (p_new_auth_user_id, v_patient_id, '', 'active');

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE patient
  SET status = 'active', activated_at = now(),
      consent_version = p_consent_version, consent_at = now()
  WHERE id = v_patient_id;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_new_auth_user_id, 'accept_invite', 'patient', v_patient_id);

  RETURN jsonb_build_object('ok', true, 'patient_id', v_patient_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Keep the 0047 posture for the new functions explicitly (default
-- privileges already do this; stated here so the intent is local).
REVOKE EXECUTE ON FUNCTION app.hash_invite_token(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.patient_auth_hash_invite_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.hash_invite_token(TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.patient_auth
    WHERE invite_token IS NOT NULL AND invite_token NOT LIKE 'sha256:%'
  ) THEN
    RAISE EXCEPTION 'plaintext invite tokens remain in app.patient_auth';
  END IF;
END $$;
