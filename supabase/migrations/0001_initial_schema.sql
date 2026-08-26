-- RecoveryOS Database Schema
-- Schema: app.clinic_template
-- One schema per clinic. Never hand-edit a clinic schema directly.
-- Use scripts/apply-to-all-clinics.ts to propagate migrations.

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- SHARED SCHEMA (app) — cross-clinic data
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app;

-- Clinics
CREATE TABLE app.clinic (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  locale        TEXT NOT NULL DEFAULT 'he-IL',
  retention_years INT NOT NULL DEFAULT 7,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clinic template (canonical DDL source)
CREATE TABLE app.clinic_template (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  schema_ddl TEXT NOT NULL,
  version   INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users (clinicians, admins)
CREATE TABLE app.user (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID NOT NULL REFERENCES app.clinic(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('clinician', 'admin')),
  name             TEXT NOT NULL,
  email            TEXT UNIQUE NOT NULL,
  phone            TEXT,
  password_hash    TEXT NOT NULL,
  mfa_secret       TEXT,
  last_login_at    TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_user_clinic_idx ON app.user(clinic_id);

-- Patient auth (separate from clinical record per DATA_MODEL.md)
CREATE TABLE app.patient_auth (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID NOT NULL,  -- references clinic schema patient
  invite_token      TEXT UNIQUE,
  invite_expires_at TIMESTAMPTZ,
  password_hash     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device tokens for Web Push
CREATE TABLE app.device_token (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('user', 'patient')),
  owner_id    UUID NOT NULL,
  endpoint    TEXT NOT NULL,
  keys        JSONB NOT NULL DEFAULT '{}',
  platform    TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_device_token_owner_idx ON app.device_token(owner_type, owner_id);

-- System exercise library (null clinic_id = system)
CREATE TABLE app.exercise (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           UUID REFERENCES app.clinic(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  name_en             TEXT,
  category            TEXT NOT NULL CHECK (category IN ('Mobility', 'Strength', 'Balance', 'Control', 'Cardio')),
  region              TEXT,
  muscles             TEXT[],
  equipment           TEXT[],
  description        TEXT,
  instructions        TEXT,
  common_mistakes    TEXT,
  safety_notes       TEXT,
  default_prescription JSONB,
  is_bilateral        BOOLEAN NOT NULL DEFAULT false,
  source              TEXT NOT NULL DEFAULT 'system',
  external_ref        TEXT,  -- key from exercises-dataset-main
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_exercise_clinic_idx ON app.exercise(clinic_id);
CREATE INDEX app_exercise_external_ref_idx ON app.exercise(external_ref) WHERE external_ref IS NOT NULL;

-- Exercise media
CREATE TABLE app.exercise_media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id   UUID NOT NULL REFERENCES app.exercise(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image', 'gif', 'video')),
  url           TEXT NOT NULL,
  thumb_url     TEXT,
  width         INT,
  height        INT,
  duration_ms   INT,
  "order"       INT NOT NULL DEFAULT 0,
  source_file   TEXT,
  verified_by   UUID REFERENCES app.user(id),
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System protocol library (null clinic_id = system)
CREATE TABLE app.protocol (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID REFERENCES app.clinic(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_en      TEXT,
  region       TEXT,
  region_en    TEXT,
  source       TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('system', 'clinic')),
  version      TEXT NOT NULL DEFAULT '1.0',
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(clinic_id, slug)
);

CREATE INDEX app_protocol_clinic_idx ON app.protocol(clinic_id);

CREATE TABLE app.protocol_phase (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id     UUID NOT NULL REFERENCES app.protocol(id) ON DELETE CASCADE,
  n               INT NOT NULL,
  name            TEXT NOT NULL,
  name_en         TEXT,
  duration_days   INT,
  goals           JSONB NOT NULL DEFAULT '[]', -- [{he, en}]
  "order"         INT NOT NULL,
  UNIQUE(protocol_id, n)
);

CREATE TABLE app.protocol_phase_exercise (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_phase_id UUID NOT NULL REFERENCES app.protocol_phase(id) ON DELETE CASCADE,
  exercise_id      UUID NOT NULL REFERENCES app.exercise(id),
  prescription     JSONB NOT NULL DEFAULT '{}', -- {sets, reps, load, tempo, hold_sec, side}
  frequency        TEXT,
  "order"          INT NOT NULL,
  notes            TEXT
);

CREATE TABLE app.protocol_phase_criterion (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_phase_id UUID NOT NULL REFERENCES app.protocol_phase(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('time', 'pain', 'rom', 'strength', 'assessment', 'manual')),
  label            TEXT NOT NULL,
  label_en         TEXT,
  operator         TEXT NOT NULL CHECK (operator IN ('gte', 'lte', 'eq')),
  value            NUMERIC NOT NULL,
  unit             TEXT,
  "order"          INT NOT NULL
);

-- Audit log (cross-clinic)
CREATE TABLE app.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('clinician', 'patient', 'admin', 'system')),
  actor_id    UUID,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_audit_log_entity_idx ON app.audit_log(entity_type, entity_id);
CREATE INDEX app_audit_log_actor_idx ON app.audit_log(actor_type, actor_id);

-- ============================================================
-- CLINIC SCHEMA TEMPLATE (clinic_<slug>)
-- Applied to each clinic via scripts/apply-to-all-clinics.ts
-- ============================================================

-- Note: clinic schema tables carry clinic_id for RLS, but the API
-- layer always sets search_path to the clinic schema, so clinic_id
-- is a sanity check rather than the primary isolation mechanism.

CREATE TABLE patient (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               UUID NOT NULL REFERENCES app.clinic(id),
  primary_clinician_id    UUID NOT NULL REFERENCES app.user(id),
  name                    TEXT NOT NULL,
  name_en                 TEXT,
  birth_date              DATE,
  sex                     TEXT CHECK (sex IN ('M', 'F', 'X')),
  phone                   TEXT,
  email                   TEXT,
  sport                   TEXT,
  position                TEXT,
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
  deleted_at              TIMESTAMPTZ  -- soft delete
);

CREATE INDEX patient_clinic_idx ON patient(clinic_id);
CREATE INDEX patient_clinician_idx ON patient(primary_clinician_id);
CREATE INDEX patient_status_idx ON patient(status);

CREATE TABLE plan (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  protocol_id       UUID NOT NULL REFERENCES app.protocol(id),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_phase_n   INT NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'abandoned')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plan_patient_idx ON plan(patient_id);

CREATE TABLE plan_version (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  version       INT NOT NULL,
  created_by    UUID NOT NULL REFERENCES app.user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  is_current    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(plan_id, is_current) WHERE is_current = true
);

CREATE INDEX plan_version_plan_idx ON plan_version(plan_id);

CREATE TABLE plan_phase (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id UUID NOT NULL REFERENCES plan_version(id) ON DELETE CASCADE,
  n               INT NOT NULL,
  name            TEXT NOT NULL,
  duration_days   INT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  UNIQUE(plan_version_id, n)
);

CREATE TABLE plan_exercise (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_phase_id             UUID NOT NULL REFERENCES plan_phase(id) ON DELETE CASCADE,
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
  "order"                   INT NOT NULL,
  clinician_note            TEXT,
  removed_reason            TEXT,
  source                    TEXT NOT NULL DEFAULT 'protocol'
                            CHECK (source IN ('protocol', 'added', 'modified')),
  deleted_at                TIMESTAMPTZ  -- soft delete
);

CREATE INDEX plan_exercise_phase_idx ON plan_exercise(plan_phase_id);

CREATE TABLE plan_criterion (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_phase_id UUID NOT NULL REFERENCES plan_phase(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('time', 'pain', 'rom', 'strength', 'assessment', 'manual')),
  label       TEXT NOT NULL,
  label_en    TEXT,
  operator    TEXT NOT NULL CHECK (operator IN ('gte', 'lte', 'eq')),
  value       NUMERIC NOT NULL,
  unit        TEXT,
  "order"     INT NOT NULL,
  is_met      BOOLEAN NOT NULL DEFAULT false,
  met_at      TIMESTAMPTZ
);

CREATE TABLE plan_template (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES app.clinic(id),
  created_by  UUID NOT NULL REFERENCES app.user(id),
  name        TEXT NOT NULL,
  payload     JSONB NOT NULL,  -- a phase's exercise set
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Activity & measurement

CREATE TABLE session (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  plan_version_id    UUID NOT NULL REFERENCES plan_version(id),
  date               DATE NOT NULL,  -- patient-local
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

CREATE INDEX session_patient_date_idx ON session(patient_id, date DESC);

CREATE TABLE session_item (
  id                UUID PRIMARY KEY,  -- client-generated UUIDv7, no default
  session_id        UUID NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  plan_exercise_id   UUID NOT NULL REFERENCES plan_exercise(id),
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
  UNIQUE(session_id, id)  -- server dedupes on client-generated id
);

CREATE INDEX session_item_session_idx ON session_item(session_id);

-- adherence_daily is materialized by recompute_adherence() trigger/function
CREATE TABLE adherence_daily (
  patient_id        UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  planned          BOOLEAN NOT NULL DEFAULT false,
  completed        BOOLEAN NOT NULL DEFAULT false,
  completion_ratio NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (patient_id, date)
);

-- ROM & functional measurements
CREATE TABLE measure_definition (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID REFERENCES app.clinic(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,  -- 'ank_wblt', 'knee_h2b', etc.
  joint        TEXT NOT NULL,
  name_he      TEXT NOT NULL,
  name_en      TEXT,
  unit         TEXT NOT NULL,  -- 'deg' | 'cm' | 'pass_fail'
  norm         NUMERIC,
  target       NUMERIC,
  scale        INT,
  flags        JSONB NOT NULL DEFAULT '{}',  -- deficit, lower, fx, bilat, side_diff, risk_below, deg_opt
  norm_source  TEXT,
  protocol_tip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(clinic_id, code)
);

CREATE TABLE measurement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  measure_code    TEXT NOT NULL REFERENCES measure_definition(code),
  side            TEXT NOT NULL CHECK (side IN ('involved', 'healthy', 'bilateral')),
  value           NUMERIC NOT NULL,
  value_secondary NUMERIC,  -- WBLT tibial angle (degOpt)
  pass            BOOLEAN,
  compensations   TEXT[],
  attempts        NUMERIC[],
  governing_source TEXT CHECK (governing_source IN ('best', 'avg', 'attempt_n', 'single')),
  pain            NUMERIC CHECK (pain >= 0 AND pain <= 10),
  end_feel        TEXT CHECK (end_feel IN ('soft', 'hard')),
  swelling        TEXT CHECK (swelling IN ('none', 'mild', 'moderate', 'severe')),
  note            TEXT,
  visit_id        UUID,
  measured_by     UUID NOT NULL REFERENCES app.user(id),
  measured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by   UUID REFERENCES measurement(id),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX measurement_patient_code_idx ON measurement(patient_id, measure_code, measured_at DESC);
CREATE INDEX measurement_visit_idx ON measurement(visit_id);

CREATE TABLE assessment_visit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  clinician_id UUID NOT NULL REFERENCES app.user(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_at     TIMESTAMPTZ,
  note         TEXT
);

-- Phase transitions (immutable audit record)
CREATE TABLE phase_transition (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            UUID NOT NULL REFERENCES plan(id),
  from_phase_n       INT NOT NULL,
  to_phase_n         INT NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('forward', 'back')),
  approved_by        UUID NOT NULL REFERENCES app.user(id),
  approved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  criteria_snapshot  JSONB,
  override_reason    TEXT
);

CREATE INDEX phase_transition_plan_idx ON phase_transition(plan_id);

-- Alerts
CREATE TABLE alert (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES patient(id),
  clinic_id   UUID NOT NULL REFERENCES app.clinic(id),
  type        TEXT NOT NULL CHECK (type IN ('adherence_drop', 'pain_spike', 'ready_for_advance', 'inactive', 'assessment_overdue')),
  severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  payload     JSONB NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'reviewed', 'auto_closed')),
  reviewed_by UUID REFERENCES app.user(id),
  reviewed_at TIMESTAMPTZ,
  dedupe_key  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX alert_clinic_state_idx ON alert(clinic_id, state, created_at DESC);
CREATE INDEX alert_dedupe_key_idx ON alert(dedupe_key) WHERE state = 'open';

-- Notifications
CREATE TABLE notification (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('user', 'patient')),
  recipient_id   UUID NOT NULL,
  event_key      TEXT NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('push', 'email', 'in_app')),
  payload        JSONB NOT NULL DEFAULT '{}',
  scheduled_for  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  opened_at      TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'deferred')),
  dedupe_key     TEXT UNIQUE
);

-- Messages
CREATE TABLE message (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('clinician', 'patient')),
  sender_id   UUID NOT NULL,
  body        TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX message_patient_idx ON message(patient_id, sent_at DESC);

-- ============================================================
-- KEY FUNCTIONS
-- ============================================================

-- recompute_adherence(patient_id, date)
-- Called by trigger on session write AND nightly pg_cron at 02:00 patient-local.
-- Per RULES §1: training days completed ÷ training days planned, rolling 7-day window.
CREATE OR REPLACE FUNCTION recompute_adherence(
  p_patient_id UUID,
  p_date DATE
) RETURNS NUMERIC AS $$
DECLARE
  v_planned INT;
  v_completed INT;
  v_adherence NUMERIC;
BEGIN
  WITH week AS (
    SELECT generate_series(
      p_date - INTERVAL '6 days',
      p_date,
      '1 day'::INTERVAL
    )::DATE AS d
  ),
  sessions AS (
    SELECT s.date, s.status, ae.planned, ae.completed, ae.completion_ratio
    FROM week w
    LEFT JOIN adherence_daily ae ON ae.patient_id = p_patient_id AND ae.date = w.d
    LEFT JOIN session s ON s.patient_id = p_patient_id AND s.date = w.d
  )
  SELECT
    COUNT(*) FILTER (WHERE planned = true) INTO v_planned
  FROM sessions;

  IF v_planned = 0 THEN
    RETURN NULL;  -- no divide-by-zero; display "--"
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE completed = true) INTO v_completed
  FROM sessions;

  v_adherence := (v_completed::NUMERIC / v_planned::NUMERIC) * 100;
  RETURN ROUND(v_adherence);  -- half-up per RULES §1
END;
$$ LANGUAGE plpgsql;

-- audit_read(actor_type, actor_id, entity_type, entity_id)
-- Writes one audit_log row per clinician read of a patient record. RULES §7.
CREATE OR REPLACE FUNCTION audit_read(
  p_actor_type TEXT,
  p_actor_id   UUID,
  p_entity_type TEXT,
  p_entity_id  UUID
) RETURNS VOID AS $$
BEGIN
  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id, ip, user_agent)
  VALUES (
    p_actor_type,
    p_actor_id,
    'read',
    p_entity_type,
    p_entity_id,
    NULLIF(current_setting('request.headers', true), '')::JSONB->>'x-forwarded-for',
    NULLIF(current_setting('request.headers', true), '')::JSONB->>'user-agent'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- provision_clinic(name, timezone)
-- Clones the template schema for a new clinic. Idempotent.
CREATE OR REPLACE FUNCTION provision_clinic(
  p_name TEXT,
  p_timezone TEXT DEFAULT 'Asia/Jerusalem'
) RETURNS TEXT AS $$
DECLARE
  v_slug TEXT;
  v_clinic_id UUID;
BEGIN
  v_slug := regexp_replace(
    lower(unaccent(p_name || '-' || extract(epoch from now())::TEXT)),
    '[^a-z0-9-]', '', 'g'
  );

  INSERT INTO app.clinic (name, slug, timezone)
  VALUES (p_name, v_slug, p_timezone)
  RETURNING id INTO v_clinic_id;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', 'clinic_' || v_slug);

  RETURN 'clinic_' || v_slug;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON app.clinic
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON app.user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON app.exercise
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON app.protocol
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
