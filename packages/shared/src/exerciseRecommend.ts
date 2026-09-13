// Exercise picker recommendation scoring (T-29).
//
// `app.recommend_exercises` (migration 0031) is authoritative — it gathers the
// signals and scores in SQL. This module mirrors the pure scoring step so the
// weights, the qualifying rule and the reason ordering are pinned by tests,
// and holds the client-side Hebrew rendering of a reason.
//
// Signals come only from the protocol library (system + this clinic's own
// protocols) and from this clinic's own picker history — never from patient
// records, never from another clinic.

import { t } from './i18n';

export interface RecommendSignals {
  /** Other visible protocols in the same body region that use the exercise in this phase number. */
  regionPhaseCount: number;
  /** Other visible protocols in the same body region that use it in any phase. */
  regionCount: number;
  /** Other visible protocols in the same body region (the denominator for the two counts above). */
  regionProtocolTotal: number;
  /** Nearest other phase of the context protocol that already uses it, or null. */
  adjacentPhaseN: number | null;
  /** The phase being edited, or null when unknown. */
  contextPhaseN: number | null;
  /** Protocol phases that pair it with an exercise already in (or picked for) this phase. */
  coOccurCount: number;
  /** Picker sessions by other clinicians in this clinic that added it in a matching context. */
  clinicAddCount: number;
  /** Picker sessions by this clinician that added it in a matching context. */
  myAddCount: number;
  isFavorite: boolean;
  /** Its category is typical for this region/phase but missing from the phase so far. */
  fillsCategoryGap: boolean;
}

export type RecommendReason =
  | { code: 'region_phase'; count: number; total: number }
  | { code: 'region'; count: number; total: number }
  | { code: 'adjacent_phase'; phase_n: number }
  | { code: 'co_occurs'; count: number }
  | { code: 'my_picks'; count: number }
  | { code: 'clinic_picks'; count: number }
  | { code: 'favorite' }
  | { code: 'fills_gap'; category: string };

export const RECOMMEND_WEIGHTS = {
  regionPhase: 4, // × share of region protocols using it in this phase
  region: 1.5, // × share of region protocols using it in any phase
  adjacentPhase1: 1.5,
  adjacentPhase2: 0.75,
  coOccurPer: 0.75,
  coOccurCap: 4,
  myPickPer: 0.75,
  myPickCap: 4,
  clinicPickPer: 0.5,
  clinicPickCap: 6,
  favorite: 1,
  categoryGap: 0.75,
} as const;

