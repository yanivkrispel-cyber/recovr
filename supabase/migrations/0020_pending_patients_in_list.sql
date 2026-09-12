-- clinic_patient_summary() only ever selected p.status = 'active', so an
-- invited-but-not-yet-activated patient was invisible on both the patient
-- list and the dashboard — the clinician has no way to see who hasn't
-- signed up yet, once the invite modal's activation-link view is closed.
--
-- Now includes 'invited' patients too (via LEFT JOINs, since an invite-only
-- patient may not have a plan yet), exposing a new is_invited flag so
-- callers can render them distinctly instead of computing misleading
-- adherence/inactivity flags for someone who never had a chance to log a
-- session yet.
-- CREATE OR REPLACE cannot change a function's return type (adding
-- is_invited here); must drop first, same as 0001 did originally.
DROP FUNCTION IF EXISTS app.clinic_patient_summary(TEXT);

CREATE FUNCTION app.clinic_patient_summary(p_schema TEXT)
RETURNS TABLE (
  patient_id UUID,
  name TEXT,
  name_en TEXT,
  protocol_name TEXT,
  phase_name TEXT,
  phase_n INT,
  day INT,
  adherence INT,
  last_session_date DATE,
  is_ready BOOLEAN,
  is_low_adherence BOOLEAN,
  is_inactive BOOLEAN,
  is_invited BOOLEAN
) AS $$
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  RETURN QUERY
  SELECT
    p.id,
    p.name,
    p.name_en,
    pr.name,
    pp.name,
    pl.current_phase_n,
    CASE WHEN pl.started_at IS NULL THEN NULL ELSE (CURRENT_DATE - pl.started_at::date) + 1 END,
    CASE WHEN p.status <> 'active' THEN NULL ELSE COALESCE(recompute_adherence(p.id, CURRENT_DATE)::int, 0) END,
    (SELECT max(s.date) FROM session s WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')),
    (
      EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id)
      AND NOT EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id AND NOT pc.is_met)
    ),
    p.status = 'active' AND COALESCE(recompute_adherence(p.id, CURRENT_DATE) < 70, false),
    p.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM session s
      WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')
        AND s.date >= CURRENT_DATE - 4
    ),
    p.status = 'invited'
  FROM patient p
  LEFT JOIN plan pl ON pl.patient_id = p.id
  LEFT JOIN app.protocol pr ON pr.id = pl.protocol_id
  LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  LEFT JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE p.status IN ('active', 'invited') AND p.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DROP FUNCTION drops the old grants along with the old object — reinstate
-- the same privileges 0001 set (default would otherwise be EXECUTE to PUBLIC).
REVOKE ALL ON FUNCTION app.clinic_patient_summary(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.clinic_patient_summary(TEXT) TO authenticated, service_role;

-- list_patients: surface a 'pending' status (checked first — an invited
-- patient can't simultaneously be inactive/attention/ready) so the client
-- can render it distinctly. Filter values ('all'/'attention'/'ready'/
-- 'inactive') are unchanged — pending patients only ever show under 'all'.
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

-- dashboard_kpis: active_patients previously meant "rows clinic_patient_summary
-- returned", which was always active-only before this migration. Keep that
-- meaning explicit now that summary also includes pending invites — avg_adherence
-- already excludes them for free (adherence is NULL for pending, and avg()
-- ignores NULLs).
CREATE OR REPLACE FUNCTION app.dashboard_kpis(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'active_patients', count(*) FILTER (WHERE NOT is_invited),
    'avg_adherence', COALESCE(round(avg(summary.adherence)), 0),
    'attention_count', count(*) FILTER (WHERE is_inactive OR is_low_adherence),
    'ready_count', count(*) FILTER (WHERE is_ready),
    'completed_today', (
      SELECT count(*) FROM session s
      JOIN patient p ON p.id = s.patient_id
      WHERE p.status = 'active' AND p.deleted_at IS NULL
        AND s.date = CURRENT_DATE AND s.status = 'completed'
    )
  )
  INTO v_result
  FROM app.clinic_patient_summary(v_schema) summary;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
