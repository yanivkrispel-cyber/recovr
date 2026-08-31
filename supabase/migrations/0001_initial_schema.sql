-- RecoveryOS Database Schema
-- Schema: app.clinic_template
-- One schema per clinic. Never hand-edit a clinic schema directly.
-- Use scripts/apply-to-all-clinics.ts to propagate migrations.

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Used by provision_clinic() to slugify clinic names
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ============================================================
-- SHARED SCHEMA (app) — cross-clinic data
-- ============================================================

CREATE SCHEMA IF NOT EXISTS app;
-- PostgREST connects as `authenticated`/`service_role`; custom schemas get no
-- privileges by default (unlike the pre-bootstrapped `public` schema), so
-- every custom schema needs an explicit grant. `anon` is deliberately excluded
-- — nothing in `app` should be readable before sign-in.
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO authenticated, service_role;

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
  is_current    BOOLEAN NOT NULL DEFAULT false
);

-- Only one plan_version per plan can be current at a time (partial index).
-- Deliberately NOT a plain UNIQUE(plan_id, is_current) table constraint —
-- that would also cap a plan at exactly one non-current (is_current=false)
-- version, breaking on a plan's second revision.
CREATE UNIQUE INDEX plan_version_current_once ON plan_version(plan_id) WHERE is_current = true;

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
  schedule                  JSONB, -- e.g. {"days": ["mon","wed","fri"]}; days_per_week above is the normalized count
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
  UNIQUE(code)
);

-- Within a single clinic, codes must still be unique (system rows have clinic_id = NULL)
CREATE UNIQUE INDEX measure_definition_clinic_code ON measure_definition(clinic_id, code) WHERE clinic_id IS NOT NULL;

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
    COUNT(*) FILTER (WHERE planned = true),
    COUNT(*) FILTER (WHERE completed = true)
  INTO v_planned, v_completed
  FROM sessions;

  IF v_planned = 0 THEN
    RETURN NULL;  -- no divide-by-zero; display "--"
  END IF;

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

-- ============================================================
-- CROSS-SCHEMA RPCs (called by Edge Functions)
-- ------------------------------------------------------------
-- PostgREST commits one request per transaction, so `SET search_path`
-- from one call never survives into the next. Every function below does
-- its own schema resolution + `SET LOCAL search_path` and finishes the
-- whole operation in the same call. These live in `app` because that's
-- the only application schema exposed to PostgREST (see [api] schemas
-- in config.toml) — clinic_<slug> schemas are reached only through here.
-- ============================================================

-- resolve_clinic_for_patient(patient_id) / resolve_clinic_for_session(session_id)
-- There is no cross-clinic index of patient/session ids yet, so this scans
-- each clinic schema. Fine at current scale; add an index table (e.g. on
-- app.patient_auth.clinic_id) if the number of clinics grows large.
CREATE OR REPLACE FUNCTION app.resolve_clinic_for_patient(p_patient_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_schema TEXT;
  v_found BOOLEAN;
BEGIN
  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.patient WHERE id = $1)', v_schema)
      INTO v_found USING p_patient_id;
    IF v_found THEN
      RETURN v_schema;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION app.resolve_clinic_for_session(p_session_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_schema TEXT;
  v_found BOOLEAN;
BEGIN
  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.session WHERE id = $1)', v_schema)
      INTO v_found USING p_session_id;
    IF v_found THEN
      RETURN v_schema;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- app.patient_today(patient_auth_id, today) — GET /me/today
-- Response shape matches API_CONTRACT.md: {session_id, date, phase, items,
-- progress}. Creates today's session on first read if it doesn't exist yet
-- (items_planned = the current phase's exercise count) — nothing else in
-- this codebase creates session rows, so without this the patient app can
-- never have anything to log against.
CREATE OR REPLACE FUNCTION app.patient_today(p_patient_auth_id UUID, p_today DATE)
RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_plan_version_id UUID;
  v_phase_id UUID;
  v_phase_name TEXT;
  v_phase_n INT;
  v_session_id UUID;
  v_items JSONB;
  v_done INT;
  v_total INT;
  v_patient_name TEXT;
  v_protocol_name TEXT;
  v_plan_started_at TIMESTAMPTZ;
  v_plan_version_no INT;
  v_plan_version_created_at TIMESTAMPTZ;
  v_est_seconds INT;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT pv.id, pp.id, pp.name, pp.n, p.name, pr.name, pl.started_at, pv.version, pv.created_at
  INTO v_plan_version_id, v_phase_id, v_phase_name, v_phase_n, v_patient_name, v_protocol_name, v_plan_started_at, v_plan_version_no, v_plan_version_created_at
  FROM plan pl
  JOIN patient p ON p.id = pl.patient_id
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = v_patient_id;

  IF v_phase_id IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  SELECT id INTO v_session_id FROM session WHERE patient_id = v_patient_id AND date = p_today;
  IF v_session_id IS NULL THEN
    SELECT count(*) INTO v_total FROM plan_exercise WHERE plan_phase_id = v_phase_id AND deleted_at IS NULL;
    INSERT INTO session (patient_id, plan_version_id, date, status, items_planned)
    VALUES (v_patient_id, v_plan_version_id, p_today, 'planned', v_total)
    RETURNING id INTO v_session_id;
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', pe.id, 'plan_phase_id', pe.plan_phase_id, 'exercise_id', pe.exercise_id,
      'sets', pe.sets, 'reps', pe.reps, 'load', pe.load, 'load_unit', pe.load_unit,
      'tempo', pe.tempo, 'hold_sec', pe.hold_sec, 'rest_sec', pe.rest_sec, 'side', pe.side,
      'order', pe."order", 'source', pe.source,
      'exercise', jsonb_build_object(
        'name', ex.name, 'name_en', ex.name_en, 'instructions', ex.instructions
      ),
      'done', (si.id IS NOT NULL AND NOT si.skipped)
    ) ORDER BY pe."order"), '[]'::jsonb),
    count(*) FILTER (WHERE si.id IS NOT NULL AND NOT si.skipped)
  INTO v_items, v_done
  FROM plan_exercise pe
  JOIN app.exercise ex ON ex.id = pe.exercise_id
  LEFT JOIN session_item si ON si.session_id = v_session_id AND si.plan_exercise_id = pe.id
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  v_total := jsonb_array_length(v_items);

  -- Rough duration estimate for the "~N min" header line — not a clinical
  -- figure, just a UX estimate from the prescribed sets/reps/hold/rest.
  SELECT COALESCE(sum(pe.sets * (COALESCE(pe.hold_sec, pe.reps * 3, 20) + COALESCE(pe.rest_sec, 30))), 0)
  INTO v_est_seconds
  FROM plan_exercise pe
  WHERE pe.plan_phase_id = v_phase_id AND pe.deleted_at IS NULL;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'session', v_session_id);

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'date', p_today,
    'patient', jsonb_build_object('name', v_patient_name, 'day', (p_today - v_plan_started_at::date) + 1),
    'plan', jsonb_build_object(
      'protocol_name', v_protocol_name,
      'updated_recently', v_plan_version_no > 1 AND v_plan_version_created_at >= now() - interval '3 days'
    ),
    'est_minutes', GREATEST(1, round(v_est_seconds / 60.0)::int),
    'phase', jsonb_build_object('name', v_phase_name, 'n', v_phase_n),
    'items', v_items,
    'progress', jsonb_build_object('done', v_done, 'total', v_total)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.recompute_criteria(schema, plan_phase_id) — T-09 "live met/not-met
