import { describe, expect, it } from 'vitest';
import {
  addDays,
  canTransition,
  formatTime,
  freeSlots,
  googleCalendarUrl,
  isValidEmail,
  isValidSlug,
  clinicDate,
  normalizePhone,
  SCHEDULING_DEFAULTS,
  suggestSlug,
  validateWeeklyHours,
  weekdayOf,
  weekStart,
  windowsOn,
  zonedTimeToUtc,
  type FreeSlotsInput,
} from './scheduling';

const TZ = 'Asia/Jerusalem';
const at = (date: string, time: string) => zonedTimeToUtc(date, time, TZ);

describe('clinic-timezone date math', () => {
  it('converts Israeli wall-clock time on both sides of DST', () => {
    expect(at('2026-10-06', '09:00').toISOString()).toBe('2026-10-06T06:00:00.000Z'); // IDT, UTC+3
    expect(at('2026-10-26', '09:00').toISOString()).toBe('2026-10-26T07:00:00.000Z'); // IST, UTC+2
    expect(at('2026-01-15', '09:00').toISOString()).toBe('2026-01-15T07:00:00.000Z');
    expect(at('2026-03-29', '09:00').toISOString()).toBe('2026-03-29T06:00:00.000Z'); // after the March switch
  });

  it('puts an instant on its clinic-local date, not the browser’s', () => {
    expect(clinicDate(new Date('2026-10-06T21:30:00Z'), TZ)).toBe('2026-10-07');
    expect(clinicDate('2026-10-06T20:59:00Z', TZ)).toBe('2026-10-06');
  });

  it('walks days and weeks (Sunday-first)', () => {
    expect(weekdayOf('2026-10-06')).toBe(2);
    expect(weekStart('2026-10-06')).toBe('2026-10-04');
    expect(weekStart('2026-10-04')).toBe('2026-10-04');
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('formats times in the clinic timezone', () => {
    expect(formatTime('2026-10-06T06:00:00Z', TZ)).toBe('09:00');
    expect(formatTime('2026-10-26T07:30:00Z', TZ)).toBe('09:30');
  });
});

// Same scenarios as supabase/tests/scheduling.test.sql.
describe('freeSlots (mirror of app._sched_free_slots)', () => {
  const D = '2026-10-09';
  const rules = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, start_time: '08:00', end_time: '12:00' },
    { weekday, start_time: '14:00', end_time: '18:00' },
  ]);
  const base: FreeSlotsInput = {
    rules,
    busy: [],
    timeOff: [],
    durationMin: 60,
    from: D,
    to: D,
    settings: SCHEDULING_DEFAULTS,
    tz: TZ,
    now: at('2026-10-06', '12:00'),
  };
  const morning = (slots: Date[]) => slots.filter((s) => s < at(D, '12:00')).map((s) => formatTime(s, TZ));

  it('offers every start on the 30-min grid whose whole hour fits a window', () => {
    const slots = freeSlots(base);
    expect(slots).toHaveLength(14);
    expect(formatTime(slots[0], TZ)).toBe('08:00');
    expect(morning(slots)).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('skips starts that would overlap a live appointment', () => {
    const busy = [{ starts_at: at(D, '09:00'), ends_at: at(D, '09:45') }];
    expect(morning(freeSlots({ ...base, busy }))).toEqual(['08:00', '10:00', '10:30', '11:00']);
  });

  it('keeps the buffer clear on both sides', () => {
    const busy = [{ starts_at: at(D, '09:00'), ends_at: at(D, '09:45') }];
    const settings = { ...SCHEDULING_DEFAULTS, buffer_min: 15 };
    expect(morning(freeSlots({ ...base, busy, settings }))).toEqual(['10:00', '10:30', '11:00']);
  });

  it('skips blocked time', () => {
    const busy = [{ starts_at: at(D, '09:00'), ends_at: at(D, '09:45') }];
    const timeOff = [{ starts_at: at(D, '10:00'), ends_at: at(D, '11:00') }];
    expect(morning(freeSlots({ ...base, busy, timeOff }))).toEqual(['08:00', '11:00']);
  });

  it('honours minimum notice', () => {
    const slots = freeSlots({ ...base, now: at(D, '07:30') });
    expect(morning(slots)).toEqual(['10:30', '11:00']);
  });

  it('never offers past the horizon', () => {
    const settings = { ...SCHEDULING_DEFAULTS, horizon_days: 2 };
    expect(freeSlots({ ...base, settings })).toEqual([]);
  });

  it('uses the post-DST offset on the night the clocks go back', () => {
    const slots = freeSlots({
      ...base,
      rules: [{ weekday: 0, start_time: '08:00', end_time: '10:00' }],
      from: '2026-10-25',
      to: '2026-10-25',
      now: at('2026-10-20', '12:00'),
    });
    expect(slots.map((s) => s.toISOString())).toEqual(['2026-10-25T06:00:00.000Z', '2026-10-25T06:30:00.000Z', '2026-10-25T07:00:00.000Z']);
  });

  it('lists a day’s working windows in order', () => {
    expect(windowsOn(rules, D)).toEqual([
      { start: 480, end: 720 },
      { start: 840, end: 1080 },
    ]);
  });
});

describe('validation (mirrors the database)', () => {
  it('weekly hours', () => {
    expect(validateWeeklyHours([{ weekday: 1, start_time: '08:00', end_time: '12:00' }])).toBeNull();
    expect(
      validateWeeklyHours([
        { weekday: 1, start_time: '08:00', end_time: '12:00' },
        { weekday: 1, start_time: '11:00', end_time: '13:00' },
      ]),
    ).toBe('overlap');
    expect(
      validateWeeklyHours([
        { weekday: 1, start_time: '08:00', end_time: '12:00' },
        { weekday: 2, start_time: '11:00', end_time: '13:00' },
      ]),
    ).toBeNull();
    expect(validateWeeklyHours([{ weekday: 1, start_time: '08:07', end_time: '12:00' }])).toBe('invalid');
    expect(validateWeeklyHours([{ weekday: 1, start_time: '12:00', end_time: '08:00' }])).toBe('invalid');
    expect(validateWeeklyHours([{ weekday: 7, start_time: '08:00', end_time: '12:00' }])).toBe('invalid');
  });

  it('phone numbers normalise to what the database stores', () => {
    expect(normalizePhone('050-123 4567')).toBe('0501234567');
    expect(normalizePhone('+972 50-123-4567')).toBe('+972501234567');
    expect(normalizePhone('(03) 1234')).toBeNull();
  });

  it('e-mail', () => {
    expect(isValidEmail(' noa@example.co.il ')).toBe(true);
    expect(isValidEmail('noa@example')).toBe(false);
  });

  it('public booking address', () => {
    expect(isValidSlug('krispel')).toBe(true);
    expect(isValidSlug('-krispel')).toBe(false);
    expect(isValidSlug('Krispel')).toBe(false);
    expect(suggestSlug('Krispel Physio & Rehab')).toBe('krispel-physio-rehab');
    expect(suggestSlug('קליניקה')).toBe('');
  });

  it('status transitions', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('pending', 'attended')).toBe(false);
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('cancelled', 'confirmed')).toBe(true);
    expect(canTransition('expired', 'confirmed')).toBe(false);
  });
});

describe('add to calendar', () => {
  it('builds a Google Calendar template link in UTC', () => {
    const url = new URL(
      googleCalendarUrl({ title: 'טיפול', start: new Date('2026-10-06T06:00:00Z'), end: new Date('2026-10-06T06:45:00Z'), location: 'תל אביב' }),
    );
    expect(url.searchParams.get('dates')).toBe('20261006T060000Z/20261006T064500Z');
    expect(url.searchParams.get('text')).toBe('טיפול');
    expect(url.searchParams.get('location')).toBe('תל אביב');
  });
});
