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
    default: return k;
  }
}
