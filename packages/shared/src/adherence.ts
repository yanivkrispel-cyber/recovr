// RULES.md §1 — adherence.
//
// Adherence = training days completed / training days planned, over a rolling
// 7-day window.
//   - A day is COMPLETED when it is a planned training day AND the patient
//     logged at least one non-skipped exercise on that day (a partial day
//     counts as completed).
//   - A REST day (one the plan does not schedule) is excluded from both the
//     numerator and the denominator.
//   - Result is an integer percent, rounded half-up; NULL when the window
//     contains no planned day.
//   - The per-day completion_ratio (items done / items planned) is kept for
//     the clinician's detail views only — never the headline number.
//
// The AUTHORITATIVE implementation ships in Postgres:
// `app.adherence_recompute` in supabase/migrations/0007_adherence_engine.sql.
// This module is a literal mirror of that logic so the tricky parts
// (timezone/DST day bucketing, schedule resolution, half-up rounding) have a
// fast, host-independent regression net. Keep the two in lockstep.

export type WeekdayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Patient-local calendar date (`YYYY-MM-DD`) of an instant, DST-aware.
 * Mirrors `(logged_at AT TIME ZONE patient.timezone)::date` in Postgres.
 */
export function localDate(instant: Date | string | number, timeZone: string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  // en-CA renders as YYYY-MM-DD; the timeZone option does the DST-aware shift.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Weekday key of a local `YYYY-MM-DD` date. Mirrors `app.weekday_key()`. */
export function weekdayKey(localYmd: string): WeekdayKey {
  const [y, m, d] = localYmd.split('-').map(Number);
  // Anchor in UTC so the host timezone can't shift the day.
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** The seven local dates ending at (and including) `refYmd`, oldest first. */
export function sevenDayWindow(refYmd: string): string[] {
  const [y, m, d] = refYmd.split('-').map(Number);
  const end = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(end - i * 86_400_000);
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    out.push(`${t.getUTCFullYear()}-${mm}-${dd}`);
  }
  return out;
}

export interface PhaseExercise {
  deleted: boolean;
  /** explicit training weekdays for this exercise, or null when it has none */
  scheduleDays: WeekdayKey[] | null;
}

export interface PhaseSchedule {
  /** non-deleted exercise count in the patient's current phase */
  exerciseCount: number;
  /**
   * Explicit training weekdays across the phase; `null` means "daily" (no
   * exercise pins explicit days), `[]` means nothing is scheduled at all.
   */
  scheduledWeekdays: WeekdayKey[] | null;
}

/** Collapse the current phase's exercises into one schedule. */
export function resolveSchedule(exercises: PhaseExercise[]): PhaseSchedule {
  const live = exercises.filter((e) => !e.deleted);
  if (live.length === 0) return { exerciseCount: 0, scheduledWeekdays: [] };

  const anyExplicit = live.some((e) => e.scheduleDays !== null);
  if (!anyExplicit) return { exerciseCount: live.length, scheduledWeekdays: null };

  const set = new Set<WeekdayKey>();
  for (const e of live) for (const day of e.scheduleDays ?? []) set.add(day);
  return { exerciseCount: live.length, scheduledWeekdays: [...set] };
}

/** Whether `localYmd` is a scheduled training day for this phase. */
export function isPlannedDay(localYmd: string, schedule: PhaseSchedule): boolean {
  if (schedule.exerciseCount === 0) return false;
  if (schedule.scheduledWeekdays === null) return true; // daily
  return schedule.scheduledWeekdays.includes(weekdayKey(localYmd));
}

export interface WindowDay {
  /** local `YYYY-MM-DD` */
  date: string;
  planned: boolean;
  /** non-skipped session_item count logged on this local date */
  itemsDone: number;
}

export interface AdherenceResult {
  /** integer percent, half-up; null when the window has no planned day */
  pct: number | null;
  plannedDays: number;
  completedDays: number;
}

/**
 * Postgres `round()` on numeric is half-away-from-zero; adherence is never
 * negative, so that is half-up.
 */
export function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

/** RULES §1 headline number over a rolling window. */
export function adherence(days: WindowDay[]): AdherenceResult {
  const plannedDays = days.filter((d) => d.planned).length;
  const completedDays = days.filter((d) => d.planned && d.itemsDone > 0).length;
  if (plannedDays === 0) return { pct: null, plannedDays: 0, completedDays };
  return { pct: roundHalfUp((completedDays * 100) / plannedDays), plannedDays, completedDays };
}