-- evaluation from measurements". Only `time` and `pain` can actually be
-- evaluated against data that exists today: `time` from plan_phase.
-- started_at, `pain` from the patient's most recent logged
-- session_item.pain_score. `rom`/`strength`/`assessment` would need a
-- measure_code linking a criterion to a specific measure_definition row —
-- that FK doesn't exist, and measure_definition is empty until T-09b seeds
-- it from ROM_CATALOG — so those stay clinician-set via
-- app.set_criterion_met (manual is that way by definition). Called before
-- every criteria read so what's displayed and what phase-approve snapshots
-- are always current, not stale.
CREATE OR REPLACE FUNCTION app.recompute_criteria(p_schema TEXT, p_plan_phase_id UUID)
RETURNS VOID AS $$
DECLARE
  v_patient_id UUID;
  v_phase_started_at TIMESTAMPTZ;
  v_latest_pain NUMERIC;
  v_crit RECORD;
  v_met BOOLEAN;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT pl.patient_id, pp.started_at INTO v_patient_id, v_phase_started_at
  FROM plan_phase pp
  JOIN plan_version pv ON pv.id = pp.plan_version_id
  JOIN plan pl ON pl.id = pv.plan_id
  WHERE pp.id = p_plan_phase_id;

  IF v_patient_id IS NULL THEN
    RETURN;
  END IF;

  SELECT si.pain_score INTO v_latest_pain
  FROM session_item si
  JOIN session s ON s.id = si.session_id
  WHERE s.patient_id = v_patient_id AND si.pain_score IS NOT NULL
  ORDER BY si.logged_at DESC LIMIT 1;

  FOR v_crit IN SELECT * FROM plan_criterion WHERE plan_phase_id = p_plan_phase_id LOOP
    v_met := NULL;

    IF v_crit.type = 'time' AND v_phase_started_at IS NOT NULL THEN
      v_met := (CURRENT_DATE - v_phase_started_at::date) >= v_crit.value;
    ELSIF v_crit.type = 'pain' AND v_latest_pain IS NOT NULL THEN
      v_met := CASE v_crit.operator
        WHEN 'lte' THEN v_latest_pain <= v_crit.value
        WHEN 'gte' THEN v_latest_pain >= v_crit.value
        WHEN 'eq' THEN v_latest_pain = v_crit.value
        ELSE NULL
      END;
    END IF;

    IF v_met IS NOT NULL AND v_met IS DISTINCT FROM v_crit.is_met THEN
      UPDATE plan_criterion
      SET is_met = v_met, met_at = CASE WHEN v_met THEN COALESCE(met_at, now()) ELSE NULL END
      WHERE id = v_crit.id;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.set_criterion_met(clinician_id, patient_id, criterion_id, is_met) —
-- manual toggle for criteria recompute_criteria can't evaluate
-- (rom/strength/assessment/manual). A direct update to the current
-- version's row, not a versioned plan edit — is_met/met_at is cached
-- status (DATA_MODEL.md: "is_met (cached)"), not plan content the way
-- exercises are.
CREATE OR REPLACE FUNCTION app.set_criterion_met(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_criterion_id UUID,
  p_is_met BOOLEAN
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_updated INT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  UPDATE plan_criterion pc
  SET is_met = p_is_met, met_at = CASE WHEN p_is_met THEN now() ELSE NULL END
  FROM plan_phase pp, plan_version pv, plan pl
  WHERE pc.id = p_criterion_id
    AND pc.plan_phase_id = pp.id
    AND pp.plan_version_id = pv.id
    AND pv.plan_id = pl.id
    AND pv.is_current = true
    AND pl.patient_id = p_patient_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.get_plan_for_phase_transition(schema, patient_id) — read side of
-- POST /patients/:id/phase-transitions. Caller resolves+authorizes the
-- schema first (via resolve_clinic_for_patient) since it also needs it
-- for the clinic-match check.
CREATE OR REPLACE FUNCTION app.get_plan_for_phase_transition(p_schema TEXT, p_patient_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_phase_id UUID;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT pp.id INTO v_phase_id
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = p_patient_id;

  IF v_phase_id IS NOT NULL THEN
    PERFORM app.recompute_criteria(p_schema, v_phase_id);
    EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);
  END IF;

  SELECT jsonb_build_object(
    'plan_id', pl.id,
    'current_phase_n', pl.current_phase_n,
    'criteria', COALESCE(crit_agg.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', pc.id, 'type', pc.type, 'operator', pc.operator,
      'value', pc.value, 'is_met', pc.is_met, 'met_at', pc.met_at
    )) AS items
    FROM plan_criterion pc
    WHERE pc.plan_phase_id = pp.id
  ) crit_agg ON true
  WHERE pl.patient_id = p_patient_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.write_phase_transition(...) — write side of the same endpoint.
-- Writes the immutable phase_transition row and advances plan.current_phase_n.
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
  v_new_phase_id UUID;
  v_protocol_phase RECORD;
BEGIN
  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  INSERT INTO phase_transition (
    plan_id, from_phase_n, to_phase_n, direction, approved_by, criteria_snapshot, override_reason
  ) VALUES (
    p_plan_id, p_from_phase_n, p_to_phase_n, p_direction, p_approved_by, p_criteria_snapshot, p_override_reason
  )
  RETURNING to_jsonb(phase_transition.*) INTO v_transition;

  UPDATE plan SET current_phase_n = p_to_phase_n, updated_at = now() WHERE id = p_plan_id;

  -- Nothing else in this codebase creates plan_phase rows past the first
  -- one (plans start with only their initial phase instantiated) — so
  -- advancing forward into a phase reached for the first time needs to
  -- instantiate it from the protocol template, or every read of that
  -- phase (me-today, get_plan, patient_overview) 404s from here on.
  -- Regressing back never needs this: that phase was already instantiated
  -- when the plan first reached it going forward.
  IF p_direction = 'forward' THEN
    SELECT pv.id, pl.protocol_id INTO v_version_id, v_protocol_id
    FROM plan_version pv JOIN plan pl ON pl.id = pv.plan_id
    WHERE pv.plan_id = p_plan_id AND pv.is_current = true;

    IF NOT EXISTS (SELECT 1 FROM plan_phase WHERE plan_version_id = v_version_id AND n = p_to_phase_n) THEN
      SELECT * INTO v_protocol_phase FROM app.protocol_phase WHERE protocol_id = v_protocol_id AND n = p_to_phase_n;

      IF FOUND THEN
        INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at)
        VALUES (v_version_id, v_protocol_phase.n, v_protocol_phase.name, v_protocol_phase.duration_days, now())
        RETURNING id INTO v_new_phase_id;

        INSERT INTO plan_exercise (
          plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec, side, "order", source
        )
        SELECT
          v_new_phase_id, ppe.exercise_id,
          (ppe.prescription->>'sets')::int, (ppe.prescription->>'reps')::int,
          (ppe.prescription->>'load')::numeric, ppe.prescription->>'load_unit',
          ppe.prescription->>'tempo', (ppe.prescription->>'hold_sec')::int, (ppe.prescription->>'rest_sec')::int,
          ppe.prescription->>'side', ppe."order", 'protocol'
        FROM app.protocol_phase_exercise ppe
        WHERE ppe.protocol_phase_id = v_protocol_phase.id;

        INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order")
        SELECT v_new_phase_id, ppc.type, ppc.label, ppc.label_en, ppc.operator, ppc.value, ppc.unit, ppc."order"
        FROM app.protocol_phase_criterion ppc
        WHERE ppc.protocol_phase_id = v_protocol_phase.id;
      END IF;
    END IF;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_approved_by, 'phase_transition', 'plan', p_plan_id);

  RETURN v_transition;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.write_session_items(...) — POST /me/sessions/:id/items
