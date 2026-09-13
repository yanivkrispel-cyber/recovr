import { describe, expect, it } from 'vitest';
import { formatRecommendReason, scoreRecommendation, type RecommendSignals } from './exerciseRecommend';

const none: RecommendSignals = {
  regionPhaseCount: 0,
  regionCount: 0,
  regionProtocolTotal: 8,
  adjacentPhaseN: null,
  contextPhaseN: 2,
  coOccurCount: 0,
  clinicAddCount: 0,
  myAddCount: 0,
  isFavorite: false,
  fillsCategoryGap: false,
};

describe('scoreRecommendation', () => {
  it('does not qualify an exercise with no signal', () => {
    expect(scoreRecommendation(none, 'Strength')).toBeNull();
  });

  it('scores region/phase usage as a share of the region protocols', () => {
    // 4 × 6/8 + 1.5 × 6/8
    const r = scoreRecommendation({ ...none, regionPhaseCount: 6, regionCount: 6 }, 'Strength');
    expect(r?.score).toBe(4.13);
    // the any-phase "region" reason is folded into region_phase, not repeated
    expect(r?.reasons).toEqual([{ code: 'region_phase', count: 6, total: 8 }]);
  });

  it('shows the region reason only when the exercise is not used in this phase', () => {
    const r = scoreRecommendation({ ...none, regionCount: 4 }, 'Mobility');
    expect(r?.score).toBe(0.75);
    expect(r?.reasons).toEqual([{ code: 'region', count: 4, total: 8 }]);
  });

  it('ignores region counts when the region has no other protocols', () => {
    expect(scoreRecommendation({ ...none, regionProtocolTotal: 0, regionPhaseCount: 3, regionCount: 3 }, 'Strength')).toBeNull();
  });

  it('weights the context protocol’s neighbouring phases by distance', () => {
    expect(scoreRecommendation({ ...none, adjacentPhaseN: 1 }, 'Strength')?.score).toBe(1.5);
    expect(scoreRecommendation({ ...none, adjacentPhaseN: 4 }, 'Strength')?.score).toBe(0.75);
    expect(scoreRecommendation({ ...none, contextPhaseN: 1, adjacentPhaseN: 4 }, 'Strength')).toBeNull();
  });

  it('caps co-occurrence and picker history', () => {
    expect(scoreRecommendation({ ...none, coOccurCount: 10 }, 'Strength')?.score).toBe(3);
    expect(scoreRecommendation({ ...none, myAddCount: 9 }, 'Strength')?.score).toBe(3);
    expect(scoreRecommendation({ ...none, clinicAddCount: 9 }, 'Strength')?.score).toBe(3);
  });

  it('lets a favorite qualify on its own', () => {
    const r = scoreRecommendation({ ...none, isFavorite: true }, 'Strength');
    expect(r).toEqual({ score: 1, reasons: [{ code: 'favorite' }] });
  });

  it('counts a category gap only alongside a clinical signal', () => {
    expect(scoreRecommendation({ ...none, isFavorite: true, fillsCategoryGap: true }, 'Balance')?.score).toBe(1);
    const r = scoreRecommendation({ ...none, coOccurCount: 1, fillsCategoryGap: true }, 'Balance');
    expect(r?.score).toBe(1.5);
    // equal contribution (0.75 each) -> fixed priority: co_occurs before fills_gap
    expect(r?.reasons).toEqual([{ code: 'co_occurs', count: 1 }, { code: 'fills_gap', category: 'Balance' }]);
  });

  it('orders reasons by contribution', () => {
    const r = scoreRecommendation(
      { ...none, regionPhaseCount: 1, regionCount: 1, adjacentPhaseN: 1, myAddCount: 3 },
      'Strength',
    );
    // my_picks 2.25 > adjacent 1.5 > region_phase 0.5
    expect(r?.reasons.map((x) => x.code)).toEqual(['my_picks', 'adjacent_phase', 'region_phase']);
    expect(r?.score).toBe(4.44);
  });
});

describe('formatRecommendReason', () => {
  it('renders Hebrew with the counts filled in', () => {
    expect(formatRecommendReason({ code: 'region_phase', count: 3, total: 8 })).toContain('3 מתוך 8');
    expect(formatRecommendReason({ code: 'fills_gap', category: 'Balance' })).toContain('שיווי משקל');
    expect(formatRecommendReason({ code: 'my_picks', count: 1 })).not.toContain('{');
  });
});
