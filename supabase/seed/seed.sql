-- ============================================================================
-- RecoveryOS — Demo clinic seed
-- ----------------------------------------------------------------------------
-- Loads a single demo clinic (slug: 'demo') with a clinician, one patient,
-- one protocol with two phases, a plan, and a session for today.
-- Run after `supabase db reset`.
-- ============================================================================

-- 1. Register the clinic in the app schema.
INSERT INTO app.clinic (id, slug, name, timezone, locale, settings, created_at, updated_at)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'demo',
  'RecoveryOS Demo Clinic',
  'Asia/Jerusalem',
  'he-IL',
  '{"locale":"he","timezone":"Asia/Jerusalem"}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 2. Provision the clinic schema. create_clinic_tables() is the same function
--    provision_clinic() uses for real clinics, so clinic_demo can never drift
--    from what a newly-provisioned clinic actually gets.
CREATE SCHEMA IF NOT EXISTS clinic_demo;
SELECT create_clinic_tables('clinic_demo');

-- 4. From here on, work in the clinic schema and the app/auth schemas.
SET search_path TO clinic_demo, app, public, auth, extensions;

-- 4. Create demo clinician auth user (idempotent).
--    Password: demo12345678  (bcrypt hashed via pgcrypto; must satisfy the
--    app's min-10-char password policy so the login form doesn't reject it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'clinician@demo.recoveryos.app') THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_user_meta_data, raw_app_meta_data,
      confirmation_token, recovery_token,
      email_change_token_new, email_change_token_current, email_change,
      phone_change, phone_change_token, reauthentication_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      '22222222-2222-2222-2222-222222222222',
      'authenticated',
      'authenticated',
      'clinician@demo.recoveryos.app',
      crypt('demo12345678', gen_salt('bf')),
      now(), now(), now(),
      '{"email": "clinician@demo.recoveryos.app", "email_verified": true}'::jsonb,
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      -- GoTrue scans these as non-null strings; NULL breaks password login with a 500.
      '', '', '', '', '', '', '', ''
    );
  END IF;
END $$;

-- 5. Mirror into auth.identities (GoTrue requires this for password sign-in).
DO $$
DECLARE v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'clinician@demo.recoveryos.app' LIMIT 1;
  IF v_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE user_id = v_uid AND provider = 'email'
  ) THEN
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', 'clinician@demo.recoveryos.app', 'email_verified', true),
      'email', v_uid::text, now(), now(), now()
    );
  END IF;
END $$;

-- 6. App user row linked to the demo clinic.
INSERT INTO app."user" (id, clinic_id, role, name, email, password_hash, status, created_at, updated_at)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'clinician',
  'ד״ר רונית',
  'clinician@demo.recoveryos.app',
  crypt('demo12345678', gen_salt('bf')),
  'active',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 7. A few seed exercises (system-level, clinic_id NULL).
INSERT INTO app.exercise (id, clinic_id, name, name_en, category, region, instructions) VALUES
  ('e0000001-0000-0000-0000-000000000001', NULL,
   'כיווץ ירך-ארבע ראשי', 'Quad set', 'Strength', 'Knee',
   'שכב על הגב עם רגליים ישרות. כווץ את שריר הירך הקדמי ולחץ את הברך כלפי המזרן. החזק 5 שניות.'),
  ('e0000001-0000-0000-0000-000000000002', NULL,
   'החלקת עקב', 'Heel slide', 'Mobility', 'Knee',
   'שכב על הגב. החלק את העקב לכיוון הישבן תוך כדי הרפיית הברך. חזור למצב התחלתי.'),
  ('e0000001-0000-0000-0000-000000000003', NULL,
   'הרמת רגל ישרה', 'Straight leg raise', 'Strength', 'Knee',
   'שכב על הגב, רגל אחת כפופה והשנייה ישרה. הרים את הרגל הישרה לגובה הברך הכפופה, החזק 3 שניות, הורד לאט.')
ON CONFLICT (id) DO NOTHING;

-- 8. A demo protocol owned by the demo clinic.
INSERT INTO app.protocol (id, clinic_id, slug, name, name_en, region, source, version, is_active, created_at, updated_at)
VALUES (
  'a0000001-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'acl_post_op_weeks_1_4',
  'שיקום ACL — שבועות 1–4',
  'ACL rehab — weeks 1-4',
  'Knee',
  'clinic',
  '1.0',
  true,
  now(), now()
)
ON CONFLICT (id) DO NOTHING;

