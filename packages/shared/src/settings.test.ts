import { describe, expect, it } from 'vitest';
import {
  TOGGLEABLE_ALERTS,
  clampThreshold,
  isValidInterval,
  isValidThreshold,
  isValidUnits,
  thresholdOptions,
} from './settings';

describe('adherence threshold', () => {
  it('accepts 50–95 in steps of 5', () => {
    expect(isValidThreshold(70)).toBe(true);
    expect(isValidThreshold(50)).toBe(true);
    expect(isValidThreshold(95)).toBe(true);
  });

  it('rejects out-of-range and off-step values', () => {
    expect(isValidThreshold(45)).toBe(false);
    expect(isValidThreshold(100)).toBe(false);
    expect(isValidThreshold(72)).toBe(false);
    expect(isValidThreshold(70.5)).toBe(false);
  });

  it('clamps and snaps arbitrary input', () => {
    expect(clampThreshold(72)).toBe(70);
    expect(clampThreshold(73)).toBe(75);
    expect(clampThreshold(10)).toBe(50);
    expect(clampThreshold(999)).toBe(95);
  });

  it('option list is 50..95 by 5', () => {
    expect(thresholdOptions()).toEqual([50, 55, 60, 65, 70, 75, 80, 85, 90, 95]);
  });
});

describe('units', () => {
  it('only metric / imperial', () => {
    expect(isValidUnits('metric')).toBe(true);
    expect(isValidUnits('imperial')).toBe(true);
    expect(isValidUnits('stone')).toBe(false);
  });
});

describe('assessment interval', () => {
  it('7–180 days', () => {
    expect(isValidInterval(14)).toBe(true);
    expect(isValidInterval(7)).toBe(true);
    expect(isValidInterval(180)).toBe(true);
    expect(isValidInterval(6)).toBe(false);
    expect(isValidInterval(365)).toBe(false);
  });
});

describe('toggleable alerts', () => {
  it('never includes pain_spike', () => {
    expect(TOGGLEABLE_ALERTS).not.toContain('pain_spike');
    expect([...TOGGLEABLE_ALERTS].sort()).toEqual(
      ['adherence_drop', 'assessment_overdue', 'inactive', 'ready_for_advance'].sort(),
    );
  });
});