-- Upserts the batch (dedupes on session_item.id), recomputes the parent
-- session's status/completion_ratio from its items, rolls that into
-- adherence_daily for the day, and audit-logs the write. Verifies the
-- calling patient actually owns the session — the original code never
-- checked this, so any authenticated patient could write into any
-- session by guessing its id.
CREATE OR REPLACE FUNCTION app.write_session_items(
  p_schema TEXT,
  p_session_id UUID,
  p_items JSONB,
  p_actor_patient_auth_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_caller_patient_id UUID;
  v_session_patient_id UUID;
  v_session_date DATE;
  v_planned INT;
  v_done INT;
  v_ratio NUMERIC;
  v_status TEXT;
  v_items JSONB;
BEGIN
  SELECT patient_id INTO v_caller_patient_id FROM app.patient_auth WHERE id = p_actor_patient_auth_id;
  IF v_caller_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', p_schema);

  SELECT patient_id, date, items_planned INTO v_session_patient_id, v_session_date, v_planned
  FROM session WHERE id = p_session_id;

  IF v_session_patient_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_session_patient_id != v_caller_patient_id THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  WITH input_items AS (
    SELECT
      (elem->>'id')::UUID AS id,
      p_session_id AS session_id,
      (elem->>'plan_exercise_id')::UUID AS plan_exercise_id,
      (elem->>'sets_done')::INT AS sets_done,
      (elem->>'reps_done')::INT AS reps_done,
      (elem->>'load_used')::NUMERIC AS load_used,
      (elem->>'pain_score')::NUMERIC AS pain_score,
      elem->>'difficulty' AS difficulty,
      COALESCE((elem->>'skipped')::BOOLEAN, false) AS skipped,
      elem->>'skip_reason' AS skip_reason,
      elem->>'note' AS note,
      (elem->>'logged_at')::TIMESTAMPTZ AS logged_at,
      now() AS synced_at
    FROM jsonb_array_elements(p_items) AS elem
  )
  INSERT INTO session_item (
    id, session_id, plan_exercise_id, sets_done, reps_done, load_used,
    pain_score, difficulty, skipped, skip_reason, note, logged_at, synced_at
  )
  SELECT id, session_id, plan_exercise_id, sets_done, reps_done, load_used,
    pain_score, difficulty, skipped, skip_reason, note, logged_at, synced_at
  FROM input_items
  ON CONFLICT (session_id, id) DO NOTHING;

  SELECT COALESCE(jsonb_agg(to_jsonb(si.*)), '[]'::jsonb) INTO v_items
  FROM session_item si
  WHERE si.session_id = p_session_id
    AND si.id IN (SELECT (elem->>'id')::UUID FROM jsonb_array_elements(p_items) AS elem);

  SELECT count(*) FILTER (WHERE NOT skipped) INTO v_done
  FROM session_item WHERE session_id = p_session_id;

  v_ratio := CASE WHEN v_planned > 0 THEN LEAST(v_done::NUMERIC / v_planned, 1) ELSE 0 END;
  v_status := CASE
    WHEN v_planned = 0 OR v_done = 0 THEN 'planned'
    WHEN v_done >= v_planned THEN 'completed'
    ELSE 'partial'
  END;

  UPDATE session
  SET items_done = v_done,
      completion_ratio = v_ratio,
      status = v_status,
      completed_at = CASE WHEN v_status = 'completed' THEN now() ELSE completed_at END,
      updated_at = now()
  WHERE id = p_session_id;

  INSERT INTO adherence_daily (patient_id, date, planned, completed, completion_ratio)
  VALUES (v_session_patient_id, v_session_date, v_planned > 0, v_status = 'completed', v_ratio)
  ON CONFLICT (patient_id, date) DO UPDATE
    SET planned = EXCLUDED.planned,
        completed = EXCLUDED.completed,
        completion_ratio = EXCLUDED.completion_ratio;

  PERFORM recompute_adherence(v_session_patient_id, v_session_date);

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_actor_patient_auth_id, 'write', 'session_item', p_session_id);

  RETURN jsonb_build_object('items', v_items);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- PROGRESS & EDUCATION (T-13) — GET /me/progress, GET /me/education
-- ============================================================

-- app.patient_progress(patient_auth_id, window_days) — GET /me/progress?window=
-- {adherence_pct, adherence_series, pain_trend, phase_timeline, milestones}
-- per API_CONTRACT.md. adherence_pct is the same rolling-7-day headline
-- number as RULES §1 (via recompute_adherence, read-only despite the name);
-- adherence_series is the per-day completion_ratio history for the chart.
-- phase_timeline covers every phase in the protocol, not just ones the plan
-- has reached — plan_phase rows are only instantiated lazily as the patient
-- advances (see write_phase_transition), so status is derived by comparing
-- each phase's n to plan.current_phase_n rather than from plan_phase at all.
CREATE OR REPLACE FUNCTION app.patient_progress(
  p_patient_auth_id UUID,
  p_window_days INT DEFAULT 30
) RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'adherence_pct', recompute_adherence(v_patient_id, CURRENT_DATE),
    'adherence_series', COALESCE(adherence_series.items, '[]'::jsonb),
    'pain_trend', COALESCE(pain_trend.items, '[]'::jsonb),
    'phase_timeline', COALESCE(phase_timeline.items, '[]'::jsonb),
    'milestones', COALESCE(milestones.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'date', ad.date, 'planned', ad.planned, 'completed', ad.completed,
      'completion_ratio', ad.completion_ratio
    ) ORDER BY ad.date) AS items
    FROM adherence_daily ad
    WHERE ad.patient_id = v_patient_id
      AND ad.date >= CURRENT_DATE - (p_window_days || ' days')::interval
  ) adherence_series ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('date', pt.d, 'max_pain', pt.mp) ORDER BY pt.d) AS items
    FROM (
      SELECT s.date AS d, MAX(si.pain_score) AS mp
      FROM session s
      JOIN session_item si ON si.session_id = s.id
      WHERE s.patient_id = v_patient_id
        AND si.pain_score IS NOT NULL
        AND NOT si.skipped
        AND s.date >= CURRENT_DATE - (p_window_days || ' days')::interval
      GROUP BY s.date
    ) pt
  ) pain_trend ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'n', pph.n, 'name', pph.name, 'name_en', pph.name_en,
      'duration_days', pph.duration_days,
      'status', CASE WHEN pph.n < pl.current_phase_n THEN 'done'
                     WHEN pph.n = pl.current_phase_n THEN 'current'
                     ELSE 'todo' END,
      'started_at', plph.started_at
    ) ORDER BY pph.n) AS items
    FROM app.protocol_phase pph
    LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
    LEFT JOIN plan_phase plph ON plph.plan_version_id = pv.id AND plph.n = pph.n
    WHERE pph.protocol_id = pl.protocol_id
  ) phase_timeline ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'from_phase_n', trans.from_phase_n, 'to_phase_n', trans.to_phase_n,
      'direction', trans.direction, 'approved_at', trans.approved_at
    ) ORDER BY trans.approved_at) AS items
    FROM phase_transition trans
    WHERE trans.plan_id = pl.id
  ) milestones ON true
  WHERE pl.patient_id = v_patient_id;

  IF v_result IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'progress', v_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.patient_education(patient_auth_id) — GET /me/education
