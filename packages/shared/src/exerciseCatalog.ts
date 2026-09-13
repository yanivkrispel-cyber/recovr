// T-30 exercise catalog governance — shared types, labels and the
// completeness score. `exerciseCompleteness` mirrors
// app.exercise_completeness (supabase/migrations/0032_exercise_catalog.sql):
// same keys, same order, same scoring. Change both together.
import { t } from './i18n';

export const EXERCISE_STATUSES = ['draft', 'in_review', 'approved', 'archived'] as const;
export type ExerciseStatus = (typeof EXERCISE_STATUSES)[number];

export const START_POSITIONS = ['standing', 'sitting', 'supine', 'prone', 'side_lying', 'quadruped', 'kneeling', 'other'] as const;
export type StartPosition = (typeof START_POSITIONS)[number];

export const DIFFICULTY_LEVELS = [1, 2, 3] as const;
export type Difficulty = (typeof DIFFICULTY_LEVELS)[number];

/** T-33 catalog v2 — see supabase/migrations/0036_exercise_catalog_v2.sql. */
export const ITEM_KINDS = ['exercise', 'education', 'program'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const WEIGHT_BEARING_OPTIONS = ['nwb', 'pwb', 'fwb'] as const;
export type WeightBearing = (typeof WEIGHT_BEARING_OPTIONS)[number];

export const CONTRACTION_TYPES = [
  'isometric', 'concentric', 'eccentric', 'isotonic', 'plyometric',
  'stretch', 'rom_passive', 'rom_active_assisted', 'rom_active',
  'neural_glide', 'proprioception',
] as const;
export type ContractionType = (typeof CONTRACTION_TYPES)[number];

export const LATERALITY_OPTIONS = ['unilateral', 'bilateral', 'alternating'] as const;
export type Laterality = (typeof LATERALITY_OPTIONS)[number];

export const DOSAGE_MODES = ['reps', 'hold', 'duration', 'distance'] as const;
export type DosageMode = (typeof DOSAGE_MODES)[number];

export interface Dosage {
  mode?: DosageMode;
  sets?: number | null;
  reps?: number | null;
  hold_sec?: number | null;
  duration_min?: number | null;
  distance_m?: number | null;
  rest_sec?: number | null;
  tempo?: string | null;
}

/** Completeness checklist, in priority order (the order the editor lists what's missing). */
export const COMPLETENESS_KEYS = [
  'name_he', 'name_en', 'body_region', 'instructions_he', 'description', 'key_cues',
  'safety', 'muscles', 'start_position', 'difficulty', 'media',
] as const;
export type CompletenessKey = (typeof COMPLETENESS_KEYS)[number];

/** Fields a clinic may keep its own version of on a system (master) exercise. */
export const CONTENT_FIELDS = ['description', 'instructions', 'key_cues', 'common_mistakes', 'safety_notes', 'contraindications'] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

export interface CompletenessInput {
  name: string | null;
  name_en: string | null;
  body_region_id: string | null;
  instructions: string | null;
  description: string | null;
  key_cues: string[] | null;
  safety_notes: string | null;
  contraindications: string | null;
  muscles: string[] | null;
  start_position: string | null;
  difficulty: number | null;
  has_media: boolean;
}

const HEBREW = /[א-ת]/;
const blank = (s: string | null | undefined) => !s || s.trim() === '';

export function exerciseCompleteness(e: CompletenessInput): { score: number; missing: CompletenessKey[] } {
  const checks: [CompletenessKey, boolean][] = [
    ['name_he', HEBREW.test(e.name ?? '')],
    ['name_en', !blank(e.name_en)],
    ['body_region', e.body_region_id != null],
    ['instructions_he', HEBREW.test(e.instructions ?? '')],
    ['description', !blank(e.description)],
    ['key_cues', (e.key_cues?.length ?? 0) > 0],
    ['safety', !blank(e.safety_notes) || !blank(e.contraindications)],
    ['muscles', (e.muscles?.length ?? 0) > 0],
    ['start_position', e.start_position != null],
    ['difficulty', e.difficulty != null],
    ['media', e.has_media],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  // Postgres round() on numeric rounds half away from zero; so does this for positives.
  const score = Math.round((100 * (COMPLETENESS_KEYS.length - missing.length)) / COMPLETENESS_KEYS.length);
  return { score, missing };
}

/** Tone bucket for a completeness score. */
export function completenessTone(score: number): 'low' | 'mid' | 'high' {
  if (score >= 80) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

export function exerciseStatusLabel(s: string): string {
  switch (s) {
    case 'draft': return t('catalog.status.draft');
    case 'in_review': return t('catalog.status.in_review');
    case 'approved': return t('catalog.status.approved');
    case 'archived': return t('catalog.status.archived');
    default: return s;
  }
}

export function startPositionLabel(p: string): string {
  switch (p) {
    case 'standing': return t('catalog.position.standing');
    case 'sitting': return t('catalog.position.sitting');
    case 'supine': return t('catalog.position.supine');
    case 'prone': return t('catalog.position.prone');
    case 'side_lying': return t('catalog.position.side_lying');
    case 'quadruped': return t('catalog.position.quadruped');
    case 'kneeling': return t('catalog.position.kneeling');
    case 'other': return t('catalog.position.other');
    default: return p;
  }
}

export function difficultyLabel(d: number): string {
  switch (d) {
    case 1: return t('catalog.difficulty.1');
    case 2: return t('catalog.difficulty.2');
    case 3: return t('catalog.difficulty.3');
    default: return String(d);
  }
}

export function itemKindLabel(k: string): string {
  switch (k) {
    case 'exercise': return t('catalog.item_kind.exercise');
    case 'education': return t('catalog.item_kind.education');
    case 'program': return t('catalog.item_kind.program');
    default: return k;
  }
}

export function weightBearingLabel(w: string): string {
  switch (w) {
    case 'nwb': return t('catalog.weight_bearing.nwb');
    case 'pwb': return t('catalog.weight_bearing.pwb');
    case 'fwb': return t('catalog.weight_bearing.fwb');
    default: return w;
  }
}

export function contractionTypeLabel(c: string): string {
  switch (c) {
    case 'isometric': return t('catalog.contraction.isometric');
    case 'concentric': return t('catalog.contraction.concentric');
    case 'eccentric': return t('catalog.contraction.eccentric');
    case 'isotonic': return t('catalog.contraction.isotonic');
    case 'plyometric': return t('catalog.contraction.plyometric');
    case 'stretch': return t('catalog.contraction.stretch');
    case 'rom_passive': return t('catalog.contraction.rom_passive');
    case 'rom_active_assisted': return t('catalog.contraction.rom_active_assisted');
    case 'rom_active': return t('catalog.contraction.rom_active');
    case 'neural_glide': return t('catalog.contraction.neural_glide');
    case 'proprioception': return t('catalog.contraction.proprioception');
    default: return c;
  }
}

export function lateralityLabel(l: string): string {
  switch (l) {
    case 'unilateral': return t('catalog.laterality.unilateral');
    case 'bilateral': return t('catalog.laterality.bilateral');
    case 'alternating': return t('catalog.laterality.alternating');
    default: return l;
  }
}

export function dosageModeLabel(m: string): string {
  switch (m) {
    case 'reps': return t('catalog.dosage.mode.reps');
    case 'hold': return t('catalog.dosage.mode.hold');
    case 'duration': return t('catalog.dosage.mode.duration');
    case 'distance': return t('catalog.dosage.mode.distance');
    default: return m;
  }
}

/** One-line dosage summary for read-only surfaces (grid rows, usage panel). */
export function dosageSummary(d: Dosage | null | undefined): string | null {
  if (!d || !d.mode) return null;
  const sets = d.sets ? `${d.sets} × ` : '';
  switch (d.mode) {
    case 'reps': return d.reps ? `${sets}${d.reps} ${t('catalog.dosage.unit.reps')}` : null;
    case 'hold': return d.hold_sec ? `${sets}${d.hold_sec} ${t('catalog.dosage.unit.sec')}` : null;
    case 'duration': return d.duration_min ? `${d.duration_min} ${t('catalog.dosage.unit.min')}` : null;
    case 'distance': return d.distance_m ? `${d.distance_m} ${t('catalog.dosage.unit.m')}` : null;
    default: return null;
  }
}

/**
 * Labels for both COMPLETENESS_KEYS (the editor's completeness meter) and
 * the two extra fields app.catalog_set_status's approval gate can report
 * that aren't part of that meter: 'instruction_steps' and
 * 'default_prescription'.
 */
export function completenessKeyLabel(k: string): string {
  switch (k) {
    case 'name_he': return t('catalog.missing.name_he');
    case 'name_en': return t('catalog.missing.name_en');
    case 'body_region': return t('catalog.missing.body_region');
    case 'instructions_he': return t('catalog.missing.instructions_he');
    case 'description': return t('catalog.missing.description');
    case 'key_cues': return t('catalog.missing.key_cues');
    case 'safety': return t('catalog.missing.safety');
    case 'muscles': return t('catalog.missing.muscles');
    case 'start_position': return t('catalog.missing.start_position');
    case 'difficulty': return t('catalog.missing.difficulty');
    case 'media': return t('catalog.missing.media');
    case 'instruction_steps': return t('catalog.missing.instruction_steps');
    case 'default_prescription': return t('catalog.missing.default_prescription');
    default: return k;
  }
}
