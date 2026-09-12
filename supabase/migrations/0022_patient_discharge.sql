-- Clinician-initiated patient archive/discharge.
--
-- The schema (`patient.status` incl. 'discharged', `patient.discharged_at`)
-- and the confirm-dialog copy (COPY.md `confirm.discharge`) already existed,
-- but no endpoint ever set the status — the only way a patient became
-- 'discharged' was the GDPR erasure path (app.anonymize_patient), which also
-- scrubs PII. This adds the non-destructive archive: data is untouched, the
-- patient just drops out of the active list/dashboard (clinic_patient_summary
-- already excludes non-active/invited statuses — see 0020) until reactivated.
--
-- Deliberately two verb-shaped RPCs (discharge/reactivate) rather than a
-- generic "set status" — matches the existing exercises pattern
-- (POST /exercises/:id/duplicate) instead of a half-built generic PATCH.

CREATE OR REPLACE FUNCTION app.discharge_patient(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_status TEXT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT status INTO v_status FROM patient WHERE id = p_patient_id AND deleted_at IS NULL;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_status <> 'discharged' THEN
    UPDATE patient SET status = 'discharged', discharged_at = now(), updated_at = now()
    WHERE id = p_patient_id;

    INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
    VALUES ('clinician', p_clinician_id, 'discharge', 'patient', p_patient_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'status', 'discharged');
END;
$fn$;

CREATE OR REPLACE FUNCTION app.reactivate_patient(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_status TEXT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT status INTO v_status FROM patient WHERE id = p_patient_id AND deleted_at IS NULL;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_status <> 'discharged' THEN
    RETURN jsonb_build_object('error', 'not_discharged');
  END IF;

  UPDATE patient SET status = 'active', discharged_at = NULL, updated_at = now()
  WHERE id = p_patient_id;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'reactivate', 'patient', p_patient_id);

  RETURN jsonb_build_object('ok', true, 'status', 'active');
END;
$fn$;

REVOKE ALL ON FUNCTION app.discharge_patient(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reactivate_patient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discharge_patient(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.reactivate_patient(UUID, UUID) TO authenticated, service_role;

-- list_patients: teach the existing filter param a 'discharged' value.
-- clinic_patient_summary() (0020) never surfaces discharged patients at all,
-- so 'all'/'attention'/'ready'/'inactive'/'pending' are completely unchanged
-- here — this only adds a new branch that queries `patient` directly.
CREATE OR REPLACE FUNCTION app.list_patients(
  p_clinician_id UUID,
  p_filter TEXT DEFAULT 'all',
  p_query TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF p_filter = 'discharged' THEN
    EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'nameEn', p.name_en, 'status', 'discharged',
      'injury', plan_agg.protocol_name, 'phase', NULL, 'day', NULL, 'adherence', NULL,
      'dischargedAt', p.discharged_at,
      'lastActivity', CASE
        WHEN p.discharged_at IS NULL THEN '—'
        ELSE 'שוחרר ב-' || to_char(p.discharged_at, 'DD/MM/YYYY')
      END
    ) ORDER BY p.discharged_at DESC NULLS LAST, p.name), '[]'::jsonb)
    INTO v_result
    FROM patient p
    LEFT JOIN LATERAL (
      SELECT pr.name AS protocol_name
      FROM plan pl2 JOIN app.protocol pr ON pr.id = pl2.protocol_id
      WHERE pl2.patient_id = p.id
      ORDER BY pl2.started_at DESC LIMIT 1
    ) plan_agg ON true
    WHERE p.status = 'discharged' AND p.deleted_at IS NULL
      AND (p_query IS NULL OR p_query = '' OR p.name ILIKE '%' || p_query || '%');

    RETURN v_result;
  END IF;

  SELECT COALESCE(jsonb_agg(row_json ORDER BY name), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
        'id', patient_id,
        'name', name,
        'nameEn', name_en,
        'status', status,
        'injury', protocol_name,
        'phaseName', phase_name,
        'phase', phase_n,
        'day', day,
        'adherence', adherence,
        'lastActivity', CASE
          WHEN status = 'pending' THEN 'ממתין/ת להפעלה'
          WHEN last_session_date IS NULL THEN 'אין פעילות'
          WHEN last_session_date = CURRENT_DATE THEN 'היום'
          WHEN last_session_date = CURRENT_DATE - 1 THEN 'אתמול'
          ELSE 'לפני ' || (CURRENT_DATE - last_session_date) || ' ימים'
        END
      ) AS row_json,
      name,
      status
    FROM (
      SELECT
        *,
        CASE
          WHEN is_invited THEN 'pending'
          WHEN is_inactive THEN 'inactive'
          WHEN is_low_adherence THEN 'attention'
          WHEN is_ready THEN 'ready'
          ELSE 'ontrack'
        END AS status
      FROM app.clinic_patient_summary(v_schema)
    ) s
    WHERE (p_query IS NULL OR p_query = '' OR name ILIKE '%' || p_query || '%')
  ) t
  WHERE p_filter = 'all' OR status = p_filter;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.list_patients(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_patients(UUID, TEXT, TEXT) TO authenticated, service_role;