-- Current phase's goals + a rough "what to expect" estimate, per
-- API_CONTRACT.md. goals come from app.protocol_phase (the protocol
-- template), not plan_phase, which doesn't carry them (DATA_MODEL §plan).
CREATE OR REPLACE FUNCTION app.patient_education(p_patient_auth_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT patient_id INTO v_patient_id FROM app.patient_auth WHERE id = p_patient_auth_id;
  IF v_patient_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT jsonb_build_object(
    'phase_n', pph.n,
    'phase_name', pph.name,
    'phase_name_en', pph.name_en,
    'goals', pph.goals,
    'exercise_count', COALESCE(ex_agg.cnt, 0),
    'est_minutes', GREATEST(1, ROUND(COALESCE(ex_agg.est_seconds, 0) / 60.0)::int)
  )
  INTO v_result
  FROM plan pl
  JOIN app.protocol_phase pph ON pph.protocol_id = pl.protocol_id AND pph.n = pl.current_phase_n
  LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  LEFT JOIN plan_phase plph ON plph.plan_version_id = pv.id AND plph.n = pl.current_phase_n
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt,
      sum(pe.sets * (COALESCE(pe.hold_sec, pe.reps * 3, 20) + COALESCE(pe.rest_sec, 30))) AS est_seconds
    FROM plan_exercise pe
    WHERE pe.plan_phase_id = plph.id AND pe.deleted_at IS NULL
  ) ex_agg ON true
  WHERE pl.patient_id = v_patient_id;

  IF v_result IS NULL THEN
    RETURN NULL; -- no active plan
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('patient', p_patient_auth_id, 'read', 'education', v_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- PATIENT INVITE / ACCEPT (T-03)
-- ============================================================

-- app.invite_patient(clinician_id, name, email) — POST /patients (invite part).
-- Creates the clinic-scoped patient row (status='invited') and its
-- app.patient_auth invite record. Derives the clinic from the clinician's
-- own app.user row rather than trusting a caller-supplied clinic id.
CREATE OR REPLACE FUNCTION app.invite_patient(
  p_clinician_id UUID,
  p_name TEXT,
  p_email TEXT
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
  v_patient_id UUID;
  v_token TEXT;
BEGIN
  SELECT clinic_id INTO v_clinic_id
  FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT 'clinic_' || slug INTO v_schema FROM app.clinic WHERE id = v_clinic_id;
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  INSERT INTO patient (clinic_id, primary_clinician_id, name, email, status)
  VALUES (v_clinic_id, p_clinician_id, p_name, p_email, 'invited')
  RETURNING id INTO v_patient_id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO app.patient_auth (patient_id, invite_token, invite_expires_at, password_hash, status)
  VALUES (v_patient_id, v_token, now() + INTERVAL '7 days', '', 'invited');

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'invite', 'patient', v_patient_id);

  RETURN jsonb_build_object('patient_id', v_patient_id, 'invite_token', v_token);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.resolve_invite(token) — validates an invite token (patient-facing,
-- pre-auth) and returns what's needed to create the account.
CREATE OR REPLACE FUNCTION app.resolve_invite(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_status TEXT;
  v_expires_at TIMESTAMPTZ;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT patient_id, status, invite_expires_at
  INTO v_patient_id, v_status, v_expires_at
  FROM app.patient_auth WHERE invite_token = p_token;

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

-- app.accept_patient_invite(token, new_auth_user_id, consent_version) —
-- finalizes activation once the real auth.users row has been created.
-- app.patient_auth.id was a placeholder before the account existed, so
-- this swaps it (delete + reinsert — PKs aren't meant to be UPDATEd) to
-- match the new auth user id, activates the clinic-schema patient row,
-- and records consent.
CREATE OR REPLACE FUNCTION app.accept_patient_invite(
  p_token TEXT,
  p_new_auth_user_id UUID,
  p_consent_version TEXT
) RETURNS JSONB AS $$
DECLARE
  v_patient_id UUID;
  v_status TEXT;
  v_expires_at TIMESTAMPTZ;
  v_schema TEXT;
BEGIN
  SELECT patient_id, status, invite_expires_at
  INTO v_patient_id, v_status, v_expires_at
  FROM app.patient_auth WHERE invite_token = p_token;

  IF v_patient_id IS NULL OR v_status != 'invited' OR v_expires_at < now() THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  v_schema := app.resolve_clinic_for_patient(v_patient_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  DELETE FROM app.patient_auth WHERE invite_token = p_token;

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

-- ============================================================
-- DASHBOARD (T-05)
-- ============================================================

-- app.resolve_clinician_schema(clinician_id) — shared by every dashboard
-- RPC below to avoid re-deriving clinic_id/schema in each one.
CREATE OR REPLACE FUNCTION app.resolve_clinician_schema(p_clinician_id UUID)
RETURNS TABLE(clinic_id UUID, schema_name TEXT) AS $$
  SELECT u.clinic_id, 'clinic_' || c.slug
  FROM app."user" u
  JOIN app.clinic c ON c.id = u.clinic_id
  WHERE u.id = p_clinician_id AND u.role IN ('clinician', 'admin');
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- app.clinic_patient_summary(schema) — one row per active patient with
-- everything the dashboard KPIs and patient table need. Shared so the two
-- never compute "ready"/"attention"/"inactive" differently.
--
-- is_ready / is_low_adherence / is_inactive implement RULES.md §2 and §4
-- at query time (all current-phase criteria met; 7-day adherence < the
-- RULES.md §1 default 70% threshold; no completed/partial session in 4+
-- days) rather than reading from the `alert` table, because T-17 (the
-- alerts engine that actually populates `alert` with dedupe windows,
-- pain-spike detection, etc.) hasn't been built yet. Once it exists, this
-- should switch to reading open alerts instead of recomputing thresholds
-- inline — the 70% threshold here is also meant to become a per-clinic
-- setting (T-20), not a constant.
DROP FUNCTION IF EXISTS app.clinic_patient_summary(TEXT);
CREATE OR REPLACE FUNCTION app.clinic_patient_summary(p_schema TEXT)
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
  is_inactive BOOLEAN
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
    (CURRENT_DATE - pl.started_at::date) + 1,
    COALESCE(recompute_adherence(p.id, CURRENT_DATE)::int, 0),
    (SELECT max(s.date) FROM session s WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')),
    (
      EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id)
      AND NOT EXISTS (SELECT 1 FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id AND NOT pc.is_met)
    ),
    COALESCE(recompute_adherence(p.id, CURRENT_DATE) < 70, false),
    NOT EXISTS (
      SELECT 1 FROM session s
      WHERE s.patient_id = p.id AND s.status IN ('completed', 'partial')
        AND s.date >= CURRENT_DATE - 4
    )
  FROM patient p
  JOIN plan pl ON pl.patient_id = p.id
  JOIN app.protocol pr ON pr.id = pl.protocol_id
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE p.status = 'active' AND p.deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.dashboard_kpis(clinician_id) — GET /dashboard's kpis object.
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
    'active_patients', count(*),
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

-- app.list_patients(clinician_id, filter, query) — GET /patients
-- filter: 'all' | 'attention' | 'ready' | 'inactive'. A patient matching
-- more than one condition is classified by priority: inactive (most
-- urgent — no engagement at all) > attention (adherence dropped) >
-- ready (positive milestone) > ontrack.
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

-- app.list_open_alerts(clinician_id) — GET /alerts?state=open
CREATE OR REPLACE FUNCTION app.list_open_alerts(p_clinician_id UUID)
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', a.id, 'patient_id', a.patient_id, 'patient_name', p.name,
    'type', a.type, 'severity', a.severity, 'payload', a.payload,
    'state', a.state, 'created_at', a.created_at
  ) ORDER BY a.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM alert a
  JOIN patient p ON p.id = a.patient_id
  WHERE a.state = 'open';

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.review_alert(clinician_id, alert_id) — POST /alerts/:id/review
CREATE OR REPLACE FUNCTION app.review_alert(p_clinician_id UUID, p_alert_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_updated INT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE alert SET state = 'reviewed', reviewed_by = p_clinician_id, reviewed_at = now()
  WHERE id = p_alert_id AND state = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- PATIENT OVERVIEW (T-06)
-- ============================================================

-- app.patient_overview(clinician_id, patient_id) — GET /patients/:id
-- Everything the overview screen's "overview" tab needs in one call:
-- patient demographics, current plan/phase, current-phase criteria, this
-- patient's open alerts, today's session, and a short recent-activity feed
-- (last 10 sessions + phase transitions). A patient with no plan yet (or
-- belonging to a different clinic) comes back as {error: 'not_found'} —
-- per CLAUDE.md hard rule #4, cross-clinic ids are 404, never 403.
-- Writes app.audit_log per CLAUDE.md hard rule #5 (every clinician read
-- of a patient record is audited).
CREATE OR REPLACE FUNCTION app.patient_overview(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_result JSONB;
  v_phase_id UUID;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  SELECT pp.id INTO v_phase_id
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  WHERE pl.patient_id = p_patient_id;

  IF v_phase_id IS NOT NULL THEN
    PERFORM app.recompute_criteria(v_schema, v_phase_id);
    EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);
  END IF;

  SELECT jsonb_build_object(
    'patient', jsonb_build_object(
      'id', p.id, 'name', p.name, 'name_en', p.name_en, 'birth_date', p.birth_date,
      'sex', p.sex, 'phone', p.phone, 'email', p.email, 'sport', p.sport,
      'position', p.position, 'status', p.status, 'activated_at', p.activated_at
    ),
    'plan', CASE WHEN pl.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', pl.id, 'protocol_name', pr.name, 'protocol_slug', pr.slug, 'current_phase_n', pl.current_phase_n,
      'phase_name', pp.name, 'phase_goals', prpp.goals, 'started_at', pl.started_at,
      'day', (CURRENT_DATE - pl.started_at::date) + 1, 'status', pl.status
    ) END,
    'criteria', COALESCE(crit_agg.items, '[]'::jsonb),
    'alerts', COALESCE(alert_agg.items, '[]'::jsonb),
    'today', today_agg.item,
    'recent_activity', COALESCE(activity_agg.items, '[]'::jsonb),
    'phase_transitions', COALESCE(transition_agg.items, '[]'::jsonb),
    'adherence', COALESCE(recompute_adherence(p.id, CURRENT_DATE)::int, 0),
    'pain_trend', pain_agg.item,
    -- Latest goniometric (non-functional-test) ROM reading across any
    -- joint — there's no "headline motion" defined per protocol, so this
    -- is honestly "most recently recorded", not a curated primary metric.
    'rom_latest', rom_agg.value
  )
  INTO v_result
  FROM patient p
  LEFT JOIN plan pl ON pl.patient_id = p.id
  LEFT JOIN app.protocol pr ON pr.id = pl.protocol_id
  LEFT JOIN plan_version pv ON pv.plan_id = pl.id AND pv.is_current = true
  LEFT JOIN plan_phase pp ON pp.plan_version_id = pv.id AND pp.n = pl.current_phase_n
  -- goals are a protocol-template property (DATA_MODEL.md: plan_phase has no
  -- goals column of its own), so pull them from the protocol's matching phase.
  LEFT JOIN app.protocol_phase prpp ON prpp.protocol_id = pl.protocol_id AND prpp.n = pl.current_phase_n
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', pc.id, 'type', pc.type, 'label', pc.label, 'operator', pc.operator,
      'value', pc.value, 'unit', pc.unit, 'is_met', pc.is_met, 'met_at', pc.met_at
    ) ORDER BY pc."order") AS items
    FROM plan_criterion pc WHERE pc.plan_phase_id = pp.id
  ) crit_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id, 'type', a.type, 'severity', a.severity, 'state', a.state, 'created_at', a.created_at
    ) ORDER BY a.created_at DESC) AS items
    FROM alert a WHERE a.patient_id = p.id AND a.state = 'open'
  ) alert_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'date', s.date, 'status', s.status, 'items_planned', s.items_planned,
      'items_done', s.items_done, 'completion_ratio', s.completion_ratio
    ) AS item
    FROM session s WHERE s.patient_id = p.id AND s.date = CURRENT_DATE
  ) today_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'date', s.date, 'status', s.status, 'completion_ratio', s.completion_ratio
    ) ORDER BY s.date DESC) AS items
    FROM (SELECT * FROM session s2 WHERE s2.patient_id = p.id ORDER BY s2.date DESC LIMIT 10) s
  ) activity_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'id', pt.id, 'from_phase_n', pt.from_phase_n, 'to_phase_n', pt.to_phase_n,
      'direction', pt.direction, 'approved_at', pt.approved_at, 'override_reason', pt.override_reason
    ) ORDER BY pt.approved_at DESC) AS items
    FROM (SELECT * FROM phase_transition pt2 WHERE pt2.plan_id = pl.id ORDER BY pt2.approved_at DESC LIMIT 10) pt
  ) transition_agg ON true
  LEFT JOIN LATERAL (
    WITH scored AS (
      SELECT si.pain_score, s.date, si.logged_at
      FROM session_item si
      JOIN session s ON s.id = si.session_id
      WHERE s.patient_id = p.id AND si.pain_score IS NOT NULL AND si.skipped = false
    )
    SELECT jsonb_build_object(
      'from', (SELECT round(avg(e.pain_score), 1) FROM (SELECT pain_score FROM scored ORDER BY date ASC, logged_at ASC LIMIT 3) e),
      'to', (SELECT round(avg(r.pain_score), 1) FROM (SELECT pain_score FROM scored ORDER BY date DESC, logged_at DESC LIMIT 3) r)
    ) AS item
    WHERE (SELECT count(*) FROM scored) >= 2
  ) pain_agg ON true
  LEFT JOIN LATERAL (
    SELECT m.value
    FROM measurement m
    JOIN public.measure_definition md ON md.code = m.measure_code
    WHERE m.patient_id = p.id AND m.side IN ('involved', 'bilateral') AND m.deleted_at IS NULL
      AND m.superseded_by IS NULL AND md.unit = 'deg' AND COALESCE((md.flags->>'fx')::boolean, false) = false
    ORDER BY m.measured_at DESC LIMIT 1
  ) rom_agg ON true
  WHERE p.id = p_patient_id AND p.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'read', 'patient', p_patient_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- MEASUREMENT MODULE (T-09b) — see ROM_MEASUREMENT.md
