// One-off generator (catalog cleanup step 5, 2026-09-13): enriches the
// rehab-relevant subset of the dataset exercises (bodyweight/band/ball/
// roller equipment, minus advanced calisthenics/plyometric/hanging moves —
// 286 of 438) with a Hebrew name, a Hebrew instruction, a region, and a
// rule-based dosage/safety — same review-before-apply channel as step 3
// (app.catalog_save_exercise), just without an interactive review pass per
// the user's explicit "go without review" instruction. Stays in whatever
// status these rows already have (draft) — nothing here approves anything;
// the step-2 approval gate still guards that transition.
'use strict';
const fs = require('fs');

const kept = JSON.parse(fs.readFileSync('scripts/_kept288.json', 'utf8'));
const hebrew = JSON.parse(fs.readFileSync('scripts/_dataset-enrichment-hebrew.json', 'utf8'));
const heById = new Map(hebrew.map(([id, name_he, sentence]) => [id, { name_he, sentence }]));

const REGION_BY_TARGET = {
  abs: 'spine', spine: 'spine',
  glutes: 'hip_thigh', hamstrings: 'hip_thigh', quads: 'hip_thigh', adductors: 'hip_thigh', abductors: 'hip_thigh',
  calves: 'lower_leg',
  delts: 'shoulder', pectorals: 'shoulder', lats: 'shoulder', 'upper back': 'shoulder', traps: 'shoulder',
  'levator scapulae': 'shoulder', 'serratus anterior': 'shoulder',
  triceps: 'elbow', biceps: 'elbow', forearms: 'elbow',
  'cardiovascular system': 'other',
};
const REGION_OVERRIDE_BY_MUSCLE_GROUP = { hands: 'wrist_hand', wrists: 'wrist_hand', 'ankle stabilizers': 'ankle_foot' };

function regionSlug(rec) {
  return REGION_OVERRIDE_BY_MUSCLE_GROUP[rec.muscle_group] || REGION_BY_TARGET[rec.target] || 'other';
}

// Dosage: rule-based by name/category, not per-exercise authorship — a
// stretch is held, an isometric squeeze is held, cardio is timed, ordinary
// strength/mobility work is reps. Consistent with the same typed shape as
// core-catalog dosage (0036).
function dosage(rec) {
  const n = rec.name;
  if (/stretch|pose|sphinx/.test(n)) return { mode: 'hold', sets: 3, hold_sec: 25, rest_sec: 15 };
  if (/isometric|squeeze|hold\b|wall sit|march sit|plank(?! with)|bridge(?! march)|pallof/.test(n) && !/push-up|dip/.test(n)) {
    return { mode: 'hold', sets: 3, hold_sec: 15, rest_sec: 30 };
  }
  if (rec.category === 'cardio') return { mode: 'duration', duration_min: 5 };
  if (/circles|toe touch|mobility/.test(n)) return { mode: 'reps', sets: 2, reps: 10, rest_sec: 20 };
  return { mode: 'reps', sets: 3, reps: 12, rest_sec: 45 };
}

const DEFAULT_SAFETY = 'כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.';

function cleanNameEn(name) {
  return name
    .replace(/\s*\((male|female)\)\s*/gi, '')
    .replace(/\s*v\.?\s*2\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const patches = [];
const missing = [];
for (const rec of kept) {
  const he = heById.get(rec.id);
  if (!he) { missing.push(rec.id); continue; }
  patches.push({
    id: rec.id,
    region_slug: regionSlug(rec), // resolved to a real uuid inside the migration (body_region ids are gen_random_uuid(), not fixed)
    patch: {
      name: he.name_he,
      name_en: cleanNameEn(rec.name),
      aliases: [rec.name],
      item_kind: 'exercise',
      instructions: he.sentence,
      instruction_steps: [he.sentence],
      safety_notes: DEFAULT_SAFETY,
      default_prescription: dosage(rec),
    },
  });
}

console.log('patches:', patches.length, 'missing hebrew:', missing.length, missing);
fs.writeFileSync('scripts/_dataset-enrichment-patches.json', JSON.stringify(patches));
console.log('wrote scripts/_dataset-enrichment-patches.json');
