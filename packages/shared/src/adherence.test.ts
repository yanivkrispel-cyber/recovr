import { describe, expect, it } from 'vitest';
import {
  adherence,
  isPlannedDay,
  localDate,
  resolveSchedule,
  roundHalfUp,
  sevenDayWindow,
  weekdayKey,
  type WindowDay,
} from './adherence';

// A rolling 7-day window of "daily" planned days; caller sets itemsDone.
function dailyWindow(refYmd: string, itemsDonePerDay: number[]): WindowDay[] {
  const dates = sevenDayWindow(refYmd);
  return dates.map((date, i) => ({ date, planned: true, itemsDone: itemsDonePerDay[i] ?? 0 }));
}

describe('roundHalfUp', () => {
  it('rounds .5 up', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(12.5)).toBe(13); // 1/8 completed
  });

  it('matches the real adherence fractions', () => {
    expect(roundHalfUp((5 / 7) * 100)).toBe(71); // 71.43
    expect(roundHalfUp((3 / 7) * 100)).toBe(43); // 42.86
    expect(roundHalfUp((1 / 2) * 100)).toBe(50);
  });
});

describe('adherence — RULES §1 scenarios', () => {
  it('no planned days in the window → null (not 0, not a divide error)', () => {
    // Empty phase: resolveSchedule reports zero exercises, so every day is a rest day.
    const schedule = resolveSchedule([]);
    expect(schedule).toEqual({ exerciseCount: 0, scheduledWeekdays: [] });

    const days = sevenDayWindow('2025-06-15').map((date) => ({
      date,
      planned: isPlannedDay(date, schedule),
      itemsDone: 0,
    }));
    expect(days.every((d) => !d.planned)).toBe(true);
    expect(adherence(days)).toEqual({ pct: null, plannedDays: 0, completedDays: 0 });
  });

  it('all planned days skipped → 0%', () => {
    const days = dailyWindow('2025-06-15', [0, 0, 0, 0, 0, 0, 0]);
    expect(adherence(days)).toEqual({ pct: 0, plannedDays: 7, completedDays: 0 });
  });

  it('a partial day counts as a completed day', () => {
    // 3 planned days, each with a single logged exercise out of a 4-exercise
    // phase — every one is "partial", and every one counts.
    const days: WindowDay[] = [
      { date: '2025-06-13', planned: true, itemsDone: 1 },
      { date: '2025-06-14', planned: false, itemsDone: 0 },
      { date: '2025-06-15', planned: true, itemsDone: 1 },
      { date: '2025-06-16', planned: false, itemsDone: 0 },
      { date: '2025-06-17', planned: true, itemsDone: 1 },
      { date: '2025-06-18', planned: false, itemsDone: 0 },
      { date: '2025-06-19', planned: false, itemsDone: 0 },
    ];
    expect(adherence(days)).toEqual({ pct: 100, plannedDays: 3, completedDays: 3 });
  });

  it('mixes planned/rest/partial for a realistic number', () => {
    // 4 planned days, 2 with at least one logged item → 50%.
    const days: WindowDay[] = [
      { date: '2025-06-13', planned: true, itemsDone: 3 }, // full
      { date: '2025-06-14', planned: true, itemsDone: 1 }, // partial — counts
      { date: '2025-06-15', planned: false, itemsDone: 2 }, // rest day — excluded even though logged
      { date: '2025-06-16', planned: true, itemsDone: 0 }, // skipped
      { date: '2025-06-17', planned: true, itemsDone: 0 }, // skipped
      { date: '2025-06-18', planned: false, itemsDone: 0 },
      { date: '2025-06-19', planned: false, itemsDone: 0 },
    ];
    expect(adherence(days)).toEqual({ pct: 50, plannedDays: 4, completedDays: 2 });
  });

  it('rest days never enter the denominator', () => {
    // Mon/Wed/Fri schedule over a window; the other four days must not count.
    const schedule = resolveSchedule([
      { deleted: false, scheduleDays: ['mon', 'wed', 'fri'] },
      { deleted: false, scheduleDays: ['mon'] },
      { deleted: true, scheduleDays: ['sun', 'tue', 'thu', 'sat'] }, // removed — ignored
    ]);
    expect(new Set(schedule.scheduledWeekdays)).toEqual(new Set(['mon', 'wed', 'fri']));

    // 2025-06-16 is a Monday.
    const days = sevenDayWindow('2025-06-22').map((date) => ({
      date,
      planned: isPlannedDay(date, schedule),
      itemsDone: 2, // patient trained every single day
    }));
    // Only Mon/Wed/Fri are planned → 3 planned, 3 completed → 100%, denominator 3 not 7.
    expect(adherence(days)).toEqual({ pct: 100, plannedDays: 3, completedDays: 3 });
  });
});

