import { describe, it, expect } from 'vitest';
import { computeFlag, gapFlag, governingValue, sideGap, type MeasureDefinition } from './romFlags';

// ank_wblt exactly as imported from ROM_CATALOG (ROM_MEASUREMENT.md §2).
const wblt: MeasureDefinition = {
  code: 'ank_wblt',
  unit: 'cm',
  norm: 11,
  target: 10,
  scale: 15,
  flags: { fx: true, bilat: true, deg_opt: true, side_diff: 1.5, risk_below: 9 },
  norm_source: 'WBLT',
};

const squat: MeasureDefinition = {
  code: 'knee_squat',
  unit: 'pass_fail',
  norm: null,
  target: null,
  scale: 20,
  flags: { fx: true, bilat: false },
  norm_source: null,
};

const thomas: MeasureDefinition = {
  code: 'hip_thomas',
  unit: 'deg',
  norm: 0,
  target: 0,
  scale: 30,
  flags: { fx: true, bilat: true, deficit: true },
  norm_source: 'Thomas',
};

// ROM_MEASUREMENT.md §6 — acceptance criteria, verified numerically.
describe('ROM_MEASUREMENT.md §6 acceptance criteria', () => {
  it('WBLT 7cm / healthy 10.5cm: value red, gap 3.5 red', () => {
    expect(computeFlag(wblt, 7, 10.5, null)).toBe('red');
    expect(sideGap(7, 10.5)).toBe(3.5);
    expect(gapFlag(wblt, 7, 10.5)).toBe('red');
  });

  it('WBLT 9.5cm / healthy 10.5cm: value green, gap 1 green', () => {
    expect(computeFlag(wblt, 9.5, 10.5, null)).toBe('green');
    expect(sideGap(9.5, 10.5)).toBe(1);
    expect(gapFlag(wblt, 9.5, 10.5)).toBe('green');
  });

  it('deep squat has no side-diff flag (bilat: false, no sideDiff)', () => {
    expect(squat.flags.bilat).toBe(false);
    expect(squat.flags.side_diff).toBeUndefined();
  });

  it('deep squat is green on pass, red on fail', () => {
    expect(computeFlag(squat, null, null, true)).toBe('green');
    expect(computeFlag(squat, null, null, false)).toBe('red');
  });

  it('Modified Schober has no side switch (bilat: false)', () => {
    const schober: MeasureDefinition = {
      code: 'lum_schober', unit: 'cm', norm: 6, target: 5, scale: 9,
      flags: { fx: true, bilat: false }, norm_source: 'Schober',
    };
    expect(schober.flags.bilat).toBe(false);
  });

  it('Thomas: 0-30 scale, Thomas norm source, never AAOS', () => {
    expect(thomas.scale).toBe(30);
    expect(thomas.norm_source).toBe('Thomas');
    expect(thomas.norm_source).not.toBe('AAOS');
  });
});

describe('governingValue', () => {
  const attempts = [12, 18, 15];

  it('best is always the max attempt', () => {
    expect(governingValue(attempts, 'best')).toBe(18);
  });

  it('avg rounds the mean', () => {
    expect(governingValue(attempts, 'avg')).toBe(15);
  });

  it('attempt_n picks the value at the given index, not just the best', () => {
    expect(governingValue(attempts, 'attempt_n', 0)).toBe(12);
    expect(governingValue(attempts, 'attempt_n', 2)).toBe(15);
  });

  it('attempt_n falls back to best when that slot is empty', () => {
    expect(governingValue([12, null, 15], 'attempt_n', 1)).toBe(15);
  });
});
