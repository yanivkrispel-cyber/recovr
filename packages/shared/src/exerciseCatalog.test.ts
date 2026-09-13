import { describe, expect, it } from 'vitest';
import {
  COMPLETENESS_KEYS, EXERCISE_STATUSES, START_POSITIONS, completenessKeyLabel, completenessTone,
  exerciseCompleteness, exerciseStatusLabel, startPositionLabel, type CompletenessInput,
} from './exerciseCatalog';

const empty: CompletenessInput = {
  name: null, name_en: null, body_region_id: null, instructions: null, description: null, key_cues: null,
  safety_notes: null, contraindications: null, muscles: null, start_position: null, difficulty: null, has_media: false,
};

const full: CompletenessInput = {
  name: 'החלקת עקב', name_en: 'Heel slide', body_region_id: 'r1',
  instructions: 'שכב על הגב והחלק את העקב', description: 'ניידות ברך', key_cues: ['גב צמוד למזרן'],
  safety_notes: null, contraindications: 'כאב חד', muscles: ['hamstrings'], start_position: 'supine',
  difficulty: 1, has_media: true,
};

// Mirrors app.exercise_completeness (0032). These cases were also run against
// the SQL function on the local DB with the same inputs.
describe('exerciseCompleteness', () => {
  it('empty exercise misses everything in checklist order', () => {
    expect(exerciseCompleteness(empty)).toEqual({ score: 0, missing: [...COMPLETENESS_KEYS] });
  });

  it('complete exercise scores 100', () => {
    expect(exerciseCompleteness(full)).toEqual({ score: 100, missing: [] });
  });

  it('English-only name and instructions do not count as Hebrew', () => {
    const r = exerciseCompleteness({ ...full, name: 'Heel slide', instructions: 'Lie on your back' });
    expect(r.missing).toEqual(['name_he', 'instructions_he']);
    expect(r.score).toBe(82); // round(100 * 9 / 11)
  });

  it('either safety notes or contraindications satisfies safety', () => {
    expect(exerciseCompleteness({ ...full, contraindications: null, safety_notes: 'עצור בכאב' }).missing).toEqual([]);
    expect(exerciseCompleteness({ ...full, contraindications: '   ' }).missing).toEqual(['safety']);
  });

  it('blank strings and empty arrays count as missing', () => {
    const r = exerciseCompleteness({ ...full, name_en: '  ', key_cues: [], muscles: [], description: '' });
    expect(r.missing).toEqual(['name_en', 'description', 'key_cues', 'muscles']);
    expect(r.score).toBe(64); // round(100 * 7 / 11)
  });

  it('difficulty 0 would still be "set" (the DB constrains it to 1-3)', () => {
    expect(exerciseCompleteness({ ...full, difficulty: 0 }).missing).toEqual([]);
  });

  it('rounds like Postgres numeric round()', () => {
    // 1 of 11 done -> 9.09 -> 9 ; 6 of 11 -> 54.5 -> 55
    expect(exerciseCompleteness({ ...empty, has_media: true }).score).toBe(9);
    expect(exerciseCompleteness({ ...full, description: null, key_cues: null, muscles: null, start_position: null, difficulty: null }).score).toBe(55);
  });
});

describe('completenessTone', () => {
  it('buckets', () => {
    expect(completenessTone(0)).toBe('low');
    expect(completenessTone(49)).toBe('low');
    expect(completenessTone(50)).toBe('mid');
    expect(completenessTone(79)).toBe('mid');
    expect(completenessTone(80)).toBe('high');
  });
});

describe('catalog labels', () => {
  it.each([...EXERCISE_STATUSES])('status %s has a Hebrew label', (s) => {
    expect(exerciseStatusLabel(s)).toMatch(/[֐-׿]/);
  });
  it.each([...START_POSITIONS])('position %s has a Hebrew label', (p) => {
    expect(startPositionLabel(p)).toMatch(/[֐-׿]/);
  });
  it.each([...COMPLETENESS_KEYS])('completeness key %s has a Hebrew label', (k) => {
    expect(completenessKeyLabel(k)).toMatch(/[֐-׿]/);
  });
});
