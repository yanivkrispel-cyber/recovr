// Shared types derived from DATA_MODEL.md

export type UUID = string; // UUIDv7

export type Role = 'clinician' | 'admin' | 'patient';
export type PatientStatus = 'invited' | 'active' | 'paused' | 'discharged';
export type SessionStatus = 'planned' | 'partial' | 'completed' | 'skipped';
export type AlertState = 'open' | 'reviewed' | 'auto_closed';
export type AlertType =
  | 'adherence_drop'
  | 'pain_spike'
  | 'ready_for_advance'
  | 'inactive'
  | 'assessment_overdue';
export type CriterionType = 'time' | 'pain' | 'rom' | 'strength' | 'assessment' | 'manual';
export type CriterionOperator = 'gte' | 'lte' | 'eq';

// Canonical clinical body-region taxonomy (T-28) — replaces the free-text
// region/region_en that used to live directly on exercise/protocol.
export interface BodyRegion {
  id: UUID;
  slug: string;
  name: string;
  name_en: string;
}

export interface Clinic {
  id: UUID;
  name: string;
  timezone: string;
  locale: string;
  retention_years: number;
  settings: Record<string, unknown>;
}

export interface User {
  id: UUID;
  clinic_id: UUID;
  role: Role;
  name: string;
  email: string;
  phone?: string;
  last_login_at?: string;
  status: 'active' | 'paused';
}

export interface Patient {
  id: UUID;
  clinic_id: UUID;
  primary_clinician_id: UUID;
  name: string;
  name_en?: string;
  birth_date: string;
  sex?: 'M' | 'F' | 'X';
  phone?: string;
  email?: string;
  sport?: string;
  position?: string;
  status: PatientStatus;
  consent_version?: string;
  consent_at?: string;
  locale: string;
  timezone: string;
  activated_at?: string;
  discharged_at?: string;
}

export interface Plan {
  id: UUID;
  patient_id: UUID;
  protocol_id: UUID;
  started_at: string;
  current_phase_n: number;
  status: 'active' | 'completed' | 'abandoned';
}

export interface PlanVersion {
  id: UUID;
  plan_id: UUID;
  version: number;
  created_by: UUID;
  created_at: string;
  note?: string;
  is_current: boolean;
}

export interface PlanExercise {
  id: UUID;
  plan_phase_id: UUID;
  exercise_id: UUID;
  sets?: number;
  reps?: number;
  load?: number;
  load_unit?: string;
  tempo?: string;
  hold_sec?: number;
  rest_sec?: number;
  side?: 'left' | 'right' | 'bilateral';
  frequency_days_per_week?: number;
  order: number;
  clinician_note?: string;
  removed_reason?: string;
  source: 'protocol' | 'added' | 'modified';
}

export interface PlanCriterion {
  id: UUID;
  plan_phase_id: UUID;
  type: CriterionType;
  label: string;
  label_en?: string;
  operator: CriterionOperator;
  value: number;
  unit?: string;
  order: number;
  is_met: boolean;
  met_at?: string;
}

export interface Session {
  id: UUID;
  patient_id: UUID;
  plan_version_id: UUID;
  date: string; // patient-local YYYY-MM-DD
  status: SessionStatus;
  skipped_reason?: string;
  completed_at?: string;
  items_planned: number;
  items_done: number;
  completion_ratio: number;
  max_pain?: number;
  avg_difficulty?: 'easy' | 'medium' | 'hard';
  note?: string;
}

export interface SessionItem {
  id: UUID; // client-generated UUIDv7
  session_id: UUID;
  plan_exercise_id: UUID;
  sets_done?: number;
  reps_done?: number;
  load_used?: number;
  pain_score?: number; // 0–10
  difficulty?: 'easy' | 'medium' | 'hard';
  skipped: boolean;
  skip_reason?: string;
  note?: string;
  logged_at: string;
  synced_at?: string;
}

export interface AdherenceDaily {
  patient_id: UUID;
  date: string;
  planned: boolean;
  completed: boolean;
  completion_ratio: number;
}

export interface Measurement {
  id: UUID;
  patient_id: UUID;
  type: 'pain' | 'rom' | 'strength' | 'girth' | 'functional_test';
  key: string;
  value: number;
  unit: string;
  side?: 'left' | 'right' | 'bilateral';
  measured_at: string;
  measured_by: 'clinician' | 'patient';
  source_note?: string;
}

// ROM-specific measurement (extends Measurement)
export interface ROMMeasurement {
  id: UUID;
  patient_id: UUID;
  measure_code: string; // e.g. 'ank_wblt', 'knee_h2b'
  side: 'involved' | 'healthy' | 'bilateral';
  value: number;
  value_secondary?: number; // WBLT tibial angle
  pass?: boolean;
  compensations?: string[];
  attempts?: number[]; // 3-attempt goniometric
  governing_source: 'best' | 'avg' | 'attempt_n' | 'single';
  pain?: number;
  end_feel?: 'soft' | 'hard';
  swelling?: 'none' | 'mild' | 'moderate' | 'severe';
  note?: string;
  visit_id?: UUID;
  measured_by: UUID;
  measured_at: string;
  superseded_by?: UUID;
}

export interface PhaseTransition {
  id: UUID;
  plan_id: UUID;
  from_phase_n: number;
  to_phase_n: number;
  direction: 'forward' | 'back';
  approved_by: UUID;
  approved_at: string;
  criteria_snapshot: unknown;
  override_reason?: string;
}

export interface Alert {
  id: UUID;
  patient_id: UUID;
  clinic_id: UUID;
  type: AlertType;
  severity: 'low' | 'medium' | 'high';
  payload: Record<string, unknown>;
  state: AlertState;
  reviewed_by?: UUID;
  reviewed_at?: string;
  dedupe_key: string;
  created_at: string;
}

export interface AuditLog {
  id: UUID;
  actor_type: 'clinician' | 'patient' | 'admin' | 'system';
  actor_id?: UUID;
  action: string;
  entity_type: string;
  entity_id: UUID;
  ip?: string;
  user_agent?: string;
  at: string;
}