describe('timezone boundary — day bucketing', () => {
  it('buckets a late-evening instant into the patient-local day', () => {
    // 21:30 UTC on 2025-06-15 is 00:30 on 2025-06-16 in Asia/Jerusalem (UTC+3, summer).
    expect(localDate('2025-06-15T21:30:00Z', 'Asia/Jerusalem')).toBe('2025-06-16');
    // 20:00 UTC the same day is still 23:00 on the 15th, local.
    expect(localDate('2025-06-15T20:00:00Z', 'Asia/Jerusalem')).toBe('2025-06-15');
  });

  it('an item logged near local midnight counts toward the local date, not the UTC date', () => {
    const tz = 'Asia/Jerusalem';
    const loggedAt = '2025-06-15T21:30:00Z'; // → local 2025-06-16
    const window = sevenDayWindow('2025-06-16');
    const bucket = localDate(loggedAt, tz);

    const days: WindowDay[] = window.map((date) => ({
      date,
      planned: true,
      itemsDone: date === bucket ? 1 : 0,
    }));

    expect(bucket).toBe('2025-06-16');
    const res = adherence(days);
    expect(res.completedDays).toBe(1);
    // The completed day is the local one; the UTC calendar day (the 15th) stays empty.
    expect(days.find((d) => d.date === '2025-06-15')?.itemsDone).toBe(0);
  });
});

describe('DST', () => {
  it('the 7-day window is pure calendar arithmetic across a spring-forward', () => {
    // Israel DST 2025 begins 2025-03-28 (clocks 02:00 → 03:00).
    const window = sevenDayWindow('2025-03-30');
    expect(window).toEqual([
      '2025-03-24',
      '2025-03-25',
      '2025-03-26',
      '2025-03-27',
      '2025-03-28',
      '2025-03-29',
      '2025-03-30',
    ]);
    expect(new Set(window).size).toBe(7); // no duplicate or skipped day
  });

  it('localDate stays correct on either side of the DST change', () => {
    const tz = 'Asia/Jerusalem';
    // 23:30 UTC 2025-03-27 → 01:30 local on the 28th (still winter, UTC+2).
    expect(localDate('2025-03-27T23:30:00Z', tz)).toBe('2025-03-28');
    // 00:30 UTC 2025-03-28 → 02:30/03:30 local on the 28th (clocks jump) — still the 28th.
    expect(localDate('2025-03-28T00:30:00Z', tz)).toBe('2025-03-28');
    // 22:30 UTC 2025-03-28 → 01:30 local on the 29th (now summer, UTC+3).
    expect(localDate('2025-03-28T22:30:00Z', tz)).toBe('2025-03-29');
  });

  it('weekdayKey is stable across the DST boundary', () => {
    expect(weekdayKey('2025-03-27')).toBe('thu');
    expect(weekdayKey('2025-03-28')).toBe('fri');
    expect(weekdayKey('2025-03-29')).toBe('sat');
    expect(weekdayKey('2025-03-30')).toBe('sun');
  });
});

describe('resolveSchedule', () => {
  it('treats a phase with no explicit schedule as daily', () => {
    const s = resolveSchedule([
      { deleted: false, scheduleDays: null },
      { deleted: false, scheduleDays: null },
    ]);
    expect(s).toEqual({ exerciseCount: 2, scheduledWeekdays: null });
    expect(isPlannedDay('2025-06-15', s)).toBe(true);
  });

  it('unions explicit weekdays and ignores deleted exercises', () => {
    const s = resolveSchedule([
      { deleted: false, scheduleDays: ['mon', 'wed'] },
      { deleted: false, scheduleDays: ['wed', 'fri'] },
      { deleted: true, scheduleDays: ['sun'] },
    ]);
    expect(new Set(s.scheduledWeekdays)).toEqual(new Set(['mon', 'wed', 'fri']));
    expect(s.exerciseCount).toBe(2);
  });
});