-- Supersedes the T-06 placeholder app.patient_measurements (a flat
-- latest-per-code list): this is joint-scoped and returns definitions +
-- involved/healthy latest rows + short history, matching the real panel.
-- ============================================================

-- app.measure_definitions(clinician_id) — GET /measure-definitions
-- Full catalog: system rows (clinic_id NULL) plus this clinic's overrides.
CREATE OR REPLACE FUNCTION app.measure_definitions(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(md.*) ORDER BY md.joint, md.name_he), '[]'::jsonb)
    FROM public.measure_definition md
    WHERE md.clinic_id IS NULL OR md.clinic_id = v_clinic_id
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- app.get_measurements_for_joint(clinician_id, patient_id, joint) —
-- GET /patients/:id/measurements?joint=ankle
-- One entry per measure_definition in the joint: the definition itself,
-- the latest involved-side (or bilateral) row, the latest healthy-side
-- row, and up to 10 recent rows for history. Functional tests are in the
-- same catalog as goniometric ones (flags.fx distinguishes them) and are
-- returned identically — never merged with a goniometric row for the
-- same joint area (ROM_MEASUREMENT.md §1's core rule: this is enforced
-- simply by never looking anything up by joint+something-other-than-code;
-- each definition row, and therefore each measurement series, is scoped
-- to its own immutable `code`).
CREATE OR REPLACE FUNCTION app.get_measurements_for_joint(p_clinician_id UUID, p_patient_id UUID, p_joint TEXT)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
  v_result JSONB;