export interface ScoredRecommendation {
  score: number;
  reasons: RecommendReason[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Score one candidate. Returns null when it doesn't qualify (score 0).
 * Reasons are ordered by their contribution, ties broken by a fixed priority —
 * the same order the SQL emits.
 */
export function scoreRecommendation(s: RecommendSignals, category: string): ScoredRecommendation | null {
  const w = RECOMMEND_WEIGHTS;
  const total = s.regionProtocolTotal;

  const sRegionPhase = total > 0 ? (w.regionPhase * s.regionPhaseCount) / total : 0;
  const sRegion = total > 0 ? (w.region * s.regionCount) / total : 0;
  const distance =
    s.adjacentPhaseN != null && s.contextPhaseN != null ? Math.abs(s.adjacentPhaseN - s.contextPhaseN) : null;
  const sAdjacent = distance === 1 ? w.adjacentPhase1 : distance === 2 ? w.adjacentPhase2 : 0;
  const sCoOccur = w.coOccurPer * Math.min(s.coOccurCount, w.coOccurCap);
  const sMine = w.myPickPer * Math.min(s.myAddCount, w.myPickCap);
  const sClinic = w.clinicPickPer * Math.min(s.clinicAddCount, w.clinicPickCap);
  const sFavorite = s.isFavorite ? w.favorite : 0;
  // A category gap only counts for something the protocol library already ties to this context.
  const clinical = sRegionPhase + sRegion + sAdjacent + sCoOccur;
  const sGap = s.fillsCategoryGap && clinical > 0 ? w.categoryGap : 0;

  const score = round2(clinical + sMine + sClinic + sFavorite + sGap);
  if (score <= 0) return null;

  const candidates: [number, number, RecommendReason | null][] = [
    [sRegionPhase, 1, s.regionPhaseCount > 0 ? { code: 'region_phase', count: s.regionPhaseCount, total } : null],
    [sAdjacent, 2, sAdjacent > 0 ? { code: 'adjacent_phase', phase_n: s.adjacentPhaseN! } : null],
    [sCoOccur, 3, s.coOccurCount > 0 ? { code: 'co_occurs', count: s.coOccurCount } : null],
    [sMine, 4, s.myAddCount > 0 ? { code: 'my_picks', count: s.myAddCount } : null],
    [sClinic, 5, s.clinicAddCount > 0 ? { code: 'clinic_picks', count: s.clinicAddCount } : null],
    [sFavorite, 6, s.isFavorite ? { code: 'favorite' } : null],
    [sGap, 7, sGap > 0 ? { code: 'fills_gap', category } : null],
    [sRegion, 8, s.regionCount > 0 && s.regionPhaseCount === 0 ? { code: 'region', count: s.regionCount, total } : null],
  ];

  const reasons = candidates
    .filter((c): c is [number, number, RecommendReason] => c[2] !== null)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((c) => c[2]);

  return { score, reasons };
}

export const EXERCISE_CATEGORIES = ['Strength', 'Mobility', 'Balance', 'Control', 'Cardio'] as const;

export function exerciseCategoryLabel(category: string): string {
  switch (category) {
    case 'Mobility': return t('exercise.category.Mobility');
    case 'Strength': return t('exercise.category.Strength');
    case 'Balance': return t('exercise.category.Balance');
    case 'Control': return t('exercise.category.Control');
    case 'Cardio': return t('exercise.category.Cardio');
    default: return category;
  }
}

// Hebrew labels for the equipment values the dataset actually uses (raw
// English from exercises-dataset-main). Unknown values fall back to the raw
// string rather than hiding it.
const EQUIPMENT_LABEL_HE: Record<string, string> = {
  dumbbell: 'משקולות יד',
  cable: 'כבלים',
  barbell: 'מוט',
  'leverage machine': 'מכשיר',
  band: 'גומייה',
  'resistance band': 'גומיית התנגדות',
  'smith machine': 'מכונת סמית׳',
  kettlebell: 'קטלבל',
  weighted: 'משקל נוסף',
  'stability ball': 'כדור פיזיו',
  'ez barbell': 'מוט EZ',
  assisted: 'בסיוע',
  'sled machine': 'מזחלת',
  'medicine ball': 'כדור כוח',
  rope: 'חבל',
  roller: 'רולר',
  'bosu ball': 'בוסו',
};

export function equipmentLabel(equipment: string): string {
  return EQUIPMENT_LABEL_HE[equipment] ?? equipment;
}

export function formatRecommendReason(r: RecommendReason): string {
  switch (r.code) {
    case 'region_phase': return t('picker.reason.region_phase', { count: r.count, total: r.total });
    case 'region': return t('picker.reason.region', { count: r.count, total: r.total });
    case 'adjacent_phase': return t('picker.reason.adjacent_phase', { phase_n: r.phase_n });
    case 'co_occurs': return t('picker.reason.co_occurs', { count: r.count });
    case 'my_picks': return r.count === 1 ? t('picker.reason.my_picks.one') : t('picker.reason.my_picks', { count: r.count });
    case 'clinic_picks': return r.count === 1 ? t('picker.reason.clinic_picks.one') : t('picker.reason.clinic_picks', { count: r.count });
    case 'favorite': return t('picker.reason.favorite');
    case 'fills_gap': return t('picker.reason.fills_gap', { category: exerciseCategoryLabel(r.category) });
  }
}
