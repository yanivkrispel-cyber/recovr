// Zod schemas for forms, shared with the API layer.

import { z } from 'zod';

// --- Login ---
export const loginSchema = z.object({
  email: z.string().email('valid.email'),
  password: z.string().min(10, 'valid.password.short'),
});
export type LoginInput = z.infer<typeof loginSchema>;

// --- Patient invite acceptance ---
export const patientAcceptSchema = z.object({
  password: z
    .string()
    .min(10, 'valid.password.short')
    .regex(/[A-Za-zא-ת]/, 'valid.password.weak')
    .regex(/\d/, 'valid.password.weak')
    .regex(/[^A-Za-z0-9]/, 'valid.password.weak'),
  confirmPassword: z.string(),
  consent: z.literal(true, { errorMap: () => ({ message: 'valid.required' }) }),
}).refine(d => d.password === d.confirmPassword, {
  message: 'valid.password.mismatch',
  path: ['confirmPassword'],
});
export type PatientAcceptInput = z.infer<typeof patientAcceptSchema>;

// --- Session item logging ---
export const sessionItemSchema = z.object({
  id: z.string().uuid(), // client-generated UUIDv7
  plan_exercise_id: z.string().uuid(),
  sets_done: z.number().int().min(0).optional(),
  reps_done: z.number().int().min(0).optional(),
  load_used: z.number().min(0).optional(),
  pain_score: z.number().int().min(0).max(10).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  skipped: z.boolean(),
  skip_reason: z.string().optional(),
  note: z.string().max(500).optional(),
  logged_at: z.string().datetime(),
});
export type SessionItemInput = z.infer<typeof sessionItemSchema>;

// --- Session complete ---
export const sessionCompleteSchema = z.object({
  max_pain: z.number().int().min(0).max(10).optional(),
  avg_difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  note: z.string().max(500).optional(),
});

// --- Skip session ---
export const sessionSkipSchema = z.object({
  reason: z.string().min(1, 'valid.required').max(200),
});

// --- ROM measurement (per ROM_MEASUREMENT.md) ---
export const romMeasurementSchema = z.object({
  measure_code: z.string().min(1),
  side: z.enum(['involved', 'healthy', 'bilateral']),
  value: z.number(),
  value_secondary: z.number().optional(),
  pass: z.boolean().optional(),
  compensations: z.array(z.string()).optional(),
  attempts: z.array(z.number()).max(3).optional(),
  governing_source: z.enum(['best', 'avg', 'attempt_n', 'single']),
  pain: z.number().int().min(0).max(10).optional(),
  end_feel: z.enum(['soft', 'hard']).optional(),
  swelling: z.enum(['none', 'mild', 'moderate', 'severe']).optional(),
  note: z.string().max(500).optional(),
  visit_id: z.string().uuid().optional(),
  measured_at: z.string().datetime(),
});
export type ROMMeasurementInput = z.infer<typeof romMeasurementSchema>;

// --- Plan criterion ---
export const planCriterionSchema = z.object({
  type: z.enum(['time', 'pain', 'rom', 'strength', 'assessment', 'manual']),
  label: z.string().min(1),
  label_en: z.string().optional(),
  operator: z.enum(['gte', 'lte', 'eq']),
  value: z.number(),
  unit: z.string().optional(),
  order: z.number().int().min(0),
});

// --- Plan exercise (prescription) ---
export const planExerciseSchema = z.object({
  exercise_id: z.string().uuid(),
  sets: z.number().int().min(1).optional(),
  reps: z.number().int().min(1).optional(),
  load: z.number().min(0).optional(),
  load_unit: z.string().optional(),
  tempo: z.string().optional(),
  hold_sec: z.number().int().min(0).optional(),
  rest_sec: z.number().int().min(0).optional(),
  side: z.enum(['left', 'right', 'bilateral']).optional(),
  frequency_days_per_week: z.number().int().min(0).max(7).optional(),
  order: z.number().int().min(0),
  clinician_note: z.string().max(500).optional(),
});

// --- Plan version save ---
export const planVersionSaveSchema = z.object({
  note: z.string().optional(),
  changes: z.object({
    add_exercises: z.array(planExerciseSchema).optional(),
    remove_exercise_ids: z.array(z.string().uuid()).optional(),
    modify_exercises: z.array(planExerciseSchema.extend({ id: z.string().uuid() })).optional(),
    reorder_exercise_ids: z.array(z.string().uuid()).optional(),
    criteria: z.array(planCriterionSchema).optional(),
  }),
  base_version_id: z.string().uuid().optional(),
});

// --- Phase transition (approval) ---
export const phaseTransitionSchema = z.object({
  to_phase_n: z.number().int().min(1),
  direction: z.enum(['forward', 'back']),
  override_reason: z.string().min(1).optional(),
});

// --- New patient ---
export const newPatientSchema = z.object({
  name: z.string().min(1, 'valid.required'),
  name_en: z.string().optional(),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'valid.date.future'),
  sex: z.enum(['M', 'F', 'X']).optional(),
  phone: z.string().regex(/^[\d\-+\s()]+$/, 'valid.phone').optional(),
  email: z.string().email('valid.email').optional(),
  sport: z.string().optional(),
  position: z.string().optional(),
  protocol_id: z.string().uuid(),
  starting_phase_n: z.number().int().min(1),
  exclusion_exercise_ids: z.array(z.string().uuid()).optional(),
});
export type NewPatientInput = z.infer<typeof newPatientSchema>;

// --- Settings ---
export const settingsSchema = z.object({
  adherence_threshold: z.number().int().min(50).max(95).step(5).default(70),
  alert_categories: z.object({
    adherence_drop: z.boolean(),
    pain_spike: z.literal(true), // not disableable per RULES §5
    ready_for_advance: z.boolean(),
    inactive: z.boolean(),
    assessment_overdue: z.boolean(),
  }),
  units: z.enum(['metric', 'imperial']).default('metric'),
  weekly_digest: z.boolean().default(true),
  quiet_hours_start: z.string().regex(/^\d{2}:\d{2}$/).default('21:30'),
  quiet_hours_end: z.string().regex(/^\d{2}:\d{2}$/).default('07:30'),
});