BEGIN
  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'definition', to_jsonb(md.*),
    'involved', involved_agg.item,
    'healthy', healthy_agg.item,
    'history', COALESCE(hist_agg.items, '[]'::jsonb)
  ) ORDER BY md.name_he), '[]'::jsonb)
  INTO v_result
  FROM public.measure_definition md
  LEFT JOIN LATERAL (
    SELECT to_jsonb(m.*) AS item FROM measurement m
    WHERE m.patient_id = p_patient_id AND m.measure_code = md.code AND m.side IN ('involved', 'bilateral')
      AND m.deleted_at IS NULL AND m.superseded_by IS NULL
    ORDER BY m.measured_at DESC LIMIT 1
  ) involved_agg ON true
  LEFT JOIN LATERAL (
    SELECT to_jsonb(m.*) AS item FROM measurement m
    WHERE m.patient_id = p_patient_id AND m.measure_code = md.code AND m.side = 'healthy'
      AND m.deleted_at IS NULL AND m.superseded_by IS NULL
    ORDER BY m.measured_at DESC LIMIT 1
  ) healthy_agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(to_jsonb(h.*) ORDER BY h.measured_at DESC) AS items
    FROM (
      SELECT * FROM measurement m2
      WHERE m2.patient_id = p_patient_id AND m2.measure_code = md.code
        AND m2.deleted_at IS NULL AND m2.superseded_by IS NULL
      ORDER BY m2.measured_at DESC LIMIT 10
    ) h
  ) hist_agg ON true
  WHERE md.joint = p_joint AND (md.clinic_id IS NULL OR md.clinic_id = v_clinic_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.write_measurement(...) — shared by POST /patients/:id/measurements
-- (p_supersedes_id NULL) and PATCH /measurements/:id (p_supersedes_id set:
-- inserts the corrected row, then marks the old one superseded — never
-- mutated, per RULES.md §5b and CLAUDE.md rule #6).
--
-- p_secondary_provided / p_compensations_provided distinguish "field
-- omitted" from "field explicitly cleared" (both would otherwise be NULL
-- on the wire) — when omitted, the value is inherited from the most
-- recent prior row for the same patient+code+side, so an untouched
-- optional field never overwrites what's stored (ROM_MEASUREMENT.md §5
-- rule 1).
CREATE OR REPLACE FUNCTION app.write_measurement(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_measure_code TEXT,
  p_side TEXT,
  p_value NUMERIC,
  p_value_secondary NUMERIC,
  p_secondary_provided BOOLEAN,
  p_pass BOOLEAN,
  p_compensations TEXT[],
  p_compensations_provided BOOLEAN,
  p_attempts NUMERIC[],
  p_governing_source TEXT,
  p_pain NUMERIC,
  p_end_feel TEXT,
  p_swelling TEXT,
  p_note TEXT,
  p_visit_id UUID,
  p_supersedes_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_def RECORD;
  v_bilat BOOLEAN;
  v_prior RECORD;
  v_final_secondary NUMERIC;
  v_final_comps TEXT[];
  v_new_id UUID;
  v_result JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_def FROM public.measure_definition WHERE code = p_measure_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  v_bilat := COALESCE((v_def.flags->>'bilat')::boolean, true);

  IF v_bilat = false AND p_side != 'bilateral' THEN
    RETURN jsonb_build_object('error', 'measure_side_invalid');
  END IF;
  IF v_bilat = true AND p_side = 'bilateral' THEN
    RETURN jsonb_build_object('error', 'measure_side_invalid');
  END IF;
  IF v_def.unit = 'cm' AND (p_value < 0 OR p_value > 60) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'cm_out_of_range');
  END IF;
  IF v_def.unit = 'deg' AND (p_value < -30 OR p_value > 200) THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'deg_out_of_range');
  END IF;
  IF v_def.unit = 'pass_fail' AND p_pass IS NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'pass_required');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  v_final_secondary := p_value_secondary;
  v_final_comps := p_compensations;

  IF NOT p_secondary_provided OR NOT p_compensations_provided THEN
    SELECT value_secondary, compensations INTO v_prior
    FROM measurement
    WHERE patient_id = p_patient_id AND measure_code = p_measure_code AND side = p_side
      AND deleted_at IS NULL AND superseded_by IS NULL
    ORDER BY measured_at DESC LIMIT 1;

    IF FOUND THEN
      IF NOT p_secondary_provided THEN v_final_secondary := v_prior.value_secondary; END IF;
      IF NOT p_compensations_provided THEN v_final_comps := v_prior.compensations; END IF;
    END IF;
  END IF;

  INSERT INTO measurement (
    patient_id, measure_code, side, value, value_secondary, pass, compensations, attempts,
    governing_source, pain, end_feel, swelling, note, visit_id, measured_by
  ) VALUES (
    p_patient_id, p_measure_code, p_side, p_value, v_final_secondary, p_pass, v_final_comps, p_attempts,
    p_governing_source, p_pain, p_end_feel, p_swelling, p_note, p_visit_id, p_clinician_id
  ) RETURNING id INTO v_new_id;

  IF p_supersedes_id IS NOT NULL THEN
    UPDATE measurement SET superseded_by = v_new_id WHERE id = p_supersedes_id AND superseded_by IS NULL;
  END IF;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'write', 'measurement', v_new_id);

  SELECT to_jsonb(m.*) INTO v_result FROM measurement m WHERE m.id = v_new_id;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.delete_measurement(...) — DELETE /measurements/:id (soft delete).
