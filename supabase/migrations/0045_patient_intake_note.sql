-- ============================================================================
-- Patient intake notes + skip exercise-picking on the "Other" (no pathology)
-- Add-patient path.
--
-- Two independent changes to the wizard:
--   1. A free-text `patient.intake_note` column, always available regardless
--      of protocol/pathology, editable later from the plan editor (mirrors
--      the pathology-rename affordance added in 0016).
--   2. The "Other" path (0015) no longer requires picking exercises up
--      front — a clinician can create the patient with just a condition
--      description and add exercises later from the plan card. The hidden
--      per-patient protocol it builds may now have zero exercises.
-- ============================================================================

-- --- 1. Column: existing clinic schemas + the provisioning template --------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT 'clinic_' || slug AS schema_name FROM app.clinic LOOP
    EXECUTE format('ALTER TABLE %I.patient ADD COLUMN IF NOT EXISTS intake_note TEXT', r.schema_name);
  END LOOP;
END $$;

-- Re-declared from 0001 with `intake_note TEXT` added to the patient table
-- so newly provisioned clinics get the column too. This function is the
-- single source of truth for per-clinic table DDL (see provision_clinic()).
CREATE OR REPLACE FUNCTION create_clinic_tables(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS %1$I.patient (
      id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id               UUID NOT NULL REFERENCES app.clinic(id),
      primary_clinician_id    UUID NOT NULL REFERENCES app."user"(id),
      name                    TEXT NOT NULL,
      name_en                 TEXT,
      birth_date              DATE,
      sex                     TEXT CHECK (sex IN ('M', 'F', 'X')),
      phone                   TEXT,
      email                   TEXT,
      sport                   TEXT,
      position                TEXT,
      intake_note             TEXT,
      status                  TEXT NOT NULL DEFAULT 'invited'
                                CHECK (status IN ('invited', 'active', 'paused', 'discharged')),
      consent_version         TEXT,
      consent_at              TIMESTAMPTZ,
      locale                  TEXT NOT NULL DEFAULT 'he-IL',
      timezone                TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      activated_at            TIMESTAMPTZ,
      discharged_at           TIMESTAMPTZ,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at              TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS patient_clinic_idx ON %1$I.patient(clinic_id);
    CREATE INDEX IF NOT EXISTS patient_clinician_idx ON %1$I.patient(primary_clinician_id);
    CREATE INDEX IF NOT EXISTS patient_status_idx ON %1$I.patient(status);

    CREATE TABLE IF NOT EXISTS %1$I.plan (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id        UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      protocol_id       UUID NOT NULL REFERENCES app.protocol(id),
      started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      current_phase_n   INT NOT NULL DEFAULT 1,
      status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'abandoned')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS plan_patient_idx ON %1$I.plan(patient_id);

    CREATE TABLE IF NOT EXISTS %1$I.plan_version (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id       UUID NOT NULL REFERENCES %1$I.plan(id) ON DELETE CASCADE,
      version       INT NOT NULL,
      created_by    UUID NOT NULL REFERENCES app."user"(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      note          TEXT,
      is_current    BOOLEAN NOT NULL DEFAULT false
    );
    CREATE UNIQUE INDEX IF NOT EXISTS plan_version_current_once ON %1$I.plan_version(plan_id) WHERE is_current = true;
    CREATE INDEX IF NOT EXISTS plan_version_plan_idx ON %1$I.plan_version(plan_id);

    CREATE TABLE IF NOT EXISTS %1$I.plan_phase (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_version_id UUID NOT NULL REFERENCES %1$I.plan_version(id) ON DELETE CASCADE,
      n               INT NOT NULL,
      name            TEXT NOT NULL,
      duration_days   INT,
      started_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      UNIQUE(plan_version_id, n)
    );

    CREATE TABLE IF NOT EXISTS %1$I.plan_exercise (
      id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_phase_id             UUID NOT NULL REFERENCES %1$I.plan_phase(id) ON DELETE CASCADE,
      exercise_id               UUID NOT NULL REFERENCES app.exercise(id),
      sets                      INT,
      reps                      INT,
      load                      NUMERIC,
      load_unit                 TEXT,
      tempo                     TEXT,
      hold_sec                  INT,
      rest_sec                  INT,
      side                      TEXT CHECK (side IN ('left', 'right', 'bilateral')),
      frequency_days_per_week   INT,
      schedule                  JSONB,
      "order"                   INT NOT NULL,
      clinician_note            TEXT,
      removed_reason            TEXT,
      source                    TEXT NOT NULL DEFAULT 'protocol'
                                CHECK (source IN ('protocol', 'added', 'modified')),
      deleted_at                TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS plan_exercise_phase_idx ON %1$I.plan_exercise(plan_phase_id);

    CREATE TABLE IF NOT EXISTS %1$I.plan_criterion (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_phase_id UUID NOT NULL REFERENCES %1$I.plan_phase(id) ON DELETE CASCADE,
      type          TEXT NOT NULL CHECK (type IN ('time', 'pain', 'rom', 'strength', 'assessment', 'manual')),
      label         TEXT NOT NULL,
      label_en      TEXT,
      operator      TEXT NOT NULL CHECK (operator IN ('gte', 'lte', 'eq')),
      value         NUMERIC NOT NULL,
      unit          TEXT,
      "order"       INT NOT NULL,
      is_met        BOOLEAN NOT NULL DEFAULT false,
      met_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS %1$I.plan_template (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id   UUID NOT NULL REFERENCES app.clinic(id),
      created_by  UUID NOT NULL REFERENCES app."user"(id),
      name        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS %1$I.session (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id         UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      plan_version_id    UUID NOT NULL REFERENCES %1$I.plan_version(id),
      date               DATE NOT NULL,
      status             TEXT NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned', 'partial', 'completed', 'skipped')),
      skipped_reason     TEXT,
      completed_at       TIMESTAMPTZ,
      items_planned      INT NOT NULL DEFAULT 0,
      items_done         INT NOT NULL DEFAULT 0,
      completion_ratio   NUMERIC NOT NULL DEFAULT 0,
      max_pain           NUMERIC,
      avg_difficulty     TEXT CHECK (avg_difficulty IN ('easy', 'medium', 'hard')),
      note               TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS session_patient_date_idx ON %1$I.session(patient_id, date DESC);

    CREATE TABLE IF NOT EXISTS %1$I.session_item (
      id                UUID PRIMARY KEY,
      session_id        UUID NOT NULL REFERENCES %1$I.session(id) ON DELETE CASCADE,
      plan_exercise_id  UUID NOT NULL REFERENCES %1$I.plan_exercise(id),
      sets_done         INT,
      reps_done         INT,
      load_used         NUMERIC,
      pain_score        NUMERIC CHECK (pain_score >= 0 AND pain_score <= 10),
      difficulty        TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
      skipped           BOOLEAN NOT NULL DEFAULT false,
      skip_reason       TEXT,
      note              TEXT,
      logged_at         TIMESTAMPTZ NOT NULL,
      synced_at         TIMESTAMPTZ,
      UNIQUE(session_id, id)
    );
    CREATE INDEX IF NOT EXISTS session_item_session_idx ON %1$I.session_item(session_id);

    CREATE TABLE IF NOT EXISTS %1$I.adherence_daily (
      patient_id        UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      date              DATE NOT NULL,
      planned           BOOLEAN NOT NULL DEFAULT false,
      completed         BOOLEAN NOT NULL DEFAULT false,
      completion_ratio  NUMERIC NOT NULL DEFAULT 0,
      PRIMARY KEY (patient_id, date)
    );

    CREATE TABLE IF NOT EXISTS %1$I.measurement (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id       UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      measure_code     TEXT NOT NULL REFERENCES public.measure_definition(code),
      side             TEXT NOT NULL CHECK (side IN ('involved', 'healthy', 'bilateral')),
      value            NUMERIC NOT NULL,
      value_secondary  NUMERIC,
      pass             BOOLEAN,
      compensations    TEXT[],
      attempts         NUMERIC[],
      governing_source TEXT CHECK (governing_source IN ('best', 'avg', 'attempt_n', 'single')),
      pain             NUMERIC CHECK (pain >= 0 AND pain <= 10),
      end_feel         TEXT CHECK (end_feel IN ('soft', 'hard')),
      swelling         TEXT CHECK (swelling IN ('none', 'mild', 'moderate', 'severe')),
      note             TEXT,
      visit_id         UUID,
      measured_by      UUID NOT NULL REFERENCES app."user"(id),
      measured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_by    UUID REFERENCES %1$I.measurement(id),
      deleted_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS measurement_patient_code_idx ON %1$I.measurement(patient_id, measure_code, measured_at DESC);
    CREATE INDEX IF NOT EXISTS measurement_visit_idx ON %1$I.measurement(visit_id);

    CREATE TABLE IF NOT EXISTS %1$I.assessment_visit (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id   UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      clinician_id UUID NOT NULL REFERENCES app."user"(id),
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      saved_at     TIMESTAMPTZ,
      note         TEXT
    );

    CREATE TABLE IF NOT EXISTS %1$I.phase_transition (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id            UUID NOT NULL REFERENCES %1$I.plan(id),
      from_phase_n       INT NOT NULL,
      to_phase_n         INT NOT NULL,
      direction          TEXT NOT NULL CHECK (direction IN ('forward', 'back')),
      approved_by        UUID NOT NULL REFERENCES app."user"(id),
      approved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      criteria_snapshot  JSONB,
      override_reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS phase_transition_plan_idx ON %1$I.phase_transition(plan_id);

    CREATE TABLE IF NOT EXISTS %1$I.alert (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id  UUID NOT NULL REFERENCES %1$I.patient(id),
      clinic_id   UUID NOT NULL REFERENCES app.clinic(id),
      type        TEXT NOT NULL CHECK (type IN ('adherence_drop', 'pain_spike', 'ready_for_advance', 'inactive', 'assessment_overdue')),
      severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
      payload     JSONB NOT NULL DEFAULT '{}',
      state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'reviewed', 'auto_closed')),
      reviewed_by UUID REFERENCES app."user"(id),
      reviewed_at TIMESTAMPTZ,
      dedupe_key  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS alert_clinic_state_idx ON %1$I.alert(clinic_id, state, created_at DESC);
    CREATE INDEX IF NOT EXISTS alert_dedupe_key_idx ON %1$I.alert(dedupe_key) WHERE state = 'open';

    CREATE TABLE IF NOT EXISTS %1$I.notification (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('user', 'patient')),
      recipient_id    UUID NOT NULL,
      event_key       TEXT NOT NULL,
      channel         TEXT NOT NULL CHECK (channel IN ('push', 'email', 'in_app')),
      payload         JSONB NOT NULL DEFAULT '{}',
      scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at         TIMESTAMPTZ,
      opened_at       TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed', 'deferred')),
      dedupe_key      TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS %1$I.message (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id  UUID NOT NULL REFERENCES %1$I.patient(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK (sender_type IN ('clinician', 'patient')),
      sender_id   UUID NOT NULL,
      body        TEXT NOT NULL,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS message_patient_idx ON %1$I.message(patient_id, sent_at DESC);

    -- Custom schemas get no privileges by default; grant what the API
    -- roles need to actually read/write these tables. `anon` is deliberately
    -- excluded — clinic data is never readable before sign-in.
    GRANT USAGE ON SCHEMA %1$I TO authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %1$I TO authenticated, service_role;
  $ddl$, p_schema);
END;
$$ LANGUAGE plpgsql;

-- --- 2. create_patient_with_plan / create_patient_with_custom_plan --------

-- Adding a trailing parameter changes the function's identity (arg types),
-- so CREATE OR REPLACE would leave the old signature in place as an
-- overload — ambiguous for PostgREST's named-parameter RPC calls. Drop the
-- old signatures first.
DROP FUNCTION IF EXISTS app.create_patient_with_plan(UUID, TEXT, TEXT, UUID, INT, UUID[]);
DROP FUNCTION IF EXISTS app.create_patient_with_custom_plan(UUID, TEXT, TEXT, TEXT, UUID[]);

-- Re-declared from 0014 with an optional p_intake_note, written onto the new
-- patient row alongside the invite.
CREATE OR REPLACE FUNCTION app.create_patient_with_plan(
  p_clinician_id          UUID,
  p_name                  TEXT,
  p_email                 TEXT,
  p_protocol_id           UUID,
  p_start_phase_n         INT DEFAULT 1,
  p_excluded_exercise_ids UUID[] DEFAULT '{}',
  p_intake_note           TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id  UUID;
  v_schema     TEXT;
  v_patient_id UUID;
  v_plan_id    UUID;
  v_version_id UUID;
  v_phase_id   UUID;
  v_pp         RECORD;
  v_token      TEXT;
  v_excluded   UUID[] := COALESCE(p_excluded_exercise_ids, '{}'::uuid[]);
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema
  FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Protocol must belong to this clinic (or be a system protocol).
  IF NOT EXISTS (
    SELECT 1 FROM app.protocol
    WHERE id = p_protocol_id AND is_active
      AND (clinic_id = v_clinic_id OR clinic_id IS NULL)
  ) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_pp
  FROM app.protocol_phase
  WHERE protocol_id = p_protocol_id AND n = COALESCE(p_start_phase_n, 1);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'phase_not_found');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  INSERT INTO patient (clinic_id, primary_clinician_id, name, email, status, intake_note)
  VALUES (v_clinic_id, p_clinician_id, btrim(p_name), btrim(p_email), 'invited', NULLIF(btrim(COALESCE(p_intake_note, '')), ''))
  RETURNING id INTO v_patient_id;

  INSERT INTO plan (patient_id, protocol_id, started_at, current_phase_n, status)
  VALUES (v_patient_id, p_protocol_id, now(), v_pp.n, 'active')
  RETURNING id INTO v_plan_id;

  INSERT INTO plan_version (plan_id, version, created_by, is_current, note)
  VALUES (v_plan_id, 1, p_clinician_id, true, 'Initial plan')
  RETURNING id INTO v_version_id;

  INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at)
  VALUES (v_version_id, v_pp.n, v_pp.name, v_pp.duration_days, now())
  RETURNING id INTO v_phase_id;

  INSERT INTO plan_exercise (
    plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec, side, "order", source
  )
  SELECT
    v_phase_id, ppe.exercise_id,
    (ppe.prescription->>'sets')::int, (ppe.prescription->>'reps')::int,
    (ppe.prescription->>'load')::numeric, ppe.prescription->>'load_unit',
    ppe.prescription->>'tempo', (ppe.prescription->>'hold_sec')::int, (ppe.prescription->>'rest_sec')::int,
    ppe.prescription->>'side', ppe."order", 'protocol'
  FROM app.protocol_phase_exercise ppe
  WHERE ppe.protocol_phase_id = v_pp.id
    AND ppe.exercise_id <> ALL (v_excluded);

  INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order")
  SELECT v_phase_id, ppc.type, ppc.label, ppc.label_en, ppc.operator, ppc.value, ppc.unit, ppc."order"
  FROM app.protocol_phase_criterion ppc
  WHERE ppc.protocol_phase_id = v_pp.id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO app.patient_auth (patient_id, invite_token, invite_expires_at, password_hash, status)
  VALUES (v_patient_id, v_token, now() + INTERVAL '7 days', '', 'invited');

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'invite', 'patient', v_patient_id);

  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'plan_id', v_plan_id,
    'invite_token', v_token,
    'exercises', (SELECT count(*) FROM plan_exercise WHERE plan_phase_id = v_phase_id)
  );
END;
$fn$;

-- Re-declared from 0015: p_exercise_ids may now be empty — the clinician can
-- create the patient with just a condition description and add exercises
-- later from the plan card — and p_intake_note is forwarded to
-- create_patient_with_plan.
CREATE OR REPLACE FUNCTION app.create_patient_with_custom_plan(
  p_clinician_id  UUID,
  p_name          TEXT,
  p_email         TEXT,
  p_condition     TEXT,
  p_exercise_ids  UUID[],
  p_intake_note   TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_clinic_id   UUID;
  v_protocol_id UUID;
  v_phase_id    UUID;
  v_ids         UUID[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_exercise_ids, '{}'::uuid[])));
  v_valid_count INT;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = ''
     OR p_email IS NULL OR btrim(p_email) = ''
     OR p_condition IS NULL OR btrim(p_condition) = '' THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT clinic_id INTO v_clinic_id FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- Every picked exercise (if any) must be active and visible to this clinic.
  IF cardinality(v_ids) > 0 THEN
    SELECT count(*) INTO v_valid_count
    FROM app.exercise
    WHERE id = ANY (v_ids)
      AND is_active
      AND (clinic_id IS NULL OR clinic_id = v_clinic_id);
    IF v_valid_count <> cardinality(v_ids) THEN
      RETURN jsonb_build_object('error', 'not_found');
    END IF;
  END IF;

  INSERT INTO app.protocol (clinic_id, slug, name, name_en, source, is_active, is_template)
  VALUES (
    v_clinic_id,
    'custom-' || replace(gen_random_uuid()::text, '-', ''),
    btrim(p_condition),
    NULL, 'clinic', true, false
  )
  RETURNING id INTO v_protocol_id;

  INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, "order")
  VALUES (v_protocol_id, 1, 'התאמה אישית', 'Custom', NULL, 1)
  RETURNING id INTO v_phase_id;

  INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, "order")
  SELECT v_phase_id, x.exercise_id,
         jsonb_build_object('sets', 3, 'reps', 10, 'rest_sec', 60),
         x.ord
  FROM unnest(v_ids) WITH ORDINALITY AS x(exercise_id, ord);

  RETURN app.create_patient_with_plan(
    p_clinician_id, p_name, p_email, v_protocol_id, 1, '{}'::uuid[], p_intake_note
  );
END;
$fn$;

REVOKE ALL ON FUNCTION app.create_patient_with_plan(UUID, TEXT, TEXT, UUID, INT, UUID[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_patient_with_custom_plan(UUID, TEXT, TEXT, TEXT, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_patient_with_plan(UUID, TEXT, TEXT, UUID, INT, UUID[], TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.create_patient_with_custom_plan(UUID, TEXT, TEXT, TEXT, UUID[], TEXT) TO authenticated, service_role;

-- --- 3. get_plan exposes intake_note; new update_patient_note RPC ---------

-- Re-declared from 0016 with `intake_note` added to the payload.
CREATE OR REPLACE FUNCTION app.get_plan(p_clinician_id UUID, p_patient_id UUID, p_version INT DEFAULT NULL)
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
    'plan_id', pl.id, 'version', pv.version, 'is_current', pv.is_current,
    'created_at', pv.created_at, 'note', pv.note, 'current_phase_n', pl.current_phase_n,
    'intake_note', pt.intake_note,
    'pathology', jsonb_build_object(
      'protocol_id', pr.id,
      'name', pr.name,
      'is_custom', (pr.is_template = false AND pr.clinic_id IS NOT NULL)
    ),
    'phases', COALESCE(phase_agg.items, '[]'::jsonb),
    -- Every phase the protocol defines, for the timeline — plan_phase only
    -- has rows for phases actually reached so far.
    'protocol_phases', COALESCE(protocol_phase_agg.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN patient pt ON pt.id = pl.patient_id
  JOIN plan_version pv ON pv.plan_id = pl.id
    AND ((p_version IS NULL AND pv.is_current = true) OR pv.version = p_version)
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', pp.id, 'n', pp.n, 'name', pp.name, 'duration_days', pp.duration_days,
      'started_at', pp.started_at, 'completed_at', pp.completed_at,
      'exercises', COALESCE(ex_agg.items, '[]'::jsonb),
      'criteria', COALESCE(crit_agg.items, '[]'::jsonb)
    ) ORDER BY pp.n) AS items
    FROM plan_phase pp
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', pe.id, 'exercise_id', pe.exercise_id, 'name', ex.name, 'name_en', ex.name_en,
        'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit, 'tempo', pe.tempo,
        'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
        'frequency_days_per_week', pe.frequency_days_per_week, 'schedule', pe.schedule,
        'order', pe."order", 'clinician_note', pe.clinician_note, 'source', pe.source,
        'removed_reason', pe.removed_reason, 'deleted_at', pe.deleted_at
      ) ORDER BY pe."order") AS items
      FROM plan_exercise pe JOIN app.exercise ex ON ex.id = pe.exercise_id
      WHERE pe.plan_phase_id = pp.id
    ) ex_agg ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', pc.id, 'type', pc.type, 'label', pc.label, 'label_en', pc.label_en,
        'operator', pc.operator, 'value', pc.value, 'unit', pc.unit,
        'is_met', pc.is_met, 'met_at', pc.met_at
      ) ORDER BY pc."order") AS items
      FROM plan_criterion pc
      WHERE pc.plan_phase_id = pp.id
    ) crit_agg ON true
    WHERE pp.plan_version_id = pv.id
  ) phase_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'n', prpp.n, 'name', prpp.name, 'duration_days', prpp.duration_days, 'goals', prpp.goals
    ) ORDER BY prpp.n) AS items
    FROM app.protocol_phase prpp WHERE prpp.protocol_id = pl.protocol_id
  ) protocol_phase_agg ON true
  WHERE pl.patient_id = p_patient_id;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update a patient's free-text intake note. Unlike rename_patient_pathology
-- this isn't restricted to custom protocols — every patient has one.
CREATE OR REPLACE FUNCTION app.update_patient_note(
  p_clinician_id UUID,
  p_patient_id   UUID,
  p_note         TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_schema TEXT;
  v_note   TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_rows   INT;
BEGIN
  IF v_note IS NOT NULL AND char_length(v_note) > 4000 THEN
    RETURN jsonb_build_object('error', 'validation_failed');
  END IF;

  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE patient SET intake_note = v_note, updated_at = now()
  WHERE id = p_patient_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('patient_id', p_patient_id, 'intake_note', v_note);
END;
$fn$;

REVOKE ALL ON FUNCTION app.update_patient_note(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_patient_note(UUID, UUID, TEXT) TO authenticated, service_role;
