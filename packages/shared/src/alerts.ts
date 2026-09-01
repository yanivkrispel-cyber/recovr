// RULES.md §4 — clinician alerts.
//
// | type                | condition                                             | dedupe                                  |
// |---------------------|-------------------------------------------------------|-----------------------------------------|
// | adherence_drop      | 7-day adherence < clinic threshold                    | 1 / patient / 7 days                     |
// | pain_spike          | reported pain >= 6/10, or +3 over the 14-day mean     | 1 / patient / 24h                        |
// | ready_for_advance   | all current-phase criteria met                        | once per phase                          |
// | inactive            | no session for 4+ consecutive planned days            | 1 / patient / 7 days                     |
// | assessment_overdue  | a scheduled measurement is > 7 days late              | 1 / patient / 7 days                     |
//
// Alerts are computed server-side only (CLAUDE.md). State machine:
// open -> reviewed (clinician acted) -> auto_closed (condition resolved).
//
// The condition detection lives in Postgres (`app.alerts_recompute` in
// supabase/migrations/0008_alerts_engine.sql). This module mirrors the DEDUPE
// decision — the part QA Q-07 pins down ("fire twice in-window -> one alert;
// review -> no re-fire in-window") — as a pure function with unit tests.
// `app.alert_should_fire` implements the identical rule; keep them in sync.

import type { AlertState, AlertType } from './types';

export type DedupeRule =
  | { kind: 'rolling'; hours: number }
  | { kind: 'per_phase' };

/** RULES §4 dedupe windows, by type. */
export const DEDUPE: Record<AlertType, DedupeRule> = {
  adherence_drop: { kind: 'rolling', hours: 24 * 7 },
  pain_spike: { kind: 'rolling', hours: 24 },
  inactive: { kind: 'rolling', hours: 24 * 7 },
  assessment_overdue: { kind: 'rolling', hours: 24 * 7 },
  ready_for_advance: { kind: 'per_phase' },
};

export interface ExistingAlert {
  type: AlertType;
  state: AlertState;
  /** ISO timestamp the alert was created */
  createdAt: string | number | Date;
  /** current-phase number at creation — only set for ready_for_advance */
  phaseN?: number;
}

/**
 * Whether a fresh alert of `type` should be created now, given the patient's
 * prior alerts of that type. A prior alert in ANY state (open, reviewed,
 * auto_closed) suppresses a re-fire while it is still inside the dedupe window
 * — so marking one reviewed does not let it immediately re-fire, and a
 * resolved-then-recurring condition still waits out the window.
 *
 * Mirrors `app.alert_should_fire`.
 */
export function shouldFire(
  type: AlertType,
  priorAlerts: ExistingAlert[],
  now: string | number | Date,
  ctx: { phaseN?: number } = {},
): boolean {
  const mine = priorAlerts.filter((a) => a.type === type);
  const rule = DEDUPE[type];

  if (rule.kind === 'per_phase') {
    return !mine.some((a) => a.phaseN === ctx.phaseN);
  }

  const cutoff = new Date(now).getTime() - rule.hours * 3_600_000;
  return !mine.some((a) => new Date(a.createdAt).getTime() > cutoff);
}

/** ISO week key, e.g. `2026-W36`. */
export function isoWeek(d: string | number | Date): string {
  const date = new Date(d);
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of this week decides the ISO year and week number.
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` in UTC. */
export function isoDate(d: string | number | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Human-readable, traceable dedupe key for the `alert.dedupe_key` column. The
 * real suppression is `shouldFire` / `app.alert_should_fire`; this key is for
 * the partial index and for debugging.
 */
export function dedupeKey(
  type: AlertType,
  patientId: string,
  now: string | number | Date,
  ctx: { phaseN?: number } = {},
): string {
  if (type === 'ready_for_advance') return `${type}:${patientId}:phase${ctx.phaseN}`;
  if (type === 'pain_spike') return `${type}:${patientId}:${isoDate(now)}`;
  return `${type}:${patientId}:${isoWeek(now)}`;
}
