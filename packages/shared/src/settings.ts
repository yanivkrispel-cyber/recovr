// RULES.md §1 / T-20 — clinic settings.
//
// Validation mirrors app.update_clinic_settings in
// supabase/migrations/0011_settings.sql. Keep the two in sync.

import type { AlertType } from './types';

export const ADHERENCE_THRESHOLD = { min: 50, max: 95, step: 5, default: 70 } as const;
export const ASSESSMENT_INTERVAL = { min: 7, max: 180, default: 14 } as const;

export type Units = 'metric' | 'imperial';
export const UNITS: readonly Units[] = ['metric', 'imperial'];

/** Alert types a clinic can toggle. pain_spike is deliberately absent — it is
 *  never disableable (RULES §5). */
export const TOGGLEABLE_ALERTS: readonly Exclude<AlertType, 'pain_spike'>[] = [
  'adherence_drop',
  'ready_for_advance',
  'inactive',
  'assessment_overdue',
];

export interface ClinicSettings {
  adherence_threshold: number;
  units: Units;
  assessment_interval_days: number;
  alerts: Record<AlertType, boolean>;
  weekly_digest: boolean;
}

export function isValidThreshold(n: number): boolean {
  return (
    Number.isInteger(n) &&
    n >= ADHERENCE_THRESHOLD.min &&
    n <= ADHERENCE_THRESHOLD.max &&
    n % ADHERENCE_THRESHOLD.step === 0
  );
}

/** Snap an arbitrary number to the nearest valid threshold. */
export function clampThreshold(n: number): number {
  const { min, max, step } = ADHERENCE_THRESHOLD;
  const snapped = Math.round(n / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

export function isValidInterval(n: number): boolean {
  return Number.isInteger(n) && n >= ASSESSMENT_INTERVAL.min && n <= ASSESSMENT_INTERVAL.max;
}

export function isValidUnits(u: string): u is Units {
  return (UNITS as readonly string[]).includes(u);
}

/** The threshold options a select/slider should offer: 50, 55, … 95. */
export function thresholdOptions(): number[] {
  const out: number[] = [];
  for (let n = ADHERENCE_THRESHOLD.min; n <= ADHERENCE_THRESHOLD.max; n += ADHERENCE_THRESHOLD.step) {
    out.push(n);
  }
  return out;
}