-- 9. Two protocol phases.
INSERT INTO app.protocol_phase (id, protocol_id, n, name, name_en, duration_days, goals, "order") VALUES
  ('a0000001-0000-0000-0000-000000000010',
   'a0000001-0000-0000-0000-000000000001', 1,
   'שלב 1 — הגנה והפעלה', 'Phase 1 — Protection & activation', 14,
   '[{"he":"הפעלה מוקדמת של הארבע ראשי","en":"Early quad activation"}]'::jsonb,
   1),
  ('a0000001-0000-0000-0000-000000000011',
   'a0000001-0000-0000-0000-000000000001', 2,
   'שלב 2 — חיזוק והליכה', 'Phase 2 — Strengthening & gait', 28,
   '[{"he":"חיזוק וחזרה להליכה תקינה","en":"Strength progression and normalized gait"}]'::jsonb,
   2)
ON CONFLICT (id) DO NOTHING;

-- 10. Prescription for phase 1 (using the new JSONB prescription column).
INSERT INTO app.protocol_phase_exercise (id, protocol_phase_id, exercise_id, prescription, frequency, "order", notes) VALUES
  ('a0000001-0000-0000-0000-000000000020',
   'a0000001-0000-0000-0000-000000000010',
   'e0000001-0000-0000-0000-000000000001',
   '{"sets":3,"reps":10,"rest_sec":60}'::jsonb,
   '3x/week', 1, NULL),
  ('a0000001-0000-0000-0000-000000000021',
   'a0000001-0000-0000-0000-000000000010',
   'e0000001-0000-0000-0000-000000000002',
   '{"sets":2,"reps":12,"rest_sec":60}'::jsonb,
   '3x/week', 2, NULL),
  ('a0000001-0000-0000-0000-000000000022',
   'a0000001-0000-0000-0000-000000000010',
   'e0000001-0000-0000-0000-000000000003',
   '{"sets":3,"reps":10,"rest_sec":60}'::jsonb,
   '3x/week', 3, NULL)
ON CONFLICT (id) DO NOTHING;

-- 10b. Prescription for phase 2 — without this, approving the demo
-- patient into phase 2 instantiates an empty phase (app.write_phase_transition
-- copies whatever the protocol template has; an untested empty template
-- means an untestable phase 2).
INSERT INTO app.protocol_phase_exercise (id, protocol_phase_id, exercise_id, prescription, frequency, "order", notes) VALUES
  ('a0000001-0000-0000-0000-000000000023',
   'a0000001-0000-0000-0000-000000000011',
   'e0000001-0000-0000-0000-000000000002',
   '{"sets":3,"reps":15,"rest_sec":45}'::jsonb,
   '4x/week', 1, NULL),
  ('a0000001-0000-0000-0000-000000000024',
   'a0000001-0000-0000-0000-000000000011',
   'e0000001-0000-0000-0000-000000000003',
   '{"sets":4,"reps":12,"rest_sec":45}'::jsonb,
   '4x/week', 2, NULL)
ON CONFLICT (id) DO NOTHING;

-- 10c. Progression criteria for both phases.
INSERT INTO app.protocol_phase_criterion (id, protocol_phase_id, type, label, label_en, operator, value, unit, "order") VALUES
  ('a0000001-0000-0000-0000-000000000030',
   'a0000001-0000-0000-0000-000000000010',
   'time', 'מינימום 14 ימים בשלב', 'Minimum 14 days in phase', 'gte', 14, 'days', 1),
  ('a0000001-0000-0000-0000-000000000031',
   'a0000001-0000-0000-0000-000000000010',
   'pain', 'כאב ≤ 4/10', 'Pain ≤ 4/10', 'lte', 4, '0-10', 2),
  ('a0000001-0000-0000-0000-000000000032',
   'a0000001-0000-0000-0000-000000000011',
   'time', 'מינימום 28 ימים בשלב', 'Minimum 28 days in phase', 'gte', 28, 'days', 1)
ON CONFLICT (id) DO NOTHING;

