// M6 scheduling (T-34 / T-35) — shared types, clinic-timezone date math and
// the client-side mirrors of the scheduling rules.
//
// The database is authoritative (supabase/migrations/0062_scheduling.sql):
//   - freeSlots()          mirrors app._sched_free_slots
//   - SCHEDULING_DEFAULTS  mirrors app.scheduling_settings
//   - STATUS_TRANSITIONS   mirrors app.appointment_update
//   - validateWeeklyHours  mirrors app.availability_save
// Keep them in step; scheduling.test.ts pins the shared cases.

// --- domain types -----------------------------------------------------------

export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'attended'
  | 'no_show'
  | 'cancelled'
  | 'declined'
  | 'expired';

export type AppointmentSource = 'clinician' | 'patient_app' | 'public';
export type WhoMayBook = 'anyone' | 'existing' | 'clinician_only';
export type Confirmation = 'manual' | 'auto';
export type TypeColor = 'navy' | 'gold' | 'green' | 'clay' | 'slate';

export const TYPE_COLORS: readonly TypeColor[] = ['navy', 'gold', 'green', 'clay', 'slate'];

/** Statuses that occupy the calendar (the exclusion constraint's set). */
export const LIVE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed', 'attended', 'no_show'];

export function isLive(status: AppointmentStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

export interface AppointmentType {
  id: string;
  name: string;
  name_en: string | null;
  description: string | null;
  duration_min: number;
  price_label: string | null;
  color: TypeColor;
  who_may_book: WhoMayBook;
  confirmation: Confirmation;
  active: boolean;
  sort: number;
}

export interface WeeklyHoursRule {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** HH:MM, clinic-local */
  start_time: string;
  end_time: string;
}

export interface AvailabilityRule extends WeeklyHoursRule {
  id: string;
  practitioner_id: string;
}

export interface SchedulingSettings {
  booking_enabled: boolean;
  practitioner_id: string | null;
  slot_step_min: number;
  buffer_min: number;
  min_notice_min: number;
  horizon_days: number;
  free_cancel_hours: number;
  contact_address: string;
  contact_phone: string;
}

export const SCHEDULING_DEFAULTS: SchedulingSettings = {
  booking_enabled: false,
  practitioner_id: null,
  slot_step_min: 30,
  buffer_min: 0,
  min_notice_min: 180,
  horizon_days: 42,
  free_cancel_hours: 24,
  contact_address: '',
  contact_phone: '',
};

export const SLOT_STEP_OPTIONS = [10, 15, 20, 30, 60] as const;
export const BUFFER_OPTIONS = [0, 5, 10, 15, 20, 30] as const;
export const MIN_NOTICE_OPTIONS = [0, 60, 120, 180, 360, 720, 1440, 2880] as const;
export const HORIZON_OPTIONS = [7, 14, 21, 28, 42, 60, 90] as const;
export const FREE_CANCEL_OPTIONS = [0, 2, 6, 12, 24, 48] as const;

export interface PractitionerRef {
  id: string;
  name: string;
  role: string;
}

/** GET scheduling/setup */
export interface SchedulingSetup {
  me: string;
  role: 'clinician' | 'admin';
  timezone: string;
  clinic_name: string;
  booking_slug: string | null;
  /** the public page's full address (server-built, per deployment) */
  booking_url: string | null;
  settings: SchedulingSettings;
  practitioners: PractitionerRef[];
  types: AppointmentType[];
  availability: AvailabilityRule[];
}

export interface CalendarAppointment {
  id: string;
  practitioner_id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  cancelled_by: 'clinician' | 'patient' | 'system' | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  type: { id: string; name: string; color: TypeColor; duration_min: number };
  patient: { id: string; name: string; status: string } | null;
  /** A website visitor who has no patient card yet (or just got one). */
  lead: {
    request_id: string;
    name: string;
    phone: string;
    email: string;
    patient_id: string | null;
    body_region: { id: string; name: string } | null;
  } | null;
  /** Current phase and server-computed 7-day adherence (RULES §1) — the
   *  low-adherence flag is the server's, against the clinic's threshold. */
  clinical?: {
    phase_n: number | null;
    phase_name: string | null;
    adherence: number | null;
    low_adherence: boolean;
  } | null;
  /** Only on booking-request rows: existing patients that look like the visitor. */
  matches?: { id: string; name: string; status: string }[];
}

export interface TimeOff {
  id: string;
  practitioner_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

/** GET scheduling/calendar */
export interface CalendarRange {
  timezone: string;
  appointments: CalendarAppointment[];
  time_off: TimeOff[];
  pending_count: number;
}

export interface CalendarConflicts {
  appointments: { id: string; starts_at: string; ends_at: string; status: AppointmentStatus; name: string | null }[];
  time_off: { id: string; starts_at: string; ends_at: string; reason: string | null }[];
}

/** What a patient (app or manage link) sees of an appointment. */
export interface PatientAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  type: { id: string; name: string; duration_min: number };
  can_cancel: boolean;
}

export interface ClinicContact {
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  booking_slug: string | null;
}

export interface BookableType {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_label: string | null;
  confirmation?: Confirmation;
}

/** GET me-appointments */
export interface MyAppointments {
  timezone: string;
  clinic: ClinicContact;
  free_cancel_hours: number;
  horizon_days: number;
  upcoming: PatientAppointment[];
  past: PatientAppointment[];
  types: BookableType[];
}

/** GET public-booking/:slug */
export interface PublicBookingProfile {
  clinic: ClinicContact;
  settings: { horizon_days: number; min_notice_min: number; free_cancel_hours: number };
  types: BookableType[];
  body_regions: { id: string; name: string }[];
}

// --- status transitions -----------------------------------------------------

/** What app.appointment_update lets the clinician move a status to. */
export const STATUS_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  pending: ['confirmed', 'declined'],
  confirmed: ['cancelled', 'attended', 'no_show'],
  attended: ['confirmed'],
  no_show: ['confirmed'],
  cancelled: ['confirmed'],
  declined: ['confirmed'],
  expired: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

// --- validation -------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** A suggested public address from a clinic name (Latin letters/digits only). */
export function suggestSlug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return isValidSlug(s) ? s : '';
}

