-- Performance: index the foreign keys and hot lookup columns that had no
-- covering index (found by a pg_constraint/pg_index sweep, 2026-09-25).
--
-- Hot paths these serve:
--   plan_criterion(plan_phase_id)       clinic_patient_summary (dashboard + patient
--                                       list, twice per patient) and alerts_recompute
--   session_item(plan_exercise_id)      patient_today's done-state join
--   alert(patient_id)                   alerts_recompute's per-patient auto-close
--                                       UPDATEs, patient overview
--   message(patient_id, sender_type)    unread badge counts — polled every 20 s by
--     WHERE read_at IS NULL             the patient app
--   protocol_phase_exercise / _criterion(protocol_phase_id)
--                                       protocol detail + plan creation from protocol
-- The rest cover FK-side lookups on delete/merge (exercise merge, catalog delete).

-- ---------------------------------------------------------------- app schema
CREATE INDEX IF NOT EXISTS protocol_phase_exercise_phase_idx
  ON app.protocol_phase_exercise (protocol_phase_id);
CREATE INDEX IF NOT EXISTS protocol_phase_criterion_phase_idx
  ON app.protocol_phase_criterion (protocol_phase_id);
CREATE INDEX IF NOT EXISTS exercise_favorite_exercise_idx
  ON app.exercise_favorite (exercise_id);
CREATE INDEX IF NOT EXISTS exercise_override_exercise_idx
  ON app.exercise_override (exercise_id);
CREATE INDEX IF NOT EXISTS exercise_pick_event_exercise_idx
  ON app.exercise_pick_event (exercise_id);

-- ------------------------------------------------------- clinic_<slug> schemas
-- A separate idempotent step rather than another full create_clinic_tables()
-- redefinition. provision_clinic() and scripts/apply-to-all-clinics.ts call it
-- after create_clinic_tables().
CREATE OR REPLACE FUNCTION add_clinic_indexes(p_schema TEXT) RETURNS VOID AS $$
BEGIN
  EXECUTE format($f$
    CREATE INDEX IF NOT EXISTS plan_criterion_phase_idx ON %1$I.plan_criterion(plan_phase_id);
    CREATE INDEX IF NOT EXISTS session_item_plan_exercise_idx ON %1$I.session_item(plan_exercise_id);
    CREATE INDEX IF NOT EXISTS plan_exercise_exercise_idx ON %1$I.plan_exercise(exercise_id);
    CREATE INDEX IF NOT EXISTS plan_protocol_idx ON %1$I.plan(protocol_id);
    CREATE INDEX IF NOT EXISTS session_plan_version_idx ON %1$I.session(plan_version_id);
    CREATE INDEX IF NOT EXISTS alert_patient_idx ON %1$I.alert(patient_id, type) WHERE state = 'open';
    CREATE INDEX IF NOT EXISTS assessment_visit_patient_idx ON %1$I.assessment_visit(patient_id);
    CREATE INDEX IF NOT EXISTS message_unread_idx ON %1$I.message(patient_id, sender_type) WHERE read_at IS NULL;
  $f$, p_schema);
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT 'clinic_' || slug AS s FROM app.clinic LOOP
    IF to_regnamespace(r.s) IS NOT NULL THEN
      PERFORM add_clinic_indexes(r.s);
    END IF;
  END LOOP;
END $$;

-- Same body as 0047, plus add_clinic_indexes().
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
  PERFORM add_clinic_indexes(v_schema);
  PERFORM lock_down_schema(v_schema);

  RETURN v_schema;
END;
$$ LANGUAGE plpgsql;