-- 11. One patient on the demo protocol.
INSERT INTO patient (id, clinic_id, primary_clinician_id, name, status, created_at)
VALUES (
  'a0000001-0000-0000-0000-000000000100',
  '11111111-1111-1111-1111-111111111111',
  (SELECT id FROM app."user" WHERE role = 'clinician' LIMIT 1),
  'יואב כהן',
  'active',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 12. Plan for the patient.
INSERT INTO plan (id, patient_id, protocol_id, started_at, current_phase_n, status, created_at, updated_at)
VALUES (
  'a0000001-0000-0000-0000-000000000200',
  'a0000001-0000-0000-0000-000000000100',
  'a0000001-0000-0000-0000-000000000001',
  (now() - interval '14 days'),
  1,
  'active',
  now(), now()
)
ON CONFLICT (id) DO NOTHING;

-- 13. Plan version (current).
INSERT INTO plan_version (id, plan_id, version, created_by, created_at, is_current, note)
VALUES (
  'a0000001-0000-0000-0000-000000000201',
  'a0000001-0000-0000-0000-000000000200',
  1,
  (SELECT id FROM app."user" WHERE role = 'clinician' LIMIT 1),
  now(),
  true,
  'Initial version from seed'
)
ON CONFLICT (id) DO NOTHING;

-- 14. Plan phase matching protocol phase 1.
INSERT INTO plan_phase (id, plan_version_id, n, name, duration_days, started_at)
VALUES (
  'a0000001-0000-0000-0000-000000000210',
  'a0000001-0000-0000-0000-000000000201',
  1,
  'שלב 1 — הגנה והפעלה',
  14,
  (now() - interval '14 days')
)
ON CONFLICT (id) DO NOTHING;

-- 15. Plan exercises, copying from the protocol prescription.
INSERT INTO plan_exercise (id, plan_phase_id, exercise_id, sets, reps, rest_sec, frequency_days_per_week, "order")
SELECT
  ('a0000001-0000-0000-0000-00000000022' || (row_number() over () - 1)::text)::uuid,
  'a0000001-0000-0000-0000-000000000210',
  ppe.exercise_id,
  (ppe.prescription->>'sets')::int,
  (ppe.prescription->>'reps')::int,
  (ppe.prescription->>'rest_sec')::int,
  3,
  ppe."order"
FROM app.protocol_phase_exercise ppe
WHERE ppe.protocol_phase_id = 'a0000001-0000-0000-0000-000000000010'
ON CONFLICT (id) DO NOTHING;

-- 15b. Plan criteria, copying from the protocol's phase 1 (T-09: gives the
-- Progression Criteria panel something real to show for the demo patient).
INSERT INTO plan_criterion (id, plan_phase_id, type, label, label_en, operator, value, unit, "order")
SELECT
  ('a0000001-0000-0000-0000-00000000030' || (row_number() over () - 1)::text)::uuid,
  'a0000001-0000-0000-0000-000000000210',
  ppc.type, ppc.label, ppc.label_en, ppc.operator, ppc.value, ppc.unit, ppc."order"
FROM app.protocol_phase_criterion ppc
WHERE ppc.protocol_phase_id = 'a0000001-0000-0000-0000-000000000010'
ON CONFLICT (id) DO NOTHING;

-- 16. A session for today.
INSERT INTO session (id, patient_id, plan_version_id, date, status, items_planned, created_at)
SELECT
  'a0000001-0000-0000-0000-000000000300',
  'a0000001-0000-0000-0000-000000000100',
  'a0000001-0000-0000-0000-000000000201',
  current_date,
  'planned',
  count(*),
  now()
FROM plan_exercise WHERE plan_phase_id = 'a0000001-0000-0000-0000-000000000210'
ON CONFLICT (id) DO NOTHING;

-- 17. One session_item per plan_exercise (id must be UUIDv7/client-generated style — gen_random_uuid is fine for seed).
INSERT INTO session_item (id, session_id, plan_exercise_id, skipped, logged_at)
SELECT
  gen_random_uuid(),
  'a0000001-0000-0000-0000-000000000300',
  pe.id,
  false,
  now()
FROM plan_exercise pe
WHERE pe.plan_phase_id = 'a0000001-0000-0000-0000-000000000210'
ON CONFLICT (id) DO NOTHING;

-- 18. Reflect the logged items back onto the session (normally
--     app.write_session_items does this; this is a direct seed insert).
UPDATE session
SET status = 'completed', items_done = items_planned, completion_ratio = 1, completed_at = now()
WHERE id = 'a0000001-0000-0000-0000-000000000300';

INSERT INTO adherence_daily (patient_id, date, planned, completed, completion_ratio)
VALUES ('a0000001-0000-0000-0000-000000000100', current_date, true, true, 1)
ON CONFLICT (patient_id, date) DO UPDATE
  SET planned = EXCLUDED.planned, completed = EXCLUDED.completed, completion_ratio = EXCLUDED.completion_ratio;