/** Digits with an optional leading +, as booking_request.phone stores it;
 *  null when it can't be a phone number. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  const out = (plus ? '+' : '') + digits;
  return /^\+?[0-9]{9,15}$/.test(out) ? out : null;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmail(raw: string): boolean {
  const e = raw.trim();
  return e.length <= 254 && EMAIL_PATTERN.test(e);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Weekly hours as app.availability_save accepts them: HH:MM on 5-minute
 * marks, end after start, weekday 0–6, no two windows overlapping on a day.
 */
export function validateWeeklyHours(rules: WeeklyHoursRule[]): 'invalid' | 'overlap' | null {
  if (rules.length > 42) return 'invalid';
  for (const r of rules) {
    const s = minutesOf(r.start_time);
    const e = minutesOf(r.end_time);
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return 'invalid';
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s || s % 5 !== 0 || e % 5 !== 0) return 'invalid';
  }
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      if (a.weekday !== b.weekday) continue;
      if (minutesOf(a.start_time) < minutesOf(b.end_time) && minutesOf(b.start_time) < minutesOf(a.end_time)) {
        return 'overlap';
      }
    }
  }
  return null;
}

// --- clinic-timezone date math ----------------------------------------------
//
// Calendar days are clinic-local (`YYYY-MM-DD`), whatever timezone the
// browser happens to be in — the same days the database computes slots on.

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
  /** YYYY-MM-DD */
  date: string;
  /** minutes past local midnight */
  minutes: number;
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAY_SHORT.indexOf(get('weekday')),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minutes: hour * 60 + minute,
  };
}

function offsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Clinic-local wall-clock time → the instant. */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const mins = minutesOf(time);
  const wallAsUtc = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  // Guess with the offset at the wall time, then correct with the offset at
  // the guess — right on both sides of a DST change.
  const first = wallAsUtc - offsetMs(new Date(wallAsUtc), tz);
  return new Date(wallAsUtc - offsetMs(new Date(first), tz));
}

