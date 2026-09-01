import { describe, expect, it } from 'vitest';
import { DEDUPE, dedupeKey, isoWeek, shouldFire, type ExistingAlert } from './alerts';
import type { AlertType } from './types';

const NOW = '2026-09-01T12:00:00Z';
const ROLLING_TYPES: AlertType[] = ['adherence_drop', 'pain_spike', 'inactive', 'assessment_overdue'];

function priorAt(type: AlertType, iso: string, state: ExistingAlert['state'] = 'open', phaseN?: number): ExistingAlert {
  return { type, state, createdAt: iso, phaseN };
}

// hours -> an ISO timestamp that many hours before NOW
function hoursBefore(h: number): string {
  return new Date(new Date(NOW).getTime() - h * 3_600_000).toISOString();
}

describe('Q-07 — alert dedupe, all five types', () => {
  it('fires when the patient has no prior alert of that type', () => {
    for (const type of Object.keys(DEDUPE) as AlertType[]) {
      expect(shouldFire(type, [], NOW, { phaseN: 2 })).toBe(true);
    }
  });

  describe.each(ROLLING_TYPES)('%s (rolling window)', (type) => {
    const rule = DEDUPE[type];
    if (rule.kind !== 'rolling') throw new Error('expected rolling');
    const windowH = rule.hours;

    it('a second fire inside the window is suppressed', () => {
      const prior = [priorAt(type, hoursBefore(windowH / 2))];
      expect(shouldFire(type, prior, NOW)).toBe(false);
    });

    it('a reviewed alert inside the window still suppresses a re-fire', () => {
      const prior = [priorAt(type, hoursBefore(1), 'reviewed')];
      expect(shouldFire(type, prior, NOW)).toBe(false);
    });

    it('an auto_closed alert inside the window still suppresses a re-fire', () => {
      const prior = [priorAt(type, hoursBefore(1), 'auto_closed')];
      expect(shouldFire(type, prior, NOW)).toBe(false);
    });

    it('fires again once the window has passed', () => {
      const prior = [priorAt(type, hoursBefore(windowH + 1), 'reviewed')];
      expect(shouldFire(type, prior, NOW)).toBe(true);
    });

    it('ignores prior alerts of other types', () => {
      const other = ROLLING_TYPES.find((t) => t !== type)!;
      const prior = [priorAt(other, hoursBefore(1))];
      expect(shouldFire(type, prior, NOW)).toBe(true);
    });
  });

  describe('ready_for_advance (once per phase)', () => {
    it('does not re-fire for a phase it already fired for', () => {
      const prior = [priorAt('ready_for_advance', hoursBefore(1000), 'reviewed', 2)];
      expect(shouldFire('ready_for_advance', prior, NOW, { phaseN: 2 })).toBe(false);
    });

    it('fires again for the next phase', () => {
      const prior = [priorAt('ready_for_advance', hoursBefore(1000), 'reviewed', 2)];
      expect(shouldFire('ready_for_advance', prior, NOW, { phaseN: 3 })).toBe(true);
    });

    it('a very old alert for the same phase still suppresses (no time window)', () => {
      const prior = [priorAt('ready_for_advance', '2020-01-01T00:00:00Z', 'auto_closed', 1)];
      expect(shouldFire('ready_for_advance', prior, NOW, { phaseN: 1 })).toBe(false);
    });
  });
});

describe('dedupeKey', () => {
  it('buckets weekly types by ISO week and pain_spike by day', () => {
    expect(dedupeKey('adherence_drop', 'p1', NOW)).toBe(`adherence_drop:p1:${isoWeek(NOW)}`);
    expect(dedupeKey('inactive', 'p1', NOW)).toBe(`inactive:p1:${isoWeek(NOW)}`);
    expect(dedupeKey('pain_spike', 'p1', NOW)).toBe('pain_spike:p1:2026-09-01');
    expect(dedupeKey('ready_for_advance', 'p1', NOW, { phaseN: 4 })).toBe('ready_for_advance:p1:phase4');
  });

  it('two instants in the same ISO week share a weekly key', () => {
    expect(isoWeek('2026-08-31T00:00:00Z')).toBe(isoWeek('2026-09-04T00:00:00Z')); // Mon–Fri, same week
    expect(isoWeek('2026-09-06T00:00:00Z')).not.toBe(isoWeek('2026-09-07T00:00:00Z')); // Sun vs next Mon
  });
});
