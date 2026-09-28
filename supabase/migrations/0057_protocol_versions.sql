-- ============================================================================
-- Protocol versions + fully materialized patient plans.
--
-- Groundwork for offering template edits to patients already on a protocol
-- (per-patient review, never automatic). Two gaps made that impossible:
--
--   1. No template history. protocol_update deletes and re-inserts every
--      phase, and plan only records protocol_id, so there was nothing to diff
--      a patient's plan against. app.protocol_version now holds immutable
--      content snapshots, and plan.base_protocol_version_id records the one a
--      plan was built from.
--
--   2. Plans only held phases already reached. write_phase_transition copied
--      the next phase from the *live* protocol on advance, so (a) a clinician
--      couldn't edit a future phase for one patient — EditPlan's save for an
--      unreached phase silently did nothing — and (b) template edits leaked
--      into existing patients unreviewed. Plans are now created with every
--      phase (unreached ones have started_at NULL); advancing just stamps
--      started_at. Existing plans are backfilled from their current protocol,
--      which is exactly what they would have been given on advance anyway.
--
-- Snapshots are taken lazily and deduplicated by content
-- (app.protocol_snapshot): on every protocol save via _protocol_insert_phases,
-- and whenever a plan is created from a protocol. Paths that write protocol
-- content without a save (duplicate, attach, seed import) are captured the
-- next time a plan is built from them or a diff needs them.
-- ============================================================================

-- --- 1. app.protocol_version ------------------------------------------------

CREATE TABLE IF NOT EXISTS app.protocol_version (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          BIGINT GENERATED ALWAYS AS IDENTITY,
  protocol_id  UUID NOT NULL REFERENCES app.protocol(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  snapshot     JSONB NOT NULL,  -- app._protocol_content() shape
  created_by   UUID REFERENCES app."user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (protocol_id, version)
);

CREATE INDEX IF NOT EXISTS protocol_version_latest_idx ON app.protocol_version (protocol_id, seq DESC);
CREATE INDEX IF NOT EXISTS protocol_version_created_by_idx ON app.protocol_version (created_by);

ALTER TABLE app.protocol_version ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.protocol_version FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.protocol_version TO service_role;

-- Canonical content of a protocol: phases by n, each with its exercises and
-- criteria in display order. Deterministic, so two calls on unchanged content
-- compare equal.
CREATE OR REPLACE FUNCTION app._protocol_content(p_protocol_id UUID)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'n', ph.n, 'name', ph.name, 'name_en', ph.name_en,
    'duration_days', ph.duration_days, 'goals', ph.goals,
    'exercises', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'exercise_id', e.exercise_id, 'prescription', e.prescription,
        'frequency', e.frequency, 'order', e."order", 'notes', e.notes
      ) ORDER BY e."order", e.exercise_id), '[]'::jsonb)
      FROM app.protocol_phase_exercise e WHERE e.protocol_phase_id = ph.id
    ),
    'criteria', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'type', c.type, 'label', c.label, 'label_en', c.label_en,
        'operator', c.operator, 'value', c.value, 'unit', c.unit, 'order', c."order"
      ) ORDER BY c."order", c.label), '[]'::jsonb)
      FROM app.protocol_phase_criterion c WHERE c.protocol_phase_id = ph.id
    )
  ) ORDER BY ph.n), '[]'::jsonb)
  FROM app.protocol_phase ph
  WHERE ph.protocol_id = p_protocol_id;
$$ LANGUAGE sql STABLE;

-- Returns the protocol_version id matching the protocol's current content,
-- inserting a snapshot if the content changed since the latest one. If the
-- protocol's version string was not bumped by whatever changed the content
-- (attach, duplicate, seed), it is bumped here so (protocol_id, version)
-- stays unique and every snapshot has a distinct label.
CREATE OR REPLACE FUNCTION app.protocol_snapshot(p_protocol_id UUID, p_created_by UUID DEFAULT NULL)
RETURNS UUID AS $$
DECLARE
  v_version TEXT;
  v_content JSONB;
  v_latest RECORD;
  v_id UUID;