/** The clinic-local calendar date of an instant. */
export function clinicDate(instant: Date | string, tz: string): string {
  return zonedParts(typeof instant === 'string' ? new Date(instant) : instant, tz).date;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The Sunday that starts `date`'s week (Israeli week). */
export function weekStart(date: string): string {
  return addDays(date, -weekdayOf(date));
}

export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

// --- Hebrew formatting (clinic timezone) --------------------------------------

export function formatTime(instant: Date | string, tz: string): string {
  const p = zonedParts(typeof instant === 'string' ? new Date(instant) : instant, tz);
  return hhmm(p.minutes);
}

export function formatDayLong(instant: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(
    typeof instant === 'string' ? new Date(instant) : instant,
  );
}

export function formatDayShort(instant: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric' }).format(
    typeof instant === 'string' ? new Date(instant) : instant,
  );
}

/** A local date (YYYY-MM-DD) formatted without a timezone shift. */
export function formatLocalDate(date: string, style: 'long' | 'short' = 'long'): string {
  const noonUtc = zonedTimeToUtc(date, '12:00', 'UTC');
  return style === 'long' ? formatDayLong(noonUtc, 'UTC') : formatDayShort(noonUtc, 'UTC');
}

// --- free slots (mirror of app._sched_free_slots) ----------------------------

interface Interval {
  starts_at: string | Date;
  ends_at: string | Date;
}

export interface FreeSlotsInput {
  rules: WeeklyHoursRule[];
  /** live appointments of the practitioner */
  busy: Interval[];
  timeOff: Interval[];
  durationMin: number;
  /** clinic-local dates, inclusive */
  from: string;
  to: string;
  settings: Pick<SchedulingSettings, 'slot_step_min' | 'buffer_min' | 'min_notice_min' | 'horizon_days'>;
  tz: string;
  now: Date;
}

const ms = (v: string | Date) => (typeof v === 'string' ? Date.parse(v) : v.getTime());

/**
 * Start times a patient may book: on each working window's step grid, the
 * whole appointment inside the window, at least min_notice from now, within
 * the horizon, buffer_min clear of live appointments and clear of blocked
 * time.
 */
export function freeSlots(input: FreeSlotsInput): Date[] {
  const { rules, busy, timeOff, durationMin, settings, tz, now } = input;
  if (durationMin <= 0 || settings.slot_step_min <= 0) return [];
  const today = clinicDate(now, tz);
  const from = input.from > today ? input.from : today;
  const horizonEnd = addDays(today, settings.horizon_days);
  const to = input.to < horizonEnd ? input.to : horizonEnd;
  if (to < from) return [];

  const dur = durationMin * 60_000;
  const step = settings.slot_step_min * 60_000;
  const buffer = settings.buffer_min * 60_000;
  const earliest = now.getTime() + settings.min_notice_min * 60_000;

  const starts = new Set<number>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const wd = weekdayOf(day);
    for (const r of rules) {
      if (r.weekday !== wd) continue;
      const ws = zonedTimeToUtc(day, r.start_time, tz).getTime();
      const we = zonedTimeToUtc(day, r.end_time, tz).getTime();
      for (let s = ws; s + dur <= we; s += step) starts.add(s);
    }
  }

  return [...starts]
    .filter((s) => {
      const e = s + dur;
      if (s < earliest) return false;
      if (busy.some((b) => ms(b.starts_at) < e + buffer && ms(b.ends_at) > s - buffer)) return false;
      if (timeOff.some((t) => ms(t.starts_at) < e && ms(t.ends_at) > s)) return false;
      return true;
    })
    .sort((a, b) => a - b)
    .map((s) => new Date(s));
}

/** Working windows of one clinic-local day, in minutes past midnight. */
export function windowsOn(rules: WeeklyHoursRule[], date: string): { start: number; end: number }[] {
  const wd = weekdayOf(date);
  return rules
    .filter((r) => r.weekday === wd)
    .map((r) => ({ start: minutesOf(r.start_time), end: minutesOf(r.end_time) }))
    .sort((a, b) => a.start - b.start);
}

// --- add to calendar ------------------------------------------------------------

function gcalStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** A Google Calendar "add event" link. */
export function googleCalendarUrl(e: { title: string; start: Date; end: Date; location?: string | null; details?: string | null }): string {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${gcalStamp(e.start)}/${gcalStamp(e.end)}`,
  });
  if (e.location) q.set('location', e.location);
  if (e.details) q.set('details', e.details);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