CREATE OR REPLACE FUNCTION app.delete_measurement(p_clinician_id UUID, p_patient_id UUID, p_measurement_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_updated INT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE measurement SET deleted_at = now()
  WHERE id = p_measurement_id AND patient_id = p_patient_id AND deleted_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.start_assessment_visit / app.save_assessment_visit —
-- POST /patients/:id/assessment-visits, PATCH /assessment-visits/:id/save
CREATE OR REPLACE FUNCTION app.start_assessment_visit(p_clinician_id UUID, p_patient_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_visit_id UUID;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  INSERT INTO assessment_visit (patient_id, clinician_id, started_at)
  VALUES (p_patient_id, p_clinician_id, now())
  RETURNING id INTO v_visit_id;

  RETURN jsonb_build_object('ok', true, 'visit_id', v_visit_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION app.save_assessment_visit(p_clinician_id UUID, p_patient_id UUID, p_visit_id UUID, p_note TEXT)
RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_updated INT;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  UPDATE assessment_visit SET saved_at = now(), note = COALESCE(p_note, note)
  WHERE id = p_visit_id AND patient_id = p_patient_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- PLAN SCREEN + EDIT PLAN (T-07)
-- ============================================================

-- app.get_plan(clinician_id, patient_id, version) — GET /patients/:id/plan?version=N
-- version = NULL returns the current version. Includes soft-deleted
-- (removed) exercises with their removed_reason/deleted_at so a specific
-- past version can still be viewed in full; the editor filters those out
-- client-side when building its draft.
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
    'phases', COALESCE(phase_agg.items, '[]'::jsonb),
    -- Every phase the protocol defines, for the timeline — plan_phase only
    -- has rows for phases actually reached so far.
    'protocol_phases', COALESCE(protocol_phase_agg.items, '[]'::jsonb)
  )
  INTO v_result
  FROM plan pl
  JOIN plan_version pv ON pv.plan_id = pl.id
    AND ((p_version IS NULL AND pv.is_current = true) OR pv.version = p_version)
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

-- app.save_plan_version(...) — POST /patients/:id/plan/versions
-- Atomically creates a new plan_version: copies every phase from the
-- current version verbatim, except p_phase_n, whose active exercise list
-- becomes exactly p_exercises. Any currently-active exercise in that phase
-- NOT present in p_exercises (by plan_exercise_id) is inferred as removed
-- and carried forward soft-deleted (deleted_at set) with its reason from
-- p_removal_reasons — every removed exercise MUST have one, or the whole
-- save is rejected (RULES.md §3, CLAUDE.md rule #6: soft delete only, and
-- removal must appear in patient history, never silently vanish).
-- p_base_version must match the current version number, or this returns
-- plan_version_conflict (409) instead of overwriting a concurrent edit.
-- Criteria are copied verbatim — editing them is T-09.
-- T-09 adds an optional trailing p_criteria param — different arg count,
-- so CREATE OR REPLACE would add a second overload instead of replacing
-- this one (same issue as search_exercises above).
DROP FUNCTION IF EXISTS app.save_plan_version(UUID, UUID, INT, INT, JSONB, JSONB, TEXT);

-- p_criteria: NULL (default) copies the phase's criteria verbatim, same as
-- before T-09. Passing an array replaces them — each item is either an
-- existing criterion (carries its id, so is_met/met_at survive) or a new
-- one (no id). Unlike exercises, removing a criterion needs no reason —
-- RULES.md only requires that for exercises — so criteria not present in
-- the submitted list are simply dropped, not soft-deleted.
CREATE OR REPLACE FUNCTION app.save_plan_version(
  p_clinician_id UUID,
  p_patient_id UUID,
  p_base_version INT,
  p_phase_n INT,
  p_exercises JSONB,
  p_removal_reasons JSONB,
  p_note TEXT,
  p_criteria JSONB DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_schema TEXT;
  v_plan_id UUID;
  v_old_version_id UUID;
  v_old_version_n INT;
  v_new_version_id UUID;
  v_old_phase RECORD;
  v_new_phase_id UUID;
  v_old_active_ids UUID[];
  v_submitted_ids UUID[];
  v_removed_ids UUID[];
  v_missing_reason UUID;
  v_ex JSONB;
  v_crit JSONB;
BEGIN
  SELECT schema_name INTO v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  IF NOT EXISTS (SELECT 1 FROM patient WHERE id = p_patient_id AND deleted_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id INTO v_plan_id FROM plan WHERE patient_id = p_patient_id;
  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT id, version INTO v_old_version_id, v_old_version_n
  FROM plan_version WHERE plan_id = v_plan_id AND is_current = true;

  IF v_old_version_n IS DISTINCT FROM p_base_version THEN
    RETURN jsonb_build_object('error', 'plan_version_conflict', 'current_version', v_old_version_n);
  END IF;

  SELECT array_agg(pe.id) INTO v_old_active_ids
  FROM plan_exercise pe
  JOIN plan_phase pp ON pp.id = pe.plan_phase_id
  WHERE pp.plan_version_id = v_old_version_id AND pp.n = p_phase_n AND pe.deleted_at IS NULL;

  SELECT array_agg((e->>'plan_exercise_id')::uuid) INTO v_submitted_ids
  FROM jsonb_array_elements(p_exercises) e
  WHERE e->>'plan_exercise_id' IS NOT NULL;

  SELECT array_agg(id) INTO v_removed_ids
  FROM unnest(COALESCE(v_old_active_ids, ARRAY[]::uuid[])) id
  WHERE id != ALL(COALESCE(v_submitted_ids, ARRAY[]::uuid[]));

  SELECT id INTO v_missing_reason
  FROM unnest(COALESCE(v_removed_ids, ARRAY[]::uuid[])) id
  WHERE NOT (p_removal_reasons ? id::text) OR trim(p_removal_reasons->>id::text) = '';

  IF v_missing_reason IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'removal_reason_required');
  END IF;

  -- Flip the old version off first — plan_version_current_once (partial
  -- unique index) allows only one is_current=true row per plan at a time,
  -- so inserting the new one first would collide with it.
  UPDATE plan_version SET is_current = false WHERE id = v_old_version_id;

  INSERT INTO plan_version (plan_id, version, created_by, note, is_current)
  VALUES (v_plan_id, v_old_version_n + 1, p_clinician_id, p_note, true)
  RETURNING id INTO v_new_version_id;

  FOR v_old_phase IN SELECT * FROM plan_phase WHERE plan_version_id = v_old_version_id ORDER BY n LOOP
    INSERT INTO plan_phase (plan_version_id, n, name, duration_days, started_at, completed_at)
    VALUES (v_new_version_id, v_old_phase.n, v_old_phase.name, v_old_phase.duration_days, v_old_phase.started_at, v_old_phase.completed_at)
    RETURNING id INTO v_new_phase_id;

    IF v_old_phase.n = p_phase_n AND p_criteria IS NOT NULL THEN
      FOR v_crit IN SELECT * FROM jsonb_array_elements(p_criteria) LOOP
        INSERT INTO plan_criterion (
          plan_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at
        )
        SELECT
          v_new_phase_id, v_crit->>'type', v_crit->>'label', v_crit->>'label_en',
          v_crit->>'operator', (v_crit->>'value')::numeric, v_crit->>'unit', (v_crit->>'order')::int,
          COALESCE(
            (SELECT is_met FROM plan_criterion WHERE id = NULLIF(v_crit->>'id', '')::uuid),
            false
          ),
          (SELECT met_at FROM plan_criterion WHERE id = NULLIF(v_crit->>'id', '')::uuid);
      END LOOP;
    ELSE
      INSERT INTO plan_criterion (plan_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at)
      SELECT v_new_phase_id, type, label, label_en, operator, value, unit, "order", is_met, met_at
      FROM plan_criterion WHERE plan_phase_id = v_old_phase.id;
    END IF;

    IF v_old_phase.n = p_phase_n THEN
      FOR v_ex IN SELECT * FROM jsonb_array_elements(p_exercises) LOOP
        INSERT INTO plan_exercise (
          plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
          side, frequency_days_per_week, schedule, "order", clinician_note, source
        )
        SELECT
          v_new_phase_id, (v_ex->>'exercise_id')::uuid,
          (v_ex->>'sets')::int, (v_ex->>'reps')::int, (v_ex->>'load')::numeric, v_ex->>'load_unit',
          v_ex->>'tempo', (v_ex->>'hold_sec')::int, (v_ex->>'rest_sec')::int, v_ex->>'side',
          (v_ex->>'frequency_days_per_week')::int, v_ex->'schedule', (v_ex->>'order')::int, v_ex->>'clinician_note',
          CASE WHEN v_ex->>'plan_exercise_id' IS NULL THEN 'added'
               ELSE COALESCE((SELECT source FROM plan_exercise WHERE id = (v_ex->>'plan_exercise_id')::uuid), 'modified')
          END;
      END LOOP;

      INSERT INTO plan_exercise (
        plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
        side, frequency_days_per_week, schedule, "order", clinician_note, source, removed_reason, deleted_at
      )
      SELECT
        v_new_phase_id, pe.exercise_id, pe.sets, pe.reps, pe.load, pe.load_unit, pe.tempo, pe.hold_sec, pe.rest_sec,
        pe.side, pe.frequency_days_per_week, pe.schedule, pe."order", pe.clinician_note, pe.source,
        p_removal_reasons->>pe.id::text, now()
      FROM plan_exercise pe
      WHERE pe.id = ANY(COALESCE(v_removed_ids, ARRAY[]::uuid[]));
    ELSE
      INSERT INTO plan_exercise (
        plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo, hold_sec, rest_sec,
        side, frequency_days_per_week, schedule, "order", clinician_note, removed_reason, source, deleted_at
      )
      SELECT
        v_new_phase_id, pe.exercise_id, pe.sets, pe.reps, pe.load, pe.load_unit, pe.tempo, pe.hold_sec, pe.rest_sec,
        pe.side, pe.frequency_days_per_week, pe.schedule, pe."order", pe.clinician_note, pe.removed_reason, pe.source, pe.deleted_at
      FROM plan_exercise pe WHERE pe.plan_phase_id = v_old_phase.id;
    END IF;
  END LOOP;

  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id)
  VALUES ('clinician', p_clinician_id, 'plan_edit', 'plan', v_plan_id);

  RETURN jsonb_build_object('ok', true, 'version', v_old_version_n + 1, 'plan_version_id', v_new_version_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.save_plan_template(clinician_id, name, payload) — POST /plan-templates
-- payload is a phase's exercise set (client-shaped JSONB), saved for reuse.
CREATE OR REPLACE FUNCTION app.save_plan_template(p_clinician_id UUID, p_name TEXT, p_payload JSONB)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_schema TEXT;
  v_template_id UUID;
BEGIN
  SELECT clinic_id, schema_name INTO v_clinic_id, v_schema FROM app.resolve_clinician_schema(p_clinician_id);
  IF v_schema IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  EXECUTE format('SET LOCAL search_path TO %I, app, public', v_schema);

  INSERT INTO plan_template (clinic_id, created_by, name, payload)
  VALUES (v_clinic_id, p_clinician_id, p_name, p_payload)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('ok', true, 'id', v_template_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- The original T-07 search_exercises took (clinician_id, q, category) only.
-- T-08 adds region/phase/muscle filters, which is a different arg count —
-- CREATE OR REPLACE would create a second overload instead of replacing
-- it, so drop the old signature explicitly first.
DROP FUNCTION IF EXISTS app.search_exercises(UUID, TEXT, TEXT);

-- app.search_exercises(clinician_id, q, category, region, phase_n, muscle)
-- GET /exercises?q=&category=&region=&phase=&muscle= (T-08).
-- region/phase aren't fixed columns on system exercises: the same exercise
-- is legitimately prescribed across different regions and phases (e.g.
-- "Straight Leg Raise" appears in Knee, Thigh, and Tibial-Tuberosity
-- protocols) — see the migration comment on app.exercise's region column.
-- So both filters match via the protocol association (any protocol phase
-- that has ever used this exercise), not a single stored value. A
-- clinic-custom exercise (has its own clinic_id) uses its own `region`
-- column directly instead, since it's created for one clinic's specific use.
-- `muscle` filters ex.muscles, which nothing currently populates for the
-- imported system library (no clinical source for it) — included for
-- clinic-custom exercises, which can set it at creation time.
DROP FUNCTION IF EXISTS app.search_exercises(UUID, TEXT, TEXT, TEXT, INT, TEXT);
CREATE OR REPLACE FUNCTION app.search_exercises(
  p_clinician_id UUID,
  p_query TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_phase_n INT DEFAULT NULL,
  p_muscle TEXT DEFAULT NULL,
  p_protocol_slug TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_result JSONB;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ex.id, 'name', ex.name, 'name_en', ex.name_en, 'category', ex.category,
    'region', ex.region, 'is_bilateral', ex.is_bilateral, 'source', ex.source,
    'protocol_labels', COALESCE(protocols_agg.names, '[]'::jsonb),
    'prescription', rx_agg.rx
  ) ORDER BY ex.name), '[]'::jsonb)
  INTO v_result
  FROM app.exercise ex
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(DISTINCT pr.name) AS names
    FROM app.protocol_phase_exercise ppe
    JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
    JOIN app.protocol pr ON pr.id = pp.protocol_id
    WHERE ppe.exercise_id = ex.id
  ) protocols_agg ON true
  LEFT JOIN LATERAL (
    -- Any one real prescription this exercise has actually been given in
    -- the protocol library — there's no per-exercise default, so this is
    -- honestly "as seen somewhere", not a curated default.
    SELECT ppe.prescription AS rx
    FROM app.protocol_phase_exercise ppe
    WHERE ppe.exercise_id = ex.id AND ppe.prescription IS NOT NULL AND ppe.prescription != '{}'::jsonb
    LIMIT 1
  ) rx_agg ON true
  WHERE ex.is_active
    AND (ex.clinic_id IS NULL OR ex.clinic_id = v_clinic_id)
    AND (p_query IS NULL OR p_query = '' OR ex.name ILIKE '%' || p_query || '%' OR ex.name_en ILIKE '%' || p_query || '%')
    AND (p_category IS NULL OR p_category = '' OR ex.category = p_category)
    AND (p_muscle IS NULL OR p_muscle = '' OR ex.muscles @> ARRAY[p_muscle])
    AND (
      p_region IS NULL OR p_region = ''
      OR ex.region = p_region
      OR EXISTS (
        SELECT 1 FROM app.protocol_phase_exercise ppe
        JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
        JOIN app.protocol pr ON pr.id = pp.protocol_id
        WHERE ppe.exercise_id = ex.id AND (pr.region_en = p_region OR pr.region = p_region)
      )
    )
    AND (
      p_phase_n IS NULL
      OR EXISTS (
        SELECT 1 FROM app.protocol_phase_exercise ppe
        JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
        WHERE ppe.exercise_id = ex.id AND pp.n = p_phase_n
      )
    )
    AND (
      p_protocol_slug IS NULL OR p_protocol_slug = ''
      OR EXISTS (
        SELECT 1 FROM app.protocol_phase_exercise ppe
        JOIN app.protocol_phase pp ON pp.id = ppe.protocol_phase_id
        JOIN app.protocol pr ON pr.id = pp.protocol_id
        WHERE ppe.exercise_id = ex.id AND pr.slug = p_protocol_slug
      )
    )
  LIMIT 200;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- app.exercise_filter_options(clinician_id) — populates the filter
-- dropdowns from real data instead of a hardcoded list, so a region/phase
-- that has no exercises simply doesn't appear as an option.
CREATE OR REPLACE FUNCTION app.exercise_filter_options(p_clinician_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  RETURN jsonb_build_object(
    'categories', (SELECT COALESCE(jsonb_agg(DISTINCT category ORDER BY category), '[]'::jsonb) FROM app.exercise WHERE is_active),
    'regions', (
      SELECT COALESCE(jsonb_agg(DISTINCT region ORDER BY region), '[]'::jsonb)
      FROM (
        SELECT region_en AS region FROM app.protocol WHERE region_en IS NOT NULL
        UNION
        SELECT region FROM app.exercise WHERE clinic_id = v_clinic_id AND region IS NOT NULL
      ) r
    ),
    'phases', (SELECT COALESCE(jsonb_agg(DISTINCT n ORDER BY n), '[]'::jsonb) FROM app.protocol_phase),
    'protocols', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', slug, 'name', name) ORDER BY name), '[]'::jsonb)
      FROM app.protocol WHERE is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
    )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- app.create_custom_exercise(...) — POST /exercises (clinic-scoped, T-08).
CREATE OR REPLACE FUNCTION app.create_custom_exercise(
  p_clinician_id UUID,
  p_name TEXT,
  p_name_en TEXT,
  p_category TEXT,
  p_region TEXT,
  p_description TEXT,
  p_instructions TEXT,
  p_is_bilateral BOOLEAN
) RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_exercise_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  IF p_category NOT IN ('Mobility', 'Strength', 'Balance', 'Control', 'Cardio') THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'invalid_category');
  END IF;

  INSERT INTO app.exercise (clinic_id, name, name_en, category, region, description, instructions, is_bilateral, source)
  VALUES (v_clinic_id, p_name, p_name_en, p_category, p_region, p_description, p_instructions, COALESCE(p_is_bilateral, false), 'clinic')
  RETURNING id INTO v_exercise_id;

  RETURN jsonb_build_object('ok', true, 'id', v_exercise_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- app.duplicate_exercise(...) — POST /exercises/:id/duplicate. Clones any
-- exercise visible to the clinic (system or the clinic's own) into a new
-- clinic-owned row, so the clinician can then edit it independently.
CREATE OR REPLACE FUNCTION app.duplicate_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_clinic_id UUID;
  v_new_id UUID;
BEGIN
  SELECT clinic_id INTO v_clinic_id FROM app."user" WHERE id = p_clinician_id AND role IN ('clinician', 'admin');
  IF v_clinic_id IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  INSERT INTO app.exercise (
    clinic_id, name, name_en, category, region, muscles, equipment,
    description, instructions, common_mistakes, safety_notes, is_bilateral, source
  )
  SELECT
    v_clinic_id, name || ' (עותק)', name_en, category, region, muscles, equipment,
    description, instructions, common_mistakes, safety_notes, is_bilateral, 'clinic'
  FROM app.exercise
  WHERE id = p_exercise_id AND is_active AND (clinic_id IS NULL OR clinic_id = v_clinic_id)
  RETURNING id INTO v_new_id;

  IF v_new_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.resolve_clinic_for_patient(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_clinic_for_session(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.patient_today(UUID, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_plan_for_phase_transition(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.write_phase_transition(TEXT, UUID, INT, INT, TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.write_session_items(TEXT, UUID, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.patient_progress(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.patient_education(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.invite_patient(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_invite(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.accept_patient_invite(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_clinician_schema(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.clinic_patient_summary(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.dashboard_kpis(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_patients(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_open_alerts(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.review_alert(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.patient_overview(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.measure_definitions(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_measurements_for_joint(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.write_measurement(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT[], BOOLEAN, NUMERIC[], TEXT, NUMERIC, TEXT, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_measurement(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.start_assessment_visit(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.save_assessment_visit(UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.get_plan(UUID, UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.save_plan_version(UUID, UUID, INT, INT, JSONB, JSONB, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.recompute_criteria(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_criterion_met(UUID, UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.save_plan_template(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.search_exercises(UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.exercise_filter_options(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.create_custom_exercise(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.duplicate_exercise(UUID, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_clinic_for_patient(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.resolve_clinic_for_session(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patient_today(UUID, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.get_plan_for_phase_transition(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.write_phase_transition(TEXT, UUID, INT, INT, TEXT, UUID, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.write_session_items(TEXT, UUID, JSONB, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patient_progress(UUID, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patient_education(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.invite_patient(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.resolve_invite(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app.accept_patient_invite(TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION app.resolve_clinician_schema(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.clinic_patient_summary(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.dashboard_kpis(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.list_patients(UUID, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.list_open_alerts(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.review_alert(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patient_overview(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.measure_definitions(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.get_measurements_for_joint(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.write_measurement(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, BOOLEAN, BOOLEAN, TEXT[], BOOLEAN, NUMERIC[], TEXT, NUMERIC, TEXT, TEXT, TEXT, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.delete_measurement(UUID, UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.start_assessment_visit(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.save_assessment_visit(UUID, UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.get_plan(UUID, UUID, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.save_plan_version(UUID, UUID, INT, INT, JSONB, JSONB, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.recompute_criteria(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.set_criterion_met(UUID, UUID, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.save_plan_template(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.search_exercises(UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.exercise_filter_options(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.create_custom_exercise(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.duplicate_exercise(UUID, UUID) TO authenticated, service_role;

-- create_clinic_tables(schema)
-- Creates the full CLINIC SCHEMA TEMPLATE table set inside an existing schema.
-- This is the single source of truth for per-clinic table DDL: provision_clinic()
-- calls it for new clinics, and the demo seed calls it for clinic_demo, so the
-- two never drift apart the way hand-copied DDL previously did.
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
  PERFORM create_clinic_tables('clinic_' || v_slug);

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