BEGIN
  -- Serializes concurrent snapshotters of the same protocol.
  SELECT version INTO v_version FROM app.protocol WHERE id = p_protocol_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_content := app._protocol_content(p_protocol_id);

  SELECT id, version, snapshot INTO v_latest
  FROM app.protocol_version WHERE protocol_id = p_protocol_id
  ORDER BY seq DESC LIMIT 1;

  IF FOUND AND v_latest.snapshot = v_content THEN
    RETURN v_latest.id;
  END IF;

  IF EXISTS (SELECT 1 FROM app.protocol_version WHERE protocol_id = p_protocol_id AND version = v_version) THEN
    BEGIN
      v_version := (COALESCE(v_version, '1.0')::numeric + 0.1)::text;
    EXCEPTION WHEN OTHERS THEN
      v_version := COALESCE(v_version, '1.0') || '.1';
    END;
    WHILE EXISTS (SELECT 1 FROM app.protocol_version WHERE protocol_id = p_protocol_id AND version = v_version) LOOP
      v_version := v_version || '.1';
    END LOOP;
    UPDATE app.protocol SET version = v_version, updated_at = now() WHERE id = p_protocol_id;
  END IF;

  INSERT INTO app.protocol_version (protocol_id, version, snapshot, created_by)
  VALUES (p_protocol_id, v_version, v_content, p_created_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app._protocol_content(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._protocol_content(UUID) TO service_role;
REVOKE ALL ON FUNCTION app.protocol_snapshot(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.protocol_snapshot(UUID, UUID) TO service_role;

-- Re-declared from 0021: snapshot after every create/update write.
CREATE OR REPLACE FUNCTION app._protocol_insert_phases(p_protocol_id UUID, p_phases JSONB)
RETURNS VOID AS $$
DECLARE
  v_phase JSONB;
  v_phase_n INT := 0;
  v_phase_id UUID;
  v_ex JSONB;
  v_crit JSONB;
BEGIN
  FOR v_phase IN SELECT * FROM jsonb_array_elements(p_phases) LOOP
    v_phase_n := v_phase_n + 1;

    INSERT INTO app.protocol_phase (protocol_id, n, name, name_en, duration_days, goals, "order")
    VALUES (
      p_protocol_id, v_phase_n, btrim(v_phase->>'name'), NULLIF(btrim(v_phase->>'name_en'), ''),
      NULLIF(v_phase->>'duration_days', '')::int, COALESCE(v_phase->'goals', '[]'::jsonb), v_phase_n
    )
    RETURNING id INTO v_phase_id;

    IF v_phase->'exercises' IS NOT NULL THEN
      FOR v_ex IN SELECT * FROM jsonb_array_elements(v_phase->'exercises') LOOP
        INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, frequency, "order", notes)
        VALUES (
          v_phase_id, (v_ex->>'exercise_id')::uuid, COALESCE(v_ex->'prescription', '{}'::jsonb),
          NULLIF(btrim(v_ex->>'frequency'), ''), COALESCE((v_ex->>'order')::int, 0),
          NULLIF(btrim(v_ex->>'notes'), '')
        );
      END LOOP;
    END IF;

    IF v_phase->'criteria' IS NOT NULL THEN
      FOR v_crit IN SELECT * FROM jsonb_array_elements(v_phase->'criteria') LOOP
        INSERT INTO app.protocol_phase_criterion (protocol_phase_id, type, label, label_en, operator, value, unit, "order")
        VALUES (
          v_phase_id, v_crit->>'type', btrim(v_crit->>'label'), NULLIF(btrim(v_crit->>'label_en'), ''),
          v_crit->>'operator', (v_crit->>'value')::numeric, NULLIF(btrim(v_crit->>'unit'), ''),
          COALESCE((v_crit->>'order')::int, 0)
        );
      END LOOP;
    END IF;
  END LOOP;

  PERFORM app.protocol_snapshot(p_protocol_id);
END;
$$ LANGUAGE plpgsql;

-- --- 2. plan.base_protocol_version_id (clinic schemas) ----------------------

-- Idempotent column additions for clinic schemas, run after
-- create_clinic_tables() by provision_clinic(), seed.sql and
-- scripts/apply-to-all-clinics.ts — so create_clinic_tables() doesn't need
-- another full redefinition for each new column.
CREATE OR REPLACE FUNCTION add_clinic_columns(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format($f$
    ALTER TABLE %1$I.plan ADD COLUMN IF NOT EXISTS base_protocol_version_id UUID
      REFERENCES app.protocol_version(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS plan_base_protocol_version_idx ON %1$I.plan(base_protocol_version_id);
  $f$, p_schema);
END;
$$ LANGUAGE plpgsql;

-- Same body as 0050, plus add_clinic_columns().
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
  PERFORM add_clinic_columns(v_schema);
  PERFORM add_clinic_indexes(v_schema);
  PERFORM lock_down_schema(v_schema);

  RETURN v_schema;
END;
$$ LANGUAGE plpgsql;

-- --- 3. Materializing plan phases -------------------------------------------

-- Copies protocol phases missing from a plan version into it, unstarted
-- (started_at NULL). p_only_n limits it to one phase. The caller must already
-- have search_path set to the clinic schema.
CREATE OR REPLACE FUNCTION app._plan_materialize_phases(
  p_plan_version_id UUID,
  p_protocol_id UUID,
  p_only_n INT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_pp RECORD;
  v_phase_id UUID;
  v_count INT := 0;
BEGIN
  FOR v_pp IN
    SELECT * FROM app.protocol_phase
    WHERE protocol_id = p_protocol_id
      AND (p_only_n IS NULL OR n = p_only_n)
      AND n NOT IN (SELECT n FROM plan_phase WHERE plan_version_id = p_plan_version_id)
    ORDER BY n
  LOOP
    INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at)
    VALUES (p_plan_version_id, v_pp.n, v_pp.name, v_pp.duration_days, NULL)
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
    WHERE ppe.protocol_phase_id = v_pp.id;

    INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order")
    SELECT v_phase_id, ppc.type, ppc.label, ppc.label_en, ppc.operator, ppc.value, ppc.unit, ppc."order"
    FROM app.protocol_phase_criterion ppc
    WHERE ppc.protocol_phase_id = v_pp.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app._plan_materialize_phases(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app._plan_materialize_phases(UUID, UUID, INT) TO service_role;

-- Brings one clinic schema's plans up to the new shape: every protocol phase
-- present in the current plan version, and a base protocol version recorded.
-- Idempotent. Used by this migration and by seed.sql (its demo plans are
-- inserted directly, in the old shape).
CREATE OR REPLACE FUNCTION app.backfill_plan_versions(p_schema TEXT) RETURNS INT AS $$
DECLARE
  v_orig_path TEXT := current_setting('search_path');
  r RECORD;
  v_count INT := 0;
BEGIN
  PERFORM set_config('search_path', format('%I, app, public', p_schema), true);

  FOR r IN
    SELECT pl.id AS plan_id, pl.protocol_id, pv.id AS version_id, pl.base_protocol_version_id
    FROM plan pl
    JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current
  LOOP
    PERFORM app._plan_materialize_phases(r.version_id, r.protocol_id);
    IF r.base_protocol_version_id IS NULL THEN
      UPDATE plan SET base_protocol_version_id = app.protocol_snapshot(r.protocol_id)
      WHERE id = r.plan_id;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  PERFORM set_config('search_path', v_orig_path, true);
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION app.backfill_plan_versions(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.backfill_plan_versions(TEXT) TO service_role;

-- Re-declared from 0045: the plan gets every protocol phase up front and
-- records the protocol version it was built from.
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
  v_base_id    UUID;
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

  v_base_id := app.protocol_snapshot(p_protocol_id, p_clinician_id);

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  INSERT INTO patient (clinic_id, primary_clinician_id, name, email, status, intake_note)
  VALUES (v_clinic_id, p_clinician_id, btrim(p_name), btrim(p_email), 'invited', NULLIF(btrim(COALESCE(p_intake_note, '')), ''))
  RETURNING id INTO v_patient_id;

  INSERT INTO plan (patient_id, protocol_id, started_at, current_phase_n, status, base_protocol_version_id)
  VALUES (v_patient_id, p_protocol_id, now(), v_pp.n, 'active', v_base_id)
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

  -- Every other phase, unstarted, so it can be edited for this patient
  -- before they reach it.
  PERFORM app._plan_materialize_phases(v_version_id, p_protocol_id);

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

-- Re-declared from 0001. The target phase now normally exists already
-- (unstarted); advancing stamps its started_at. Only a phase the plan lacks
-- entirely (a legacy plan, or one the template gained later) is copied in
-- from the protocol — just that phase, never the rest of a changed template.
CREATE OR REPLACE FUNCTION app.write_phase_transition(
  p_schema TEXT,
  p_plan_id UUID,
  p_from_phase_n INT,
  p_to_phase_n INT,
  p_direction TEXT,
  p_approved_by UUID,
  p_criteria_snapshot JSONB,
  p_override_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_transition JSONB;
  v_version_id UUID;
  v_protocol_id UUID;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  INSERT INTO phase_transition (
    plan_id, from_phase_n, to_phase_n, direction, approved_by, criteria_snapshot, override_reason
  ) VALUES (
    p_plan_id, p_from_phase_n, p_to_phase_n, p_direction, p_approved_by, p_criteria_snapshot, p_override_reason
  )
  RETURNING to_jsonb(phase_transition.*) INTO v_transition;

  UPDATE plan SET current_phase_n = p_to_phase_n, updated_at = now() WHERE id = p_plan_id;

  IF p_direction = 'forward' THEN
    SELECT pv.id, pl.protocol_id INTO v_version_id, v_protocol_id
    FROM plan_version pv JOIN plan pl ON pl.id = pv.plan_id
    WHERE pv.plan_id = p_plan_id AND pv.is_current = true;

    PERFORM app._plan_materialize_phases(v_version_id, v_protocol_id, p_to_phase_n);

    UPDATE plan_phase SET started_at = now()
    WHERE plan_version_id = v_version_id AND n = p_to_phase_n AND started_at IS NULL;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_approved_by, 'phase_transition', 'plan', p_plan_id);

  RETURN v_transition;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- --- 4. Backfill ----------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT 'clinic_' || slug AS s FROM app.clinic LOOP
    IF to_regnamespace(r.s) IS NOT NULL THEN
      PERFORM add_clinic_columns(r.s);
      PERFORM app.backfill_plan_versions(r.s);
    END IF;
  END LOOP;
END $$;
