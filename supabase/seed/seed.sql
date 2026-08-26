-- ============================================================================
-- RecoveryOS — Demo clinic seed
-- ----------------------------------------------------------------------------
-- Loads a single demo clinic (slug: 'demo') with a single patient, one
-- protocol, and one planned session for today. Run after `supabase db reset`.
-- ============================================================================

-- 1. The shared "app" schema already exists from 0001_initial_schema.sql.

-- 2. Register the clinic in the app schema.
INSERT INTO app.clinic (id, slug, name, schema_name, settings_json, created_at)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'demo',
  'RecoveryOS Demo Clinic',
  'clinic_demo',
  '{"locale":"he","timezone":"Asia/Jerusalem"}'::jsonb,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 3. Provision the clinic schema (creates tables from the template).
SELECT app.provision_clinic('11111111-1111-1111-1111-111111111111');

-- 4. From here on, set search_path so we can write into the new schema.
SET search_path TO clinic_demo, app, public;

-- 5. Clinician user (auth user must exist first — created via supabase auth API or Studio).
--    We reference it by email so the seed is idempotent.
DO $$
DECLARE
  v_clinician_id uuid;
BEGIN
  -- Look up the auth user by email (created via the auth admin API in real life).
  SELECT id INTO v_clinician_id
  FROM auth.users
  WHERE email = 'clinician@demo.recoveryos.app'
  LIMIT 1;

  IF v_clinician_id IS NOT NULL THEN
    INSERT INTO "user" (id, clinic_id, role, display_name, created_at)
    VALUES (
      v_clinician_id,
      '11111111-1111-1111-1111-111111111111',
      'clinician',
      'ד״ר רונית',
      now()
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 6. A few seed exercises.
INSERT INTO exercise (id, code, name, name_en, instructions, created_at) VALUES
  ('e0000001-0000-0000-0000-000000000001', 'quad_set', 'כיווץ ירך-ארבע ראשי', 'Quad set',
   'שכב על הגב עם רגליים ישרות. כווץ את שריר הירך הקדמי ולחץ את הברך כלפי המזרן. החזק 5 שניות.',
   now()),
  ('e0000001-0000-0000-0000-000000000002', 'heel_slide', 'החלקת עקב', 'Heel slide',
   'שכב על הגב. החלק את העקב לכיוון הישבן תוך כדי הרפיית הברך. חזור למצב התחלתי.',
   now()),
  ('e0000001-0000-0000-0000-000000000003', 'straight_leg_raise', 'הרמת רגל ישרה', 'Straight leg raise',
   'שכב על הגב, רגל אחת כפופה והשנייה ישרה. הרים את הרגל הישרה לגובה הברך הכפופה, החזק 3 שניות, הורד לאט.',
   now())
ON CONFLICT (id) DO NOTHING;

-- 7. A simple protocol with two phases.
INSERT INTO protocol (id, clinic_id, code, name, description, version, created_at, created_by)
SELECT
  'p0000001-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'acl_post_op_weeks_1_4',
  'שיקום ACL — שבועות 1–4',
  'פרוטוקול סטנדרטי לאחר ניתוח שחזור ACL. מתמקד בהפעלה מוקדמת, טווח תנועה וחיזוק ראשוני.',
  1,
  now(),
  id
FROM "user" WHERE role = 'clinician' LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- 8. Two protocol phases.
INSERT INTO protocol_phase (id, protocol_id, ordinal, name, criteria_json) VALUES
  ('ph000001-0000-0000-0000-000000000001', 'p0000001-0000-0000-0000-000000000001', 1,
   'שלב 1 — הגנה והפעלה',
   '{"knee_rom_min":0,"knee_rom_max":90,"quad_strength_pct":40,"pain_max":4}'::jsonb),
  ('ph000002-0000-0000-0000-000000000001', 'p0000001-0000-0000-0000-000000000001', 2,
   'שלב 2 — חיזוק והליכה',
   '{"knee_rom_min":0,"knee_rom_max":120,"quad_strength_pct":70,"pain_max":3}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 9. Phase 1 exercises.
INSERT INTO protocol_phase_exercise (id, phase_id, exercise_id, sets, reps, load_kg, rest_sec, ordinal)
VALUES
  ('px000001-0000-0000-0000-000000000001', 'ph000001-0000-0000-0000-000000000001',
   'e0000001-0000-0000-0000-000000000001', 3, 10, NULL, 60, 1),
  ('px000001-0000-0000-0000-000000000002', 'ph000001-0000-0000-0000-000000000001',
   'e0000001-0000-0000-0000-000000000002', 2, 12, NULL, 60, 2),
  ('px000001-0000-0000-0000-000000000003', 'ph000001-0000-0000-0000-000000000001',
   'e0000001-0000-0000-0000-000000000003', 3, 10, NULL, 60, 3)
ON CONFLICT (id) DO NOTHING;

-- 10. One patient on this protocol.
INSERT INTO patient (id, clinic_id, display_name, condition_code, laterality, surgery_date, current_phase_n, created_at)
VALUES (
  'a0000001-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'יואב כהן',
  'acl_reconstruction',
  'left',
  (current_date - interval '14 days')::date,
  1,
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 11. One plan + plan version + plan phase referencing the patient and protocol.
INSERT INTO plan (id, patient_id, current_version_id, status, created_at, created_by)
SELECT
  'pl000001-0000-0000-0000-000000000001',
  'a0000001-0000-0000-0000-000000000001',
  NULL,
  'active',
  now(),
  id
FROM "user" WHERE role = 'clinician' LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO plan_version (id, plan_id, version_n, source_protocol_id, start_date, end_date, created_at, created_by)
VALUES (
  'pv000001-0000-0000-0000-000000000001',
  'pl000001-0000-0000-0000-000000000001',
  1,
  'p0000001-0000-0000-0000-000000000001',
  (current_date - interval '14 days')::date,
  (current_date + interval '70 days')::date,
  now(),
  (SELECT id FROM "user" WHERE role = 'clinician' LIMIT 1)
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO plan_phase (id, plan_version_id, ordinal, name, protocol_phase_id, status)
VALUES (
  'plp00001-0000-0000-0000-000000000001',
  'pv000001-0000-0000-0000-000000000001',
  1,
  'שלב 1 — הגנה והפעלה',
  'ph000001-0000-0000-0000-000000000001',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO plan_exercise (id, plan_phase_id, exercise_id, sets, reps, load_kg, rest_sec, ordinal, weekly_target)
SELECT
  'ple00001-0000-0000-0000-000000000001', 'plp00001-0000-0000-0000-000000000001',
  e.id, ppe.sets, ppe.reps, ppe.load_kg, ppe.rest_sec, ppe.ordinal, 5
FROM protocol_phase_exercise ppe
JOIN exercise e ON e.id = ppe.exercise_id
WHERE ppe.phase_id = 'ph000001-0000-0000-0000-000000000001'
ON CONFLICT (id) DO NOTHING;

UPDATE plan SET current_version_id = 'pv000001-0000-0000-0000-000000000001' WHERE id = 'pl000001-0000-0000-0000-000000000001';

-- 12. A session for today referencing the plan.
INSERT INTO session (id, plan_id, scheduled_date, status, created_at)
VALUES (
  's0000001-0000-0000-0000-000000000001',
  'pl000001-0000-0000-0000-000000000001',
  current_date,
  'pending',
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO session_item (id, session_id, plan_exercise_id, exercise_id, sets_done, reps_done, skipped, logged_at)
SELECT
  gen_random_uuid(),
  's0000001-0000-0000-0000-000000000001',
  pe.id,
  pe.exercise_id,
  0, 0, false, NULL
FROM plan_exercise pe
WHERE pe.plan_phase_id = 'plp00001-0000-0000-0000-000000000001'
ON CONFLICT (id) DO NOTHING;
