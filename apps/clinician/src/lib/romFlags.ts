// Flag/colour rules for the measurement panel — ROM_MEASUREMENT.md §4.
// Colour only, no banners. Values come from the token layer (--flag-green
// #3F6B4A, --flag-red #9E3B2E, --flag-neutral #221C14) — see flagColor().

export interface MeasureFlags {
  deficit?: boolean;
  lower?: boolean;
  fx?: boolean;
  bilat?: boolean;
  side_diff?: number;
  risk_below?: number;
  deg_opt?: boolean;
}

export interface MeasureDefinition {
  code: string;
  unit: 'deg' | 'cm' | 'pass_fail';
  norm: number | null;
  target: number | null;
  scale: number;
  flags: MeasureFlags;
  norm_source: string | null;
}

export type FlagState = 'green' | 'red' | 'neutral';

// ROM_MEASUREMENT.md §2 — joint catalog order, Hebrew labels, and each
// protocol's default joint (overridable by the clinician via the switcher).
export const ROM_JOINT_ORDER = ['knee', 'hip', 'ankle', 'shoulder', 'elbow', 'wrist', 'cervical', 'lumbar'] as const;

export const ROM_JOINT_HE: Record<string, string> = {
  knee: 'ברך', shoulder: 'כתף', ankle: 'קרסול', hip: 'ירך',
  elbow: 'מרפק', lumbar: 'גב תחתון', wrist: 'שורש כף היד ואמה', cervical: 'צוואר',
};

export const REGION_JOINT: Record<string, string> = {
  acl_tear: 'knee', rotator_cuff_sprain: 'shoulder', achilles_tendinopathy: 'ankle',
};

/**
 * value/healthyValue are the involved-side and healthy-side values. For
 * pass/fail rows pass carries the state instead.
 */
export function computeFlag(
  def: MeasureDefinition,
  value: number | null,
  healthyValue: number | null,
  pass: boolean | null,
): FlagState {
  if (def.unit === 'pass_fail') {
    if (pass === null || pass === undefined) return 'neutral';
    return pass ? 'green' : 'red';
  }
  if (value === null || value === undefined) return 'neutral';

  if (def.unit === 'cm') {
    // ROM_MEASUREMENT.md §4, in order:
    if (def.flags.risk_below != null && Math.abs(value) < def.flags.risk_below) return 'red';
    if (def.flags.side_diff != null && healthyValue != null && Math.abs(value - healthyValue) >= def.flags.side_diff) {
      return 'red';
    }
    if (def.flags.lower && def.target != null && Math.abs(value) > def.target) return 'red';
    return 'green';
  }

  // Degrees: "keep the existing symmetry/target logic" — not numerically
  // specified beyond that in ROM_MEASUREMENT.md (only the cm/WBLT case has
  // exact acceptance numbers). Target-based, mirroring the cm `lower` rule:
  // deficit rows (0 = perfect) are red above target; standard ROM rows are
  // red below target.
  if (def.target == null) return 'neutral';
  if (def.flags.deficit) {
    return Math.abs(value) > def.target ? 'red' : 'green';
  }
  return value < def.target ? 'red' : 'green';
}

export type GoverningSource = 'best' | 'avg' | 'attempt_n' | 'single';

// Matches the prototype's romGovValue(): 'best' is always the max attempt
// (even for deficit rows), 'avg' rounds the mean, an explicit attempt pick
// falls back to 'best' if that slot is empty.
export function governingValue(attempts: (number | null)[], source: GoverningSource, attemptIndex?: number): number | null {
  const nums = attempts.filter((v): v is number => v !== null && !Number.isNaN(v));
  if (nums.length === 0) return null;
  const best = Math.max(...nums);
  if (source === 'avg') return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  if (source === 'attempt_n') {
    const v = attemptIndex != null ? attempts[attemptIndex] : null;
    return v === null || Number.isNaN(v) ? best : v;
  }
  return best;
}

export function sideGap(value: number | null, healthyValue: number | null): number | null {
  if (value == null || healthyValue == null) return null;
  return Math.round(Math.abs(value - healthyValue) * 10) / 10;
}

/**
 * The side-gap indicator's own colour — independent of computeFlag's
 * overall value flag (they coincide in ROM_MEASUREMENT.md §6's examples,
 * but aren't the same thing: the panel shows the governing value and the
 * gap as two separate coloured indicators).
 */
export function gapFlag(def: MeasureDefinition, value: number | null, healthyValue: number | null): FlagState {
  const gap = sideGap(value, healthyValue);
  if (gap === null || def.flags.side_diff == null) return 'neutral';
  return gap >= def.flags.side_diff ? 'red' : 'green';
}

export function flagColor(state: FlagState): string {
  if (state === 'green') return 'var(--flag-green)';
  if (state === 'red') return 'var(--flag-red)';
  return 'var(--flag-neutral)';
}

/** Row summary string for the assessments table (ROM_MEASUREMENT.md §4). */
export function rowSummary(
  def: MeasureDefinition,
  value: number | null,
  healthyValue: number | null,
  deg: number | null,
  pass: boolean | null,
  compensations: string[] | null,
): string {
  if (def.unit === 'pass_fail') {
    if (pass === null || pass === undefined) return 'טרם נמדד';
    const compLabel = compensations && compensations.length > 0
      ? `פיצוי: ${compensations.join(', ')}`
      : 'ללא פיצויים';
    return `${pass ? 'עובר' : 'לא עובר'} · ${compLabel}`;
  }
  if (value === null || value === undefined) return 'טרם נמדד';

  if (def.unit === 'cm') {
    const flag = computeFlag(def, value, healthyValue, pass);
    const parts = [`${value} ס"מ`];
    if (def.norm != null) parts.push(`נורמה ${def.norm} ס"מ`);
    if (deg != null) parts.push(`${deg}°`);
    parts.push(flag === 'red' ? 'מתחת לסף' : 'תקין');
    return parts.join(' · ');
  }

  // degrees
  if (def.flags.fx) {
    const flag = computeFlag(def, value, healthyValue, pass);
    return flag === 'green' ? 'תקין' : `${value}°`;
  }
  if (def.norm) {
    const pct = Math.round((value / def.norm) * 100);
    const gap = sideGap(value, healthyValue);
    return gap != null ? `${pct}% מנורמת AAOS · פער ${gap}°` : `${pct}% מנורמת AAOS`;
  }
  return `${value}°`;
}
