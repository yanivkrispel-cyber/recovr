-- 0012_privacy.sql — T-23 Privacy & compliance (RULES §7).
--
-- Already in place (verified, not changed here):
--   * Encryption at rest / TLS — platform guarantees (Supabase Postgres disk
--     encryption + enforced HTTPS). Documented in README "Security & compliance".
--   * Consent — app.accept_patient_invite records patient.consent_version +
--     consent_at at activation.
--   * Disclaimer — shown at onboarding (InviteAccept) and on the printed home
--     program (HomeProgramPrint).
--
-- Added here:
--   * app.export_my_data — a patient's full data as one JSON bundle.
--   * app.request_data_deletion + app.data_deletion_request — a delete-my-data
--     *request*; erasure is clinician-actioned because clinical records carry
--     a retention obligation.
--   * app.anonymize_patient — the erasure itself: pseudonymise PII, scrub free
--     text, disable login. Clinical rows stay (de-identified) until retention.
--   * app.retention_purge — nightly; drops data past the clinic's retention
--     window (settings.retention_years / clinic.retention_years, default 7).
--   * app.audit_read re-exposed in the `app` schema so per-record reads can be
--     logged from the API layer (the `public` copy isn't PostgREST-exposed).

-- ---------------------------------------------------------------------------
-- audit_read in the app schema (same body as public.audit_read from 0001)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.audit_read(
  p_actor_type TEXT, p_actor_id UUID, p_entity_type TEXT, p_entity_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id, ip, user_agent)
  VALUES (
    p_actor_type, p_actor_id, 'read', p_entity_type, p_entity_id,
    NULLIF(current_setting('request.headers', true), '')::JSONB ->> 'x-forwarded-for',
    NULLIF(current_setting('request.headers', true), '')::JSONB ->> 'user-agent'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- delete-my-data request
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.data_deletion_request (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID NOT NULL,
  clinic_id    UUID NOT NULL REFERENCES app.clinic(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'cancelled')),
  processed_at TIMESTAMPTZ,
  processed_by UUID REFERENCES app."user"(id)
);
CREATE INDEX IF NOT EXISTS data_deletion_request_clinic_idx ON app.data_deletion_request (clinic_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS data_deletion_request_one_open ON app.data_deletion_request (patient_id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- patient self-service: export
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.export_my_data(p_patient_auth_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema     TEXT;
  v_out        JSONB;
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

  SELECT jsonb_build_object(
    'exported_at', now(),
    'patient', (SELECT to_jsonb(p) - 'clinic_id' - 'primary_clinician_id' FROM patient p WHERE p.id = v_patient_id),
    'plan', (SELECT jsonb_agg(to_jsonb(pl)) FROM plan pl WHERE pl.patient_id = v_patient_id),
    'plan_versions', (SELECT jsonb_agg(to_jsonb(pv)) FROM plan_version pv JOIN plan pl ON pl.id = pv.plan_id WHERE pl.patient_id = v_patient_id),
    'sessions', (SELECT jsonb_agg(to_jsonb(s)) FROM session s WHERE s.patient_id = v_patient_id),
    'session_items', (SELECT jsonb_agg(to_jsonb(si)) FROM session_item si JOIN session s ON s.id = si.session_id WHERE s.patient_id = v_patient_id),
    'measurements', (SELECT jsonb_agg(to_jsonb(m)) FROM measurement m WHERE m.patient_id = v_patient_id),
    'assessment_visits', (SELECT jsonb_agg(to_jsonb(av)) FROM assessment_visit av WHERE av.patient_id = v_patient_id),
    'adherence_daily', (SELECT jsonb_agg(to_jsonb(ad)) FROM adherence_daily ad WHERE ad.patient_id = v_patient_id),
    'phase_transitions', (SELECT jsonb_agg(to_jsonb(pt)) FROM phase_transition pt JOIN plan pl ON pl.id = pt.plan_id WHERE pl.patient_id = v_patient_id),
    'alerts', (SELECT jsonb_agg(to_jsonb(a)) FROM alert a WHERE a.patient_id = v_patient_id),
    'messages', (SELECT jsonb_agg(to_jsonb(msg)) FROM message msg WHERE msg.patient_id = v_patient_id),
    'notifications', (SELECT jsonb_agg(to_jsonb(n)) FROM notification n WHERE n.recipient_type = 'patient' AND n.recipient_id = v_patient_id)
  ) INTO v_out;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'export', 'patient', v_patient_id);

  RETURN v_out;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- patient self-service: request deletion
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.request_data_deletion(p_patient_auth_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_patient_id UUID;
  v_schema     TEXT;
  v_clinic     UUID;
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

  SELECT clinic_id INTO v_clinic FROM patient WHERE id = v_patient_id;

  INSERT INTO app.data_deletion_request (patient_id, clinic_id, reason)
  VALUES (v_patient_id, v_clinic, NULLIF(btrim(COALESCE(p_reason, '')), ''))
  ON CONFLICT (patient_id) WHERE (status = 'pending') DO NOTHING;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'delete_request', 'patient', v_patient_id);

  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END;
$fn$;

-- ---------------------------------------------------------------------------
-- clinician: see pending requests, and action the erasure
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.list_deletion_requests(p_clinician_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic UUID;
  v_schema TEXT;
  v_out    JSONB;
BEGIN
  SELECT clinic_id, schema_name INTO v_clinic, v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'patient_id', r.patient_id, 'patient_name', p.name,
    'requested_at', r.requested_at, 'reason', r.reason
  ) ORDER BY r.requested_at), '[]'::jsonb)
  INTO v_out
  FROM app.data_deletion_request r
  JOIN patient p ON p.id = r.patient_id
  WHERE r.clinic_id = v_clinic AND r.status = 'pending';

  RETURN v_out;
END;
$fn$;

CREATE OR REPLACE FUNCTION app.anonymize_patient(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_label  TEXT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_label := 'מטופל ' || left(replace(p_patient_id::text, '-', ''), 6);

  UPDATE patient SET
    name = v_label, name_en = NULL, birth_date = NULL, sex = NULL,
    phone = NULL, email = NULL, sport = NULL, "position" = NULL,
    status = 'discharged',
    discharged_at = COALESCE(discharged_at, now()),
    deleted_at = now(),
    updated_at = now()
  WHERE id = p_patient_id;

  -- free text that can carry identifying detail
  UPDATE message SET body = '[הוסר]' WHERE patient_id = p_patient_id;
  UPDATE session SET note = NULL WHERE patient_id = p_patient_id;
  UPDATE session_item SET note = NULL
    WHERE session_id IN (SELECT id FROM session WHERE patient_id = p_patient_id);
  UPDATE measurement SET note = NULL WHERE patient_id = p_patient_id;

  -- kill the login path
  DELETE FROM app.patient_auth WHERE patient_id = p_patient_id;
  DELETE FROM app.device_token WHERE owner_type = 'patient' AND owner_id = p_patient_id;

  UPDATE app.data_deletion_request
  SET status = 'processed', processed_at = now(), processed_by = p_clinician_id
  WHERE patient_id = p_patient_id AND status = 'pending';

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'anonymize', 'patient', p_patient_id);

  RETURN jsonb_build_object('ok', true);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- retention purge — nightly
-- ---------------------------------------------------------------------------

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
BEGIN
  FOR v_slug IN SELECT slug FROM app.clinic LOOP
    v_schema := 'clinic_' || v_slug;
    SELECT COALESCE((settings ->> 'retention_years')::int, retention_years, 7)
    INTO v_years FROM app.clinic WHERE slug = v_slug;
    v_cut := now() - make_interval(years => GREATEST(v_years, 1));

    -- audit rows about this clinic's patients, past retention
    EXECUTE format(
      'DELETE FROM app.audit_log a WHERE a.at < %1$L AND a.entity_type = ''patient''
         AND a.entity_id IN (SELECT id FROM %2$I.patient)',
      v_cut, v_schema);
    GET DIAGNOSTICS n = ROW_COUNT; v_audit := v_audit + n;

    -- operational notifications older than a year (not clinical records)
    EXECUTE format('DELETE FROM %I.notification WHERE scheduled_for < now() - interval ''1 year''', v_schema);
    GET DIAGNOSTICS n = ROW_COUNT; v_notif := v_notif + n;

    -- anonymized/discharged patients whose deleted_at is past retention:
    -- clear the FK children that don't cascade, then the patient (the rest
    -- cascades from patient / plan).
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

  RETURN jsonb_build_object('audit_log', v_audit, 'notifications', v_notif, 'patients', v_patients);
END;
$fn$;

DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retention-purge') THEN
    PERFORM cron.unschedule('retention-purge');
  END IF;
  PERFORM cron.schedule('retention-purge', '30 3 * * *', $job$SELECT app.retention_purge()$job$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable (%); run app.retention_purge() daily by other means', SQLERRM;
END
$cron$;

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.export_my_data(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.request_data_deletion(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_deletion_requests(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.anonymize_patient(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retention_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_read(TEXT, UUID, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.audit_read(TEXT, UUID, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.export_my_data(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.request_data_deletion(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.list_deletion_requests(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.anonymize_patient(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.retention_purge() TO service_role;
