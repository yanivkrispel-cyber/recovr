#!/usr/bin/env bash
# ============================================================================
# 0066 (catalog cleanup reconcile) against a production-like catalog.
#
#   bash supabase/tests/catalog_reconcile.test.sh
#
# Needs the local database built from the repo (supabase db reset; the
# dataset ingest isn't needed). It records that database's system catalog and
# protocols as the expected result, then, inside one transaction that is
# rolled back:
#   - rebuilds the catalog the way production got it: the pre-cleanup
#     protocols_import.sql (da959c3), then what production ran over it
#     (0032 grandfathering, 0039, 0041, 0043, 0044), checked against the
#     2026-10-07 audit's production numbers;
#   - adds patients on twelve protocols (one advanced to phase 3 with a
#     personal edit, one on a clinic copy) and clinic content on old rows;
#   - runs 0066 and checks the catalog and protocols now match the repo, what
#     each patient is offered, that merges carried clinic content along, that
#     taking a template update works, and that a second run changes nothing.
# A failed check aborts with its label.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

{
cat <<'SQL'
\set ON_ERROR_STOP on
\pset pager off
\o /dev/null
BEGIN;

CREATE FUNCTION pg_temp.eq(actual ANYELEMENT, expected ANYELEMENT, label TEXT) RETURNS VOID AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok  %', label;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.ex(p_name TEXT) RETURNS UUID AS $$
  SELECT extensions.uuid_generate_v5(extensions.uuid_ns_url(), 'recoveryos:exercise:' || p_name);
$$ LANGUAGE sql IMMUTABLE;

-- The repo's catalog and system protocols, as this database has them.
CREATE TEMP TABLE golden_ex AS
SELECT e.id, e.name, e.name_en, e.category, e.item_kind, e.status, br.slug AS region,
  COALESCE((SELECT array_agg(b2.slug ORDER BY b2.slug) FROM app.exercise_secondary_region s
            JOIN app.body_region b2 ON b2.id = s.body_region_id WHERE s.exercise_id = e.id), '{}') AS secondary,
  e.instruction_steps, e.key_cues, e.safety_notes, e.contraindications, e.default_prescription, e.instructions
FROM app.exercise e LEFT JOIN app.body_region br ON br.id = e.body_region_id
WHERE e.clinic_id IS NULL AND e.deleted_at IS NULL;

CREATE TEMP TABLE golden_tpl AS
SELECT p.slug, ph.n, row_number() OVER (PARTITION BY p.slug, ph.n ORDER BY ppe."order", ppe.exercise_id) AS pos,
  ppe.exercise_id, ppe.prescription, ppe.frequency
FROM app.protocol p JOIN app.protocol_phase ph ON ph.protocol_id = p.id
JOIN app.protocol_phase_exercise ppe ON ppe.protocol_phase_id = ph.id
WHERE p.clinic_id IS NULL;

SELECT pg_temp.eq((SELECT count(*) FROM golden_ex), 107::bigint, 'repo catalog: 107 live system exercises');
SELECT pg_temp.eq((SELECT count(*) FROM golden_tpl), 195::bigint, 'repo protocols: 195 entries');

SET client_min_messages = warning;
TRUNCATE app.protocol, app.exercise CASCADE;
SET client_min_messages = notice;
SQL

git show da959c3:supabase/seed/protocols_import.sql

cat <<'SQL'
SELECT app.catalog_backfill_governance() IS NOT NULL AS grandfathered;
SELECT app._catalog_link_dataset_media_2026_09_13();
SELECT app._catalog_fix_core_region_gaps_2026_09_13();
SELECT app._catalog_apply_p0_content_2026_09_13() IS NOT NULL AS p0_content;
SELECT app._catalog_apply_key_cues_2026_09_13() IS NOT NULL AS key_cues;

SELECT pg_temp.eq((SELECT count(*) FROM app.exercise WHERE clinic_id IS NULL AND deleted_at IS NULL), 149::bigint,
  'production-like: 149 core rows');
SELECT pg_temp.eq((SELECT count(*) FROM app.exercise WHERE clinic_id IS NULL AND deleted_at IS NULL
                     AND cardinality(instruction_steps) = 0 AND COALESCE(instructions, '') = ''
                     AND COALESCE(safety_notes, '') = ''), 72::bigint,
  'production-like: 72 core rows without instructions');
SELECT pg_temp.eq((SELECT string_agg(name_en, ', ' ORDER BY name_en) FROM app.exercise
                   WHERE clinic_id IS NULL AND deleted_at IS NULL AND status = 'approved' AND body_region_id IS NULL),
  'Balance Training, Bridge, Calf Raises, Eccentric Calf Raise, Foot Intrinsic Strengthening, Grip Strengthening, '
  'Hamstring Stretch, Hip Strengthening, Postural Correction, Quad Sets, Seated Calf Raise, Single-Leg Balance, '
  'Single-Leg Calf Raise, Stationary Bike, Straight Leg Raise',
  'production-like: the 15 pickable rows without a region');

CREATE TEMP TABLE tp (label TEXT, patient_id UUID, plan_id UUID);
DO $$
DECLARE
  r RECORD;
  v JSONB;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('P01', 'itb_syndrome'), ('P02', 'chronic_neck'), ('P03', 'shoulder_impingement'), ('P04', 'stress_fracture'),
    ('P05', 'hamstring_strain'), ('P06', 'adductor_strain'), ('P07', 'pfps'), ('P08', 'mcl_sprain'),
    ('P09', 'meniscus_tear'), ('P10', 'acl_tear'), ('P12', 'jumpers_knee')
  ) x(label, slug) LOOP
    v := app.create_patient_with_plan('22222222-2222-2222-2222-222222222222', r.label || ' ' || r.slug,
           lower(r.label) || '@reconcile.test', (SELECT id FROM app.protocol WHERE slug = r.slug AND clinic_id IS NULL), 1, '{}', NULL);
    IF v ? 'error' THEN RAISE EXCEPTION '%: %', r.label, v; END IF;
    INSERT INTO tp VALUES (r.label, (v ->> 'patient_id')::uuid, (v ->> 'plan_id')::uuid);
  END LOOP;

  -- P11: a clinic's own copy of jumpers_knee, which 0066 must leave alone
  v := app.protocol_duplicate('22222222-2222-2222-2222-222222222222',
         (SELECT id FROM app.protocol WHERE slug = 'jumpers_knee' AND clinic_id IS NULL));
  v := app.create_patient_with_plan('22222222-2222-2222-2222-222222222222', 'P11 copy', 'p11@reconcile.test',
         (v ->> 'id')::uuid, 1, '{}', NULL);
  IF v ? 'error' THEN RAISE EXCEPTION 'P11: %', v; END IF;
  INSERT INTO tp VALUES ('P11', (v ->> 'patient_id')::uuid, (v ->> 'plan_id')::uuid);
END $$;

-- P03 is in phase 3 and has its own prescription for an item the template replaces
SELECT app.write_phase_transition('clinic_demo', (SELECT plan_id FROM tp WHERE label = 'P03'), 1, 2, 'forward',
  '22222222-2222-2222-2222-222222222222', '{}'::jsonb, NULL) IS NOT NULL AS advanced;
SELECT app.write_phase_transition('clinic_demo', (SELECT plan_id FROM tp WHERE label = 'P03'), 2, 3, 'forward',
  '22222222-2222-2222-2222-222222222222', '{}'::jsonb, NULL) IS NOT NULL AS advanced;
UPDATE clinic_demo.plan_exercise pe SET sets = 4
FROM clinic_demo.plan_phase pp JOIN clinic_demo.plan_version pv ON pv.id = pp.plan_version_id AND pv.is_current
WHERE pe.plan_phase_id = pp.id AND pv.plan_id = (SELECT plan_id FROM tp WHERE label = 'P03') AND pp.n = 3
  AND pe.exercise_id = pg_temp.ex('חיזוק מותג הכתף');

INSERT INTO app.exercise_override (clinic_id, exercise_id, fields, revision) VALUES
  ('11111111-1111-1111-1111-111111111111', pg_temp.ex('Clamshells'), '{"instructions": "הוראות של המרפאה"}', 1),
  ('11111111-1111-1111-1111-111111111111', pg_temp.ex('הרמות עקב'), '{"safety_notes": "A", "key_cues": ["x"]}', 1),
  ('11111111-1111-1111-1111-111111111111', pg_temp.ex('הרמת עקב בעמידה'), '{"safety_notes": "B"}', 1);
INSERT INTO app.exercise_favorite (user_id, clinic_id, exercise_id) VALUES
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', pg_temp.ex('גלגול IT Band')),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', pg_temp.ex('גלגול ITB'));
INSERT INTO app.exercise_pick_event (clinic_id, user_id, picker_session_id, entry, exercise_id, event)
VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', gen_random_uuid(), 'plan',
        pg_temp.ex('Clamshells'), 'added');

SELECT pg_temp.eq((SELECT count(*) FROM tp WHERE app.get_plan('22222222-2222-2222-2222-222222222222', patient_id) -> 'template_update' <> 'null'::jsonb),
  0::bigint, 'before: every plan up to date');

-- db push runs with the default search_path; the plan functions SET LOCAL it
SET LOCAL search_path TO "$user", public, extensions;
SQL

cat supabase/migrations/0066_catalog_cleanup_reconcile.sql

cat <<'SQL'
SET LOCAL search_path TO "$user", public, extensions;

-- What each patient is offered, as one line per patient.
CREATE FUNCTION pg_temp.offered(p_label TEXT) RETURNS TEXT AS $$
  SELECT string_agg(format('%s:%s %s%s', c ->> 'phase_n', c ->> 'kind', c ->> 'name_en',
                           CASE WHEN (c ->> 'conflict')::boolean THEN ' [conflict]' ELSE '' END),
                    '; ' ORDER BY (c ->> 'phase_n')::int, c ->> 'kind', c ->> 'name_en')
  FROM jsonb_array_elements(app.plan_template_diff('22222222-2222-2222-2222-222222222222',
         (SELECT patient_id FROM tp WHERE label = p_label)) -> 'changes') c;
$$ LANGUAGE sql;

-- Catalog vs the repo. Two differences are expected and allowed:
--   - one generic 0044 cue where the repo row has none: 0044 also runs from
--     scripts/ingest-exercises.ts, so a repo database gets it after ingest;
--   - a region where the repo row has none: inferred before the cleanup made
--     the row multi-region; kept, since 0066 never clears a region.
CREATE TEMP TABLE catalog_diff AS
WITH cur AS (
  SELECT e.id, e.name, e.name_en, e.category, e.item_kind, e.status, br.slug AS region,
    COALESCE((SELECT array_agg(b2.slug ORDER BY b2.slug) FROM app.exercise_secondary_region s
              JOIN app.body_region b2 ON b2.id = s.body_region_id WHERE s.exercise_id = e.id), '{}') AS secondary,
    e.instruction_steps, e.key_cues, e.safety_notes, e.contraindications, e.default_prescription, e.instructions
  FROM app.exercise e LEFT JOIN app.body_region br ON br.id = e.body_region_id
  WHERE e.clinic_id IS NULL AND e.deleted_at IS NULL
)
SELECT g.name_en, concat_ws(', ',
    CASE WHEN c.id IS NULL THEN 'missing' END,
    CASE WHEN c.name IS DISTINCT FROM g.name OR c.name_en IS DISTINCT FROM g.name_en THEN 'name' END,
    CASE WHEN c.category IS DISTINCT FROM g.category THEN 'category' END,
    CASE WHEN c.item_kind IS DISTINCT FROM g.item_kind THEN 'item_kind' END,
    CASE WHEN c.status IS DISTINCT FROM g.status THEN 'status' END,
    CASE WHEN c.region IS DISTINCT FROM g.region AND g.region IS NOT NULL THEN 'region' END,
    CASE WHEN c.secondary IS DISTINCT FROM g.secondary THEN 'secondary' END,
    CASE WHEN c.instruction_steps IS DISTINCT FROM g.instruction_steps THEN 'steps' END,
    CASE WHEN c.key_cues IS DISTINCT FROM g.key_cues
          AND NOT (cardinality(g.key_cues) = 0 AND cardinality(c.key_cues) = 1 AND c.key_cues[1] = ANY (ARRAY[
            'מתחו לאט עד לתחושת מתיחה קלה, ללא קפיצות ולא עד כאב',
            'שמרו על יציבות המנח לאורך כל זמן ההחזקה ונשמו באופן סדיר',
            'שמרו על קצב אחיד ונשימה סדירה לאורך כל התרגיל',
            'בצעו בטווח תנועה נוח ובשליטה, ללא כאב',
            'בצעו בטווח תנועה מלא ובקצב מבוקר, ללא נדנוד בגוף'])) THEN 'key_cues' END,
    CASE WHEN c.safety_notes IS DISTINCT FROM g.safety_notes OR c.contraindications IS DISTINCT FROM g.contraindications THEN 'safety' END,
    CASE WHEN c.default_prescription IS DISTINCT FROM g.default_prescription THEN 'dosage' END,
    CASE WHEN c.instructions IS DISTINCT FROM g.instructions THEN 'instructions' END) AS diff
FROM golden_ex g LEFT JOIN cur c ON c.id = g.id;
\o
SELECT name_en, diff FROM catalog_diff WHERE diff <> '' ORDER BY 1;
\o /dev/null
SELECT pg_temp.eq((SELECT count(*) FROM catalog_diff WHERE diff <> ''), 0::bigint, 'catalog matches the repo');

SELECT pg_temp.eq((SELECT string_agg(DISTINCT status, ',') || ' x' || count(*) FROM app.exercise
                   WHERE clinic_id IS NULL AND deleted_at IS NULL AND id NOT IN (SELECT id FROM golden_ex)),
  'archived x17', 'only the 17 replaced generic rows are left over, archived');

SELECT pg_temp.eq((
  WITH cur AS (
    SELECT p.slug, ph.n, row_number() OVER (PARTITION BY p.slug, ph.n ORDER BY ppe."order", ppe.exercise_id) AS pos,
      ppe.exercise_id, ppe.prescription, ppe.frequency
    FROM app.protocol p JOIN app.protocol_phase ph ON ph.protocol_id = p.id
    JOIN app.protocol_phase_exercise ppe ON ppe.protocol_phase_id = ph.id
    WHERE p.clinic_id IS NULL
  )
  SELECT count(*) FROM cur c FULL JOIN golden_tpl g USING (slug, n, pos)
  WHERE c.exercise_id IS DISTINCT FROM g.exercise_id OR c.prescription IS DISTINCT FROM g.prescription
     OR c.frequency IS DISTINCT FROM g.frequency), 0::bigint, 'system protocols match the repo');

SELECT pg_temp.eq(pg_temp.offered('P01'), NULL::text, 'P01 itb_syndrome (merges only): nothing offered');
SELECT pg_temp.eq(pg_temp.offered('P07'), NULL::text, 'P07 pfps (merges only): nothing offered');
SELECT pg_temp.eq(pg_temp.offered('P10'), NULL::text, 'P10 acl_tear (merges only): nothing offered');
SELECT pg_temp.eq(pg_temp.offered('P11'), NULL::text, 'P11 clinic copy: nothing offered');
SELECT pg_temp.eq(pg_temp.offered('P02'),
  '1:remove Cervical Retraction; 4:add Scapular Retraction; 4:remove Postural Correction', 'P02 chronic_neck');
SELECT pg_temp.eq(pg_temp.offered('P03'),
  '3:add Band External Rotation; 3:remove Rotator Cuff Strengthening [conflict]; 4:add Prone Y-T-W; 4:remove Postural Correction',
  'P03 shoulder_impingement: completed phases untouched, personal edit kept by default');
SELECT pg_temp.eq(pg_temp.offered('P04'),
  '1:add Ankle Alphabet; 1:remove Non-Weight-Bearing ROM; 2:add Isometric Calf Hold; 2:remove Isometric Strengthening; '
  '3:add Stationary Bike; 3:remove Low-Impact Cardio', 'P04 stress_fracture');
SELECT pg_temp.eq(pg_temp.offered('P05'),
  '1:remove Nordic Hamstring Curl; 4:add Nordic Hamstring Curl; 4:remove Eccentric Hamstring Loading', 'P05 hamstring_strain');
SELECT pg_temp.eq(pg_temp.offered('P06'),
  '1:remove Copenhagen Plank; 2:add Side-Lying Hip Abduction; 2:remove Hip Strengthening; 3:add Copenhagen Plank; '
  '3:add Dead Bug; 3:remove Core Stability', 'P06 adductor_strain');
SELECT pg_temp.eq(pg_temp.offered('P08'), '1:add Heel slide; 1:remove ROM Exercises', 'P08 mcl_sprain');
SELECT pg_temp.eq(pg_temp.offered('P09'), '1:add Heel slide; 1:remove ROM Exercises', 'P09 meniscus_tear');
SELECT pg_temp.eq(pg_temp.offered('P12'), '2:remove Quad Strengthening; 4:remove Plyometric Progression', 'P12 jumpers_knee');
SET LOCAL search_path TO "$user", public, extensions;

SELECT pg_temp.eq((SELECT count(*) FROM clinic_demo.plan_exercise pe JOIN app.exercise e ON e.id = pe.exercise_id
                   WHERE e.deleted_at IS NOT NULL), 0::bigint, 'no plan row on a merged exercise');
SELECT pg_temp.eq((SELECT count(*) FROM clinic_demo.plan_exercise pe JOIN app.exercise e ON e.id = pe.exercise_id
                   WHERE pe.deleted_at IS NULL AND COALESCE(cardinality(e.instruction_steps), 0) = 0 AND e.status <> 'archived'),
  0::bigint, 'every plan exercise has instructions, bar the archived generic rows awaiting review');
SELECT pg_temp.eq((SELECT count(*) FROM app.protocol_version pv, jsonb_array_elements(pv.snapshot) ph,
                     jsonb_array_elements(ph -> 'exercises') x
                   JOIN app.exercise e ON e.id = (x ->> 'exercise_id')::uuid WHERE e.deleted_at IS NOT NULL),
  0::bigint, 'no saved protocol version names a merged exercise');

SELECT pg_temp.eq((SELECT fields FROM app.exercise_override WHERE exercise_id = pg_temp.ex('צדפה (Clamshell)')),
  '{"instructions": "הוראות של המרפאה"}'::jsonb, 'clinic version moved to the merged-into row');
SELECT pg_temp.eq((SELECT fields FROM app.exercise_override WHERE exercise_id = pg_temp.ex('הרמת עקב בעמידה')),
  '{"key_cues": ["x"], "safety_notes": "B"}'::jsonb, 'clinic versions combined, the target''s fields win');
SELECT pg_temp.eq((SELECT string_agg(e.name_en, ',') FROM app.exercise_favorite f JOIN app.exercise e ON e.id = f.exercise_id),
  'Foam Rolling: ITB', 'two favorites of merged rows became one');
SELECT pg_temp.eq((SELECT count(*) FROM app.exercise_pick_event WHERE exercise_id = pg_temp.ex('צדפה (Clamshell)')),
  1::bigint, 'pick history follows the merge');
SELECT pg_temp.eq((SELECT count(*) FROM app.exercise_media WHERE exercise_id = pg_temp.ex('הרחקת ירך בשכיבה על הצד')
                     AND verified_at IS NULL AND rights = 'unknown'),
  2::bigint, 'Side-Lying Hip Abduction got the step-4 animation, unverified');

DO $$
DECLARE
  v_pid UUID := (SELECT patient_id FROM tp WHERE label = 'P02');
  d JSONB;
  r JSONB;
BEGIN
  d := app.plan_template_diff('22222222-2222-2222-2222-222222222222', v_pid);
  r := app.apply_plan_template_update('22222222-2222-2222-2222-222222222222', v_pid, (d ->> 'plan_version')::int,
         (d -> 'latest' ->> 'id')::uuid,
         ARRAY(SELECT c ->> 'key' FROM jsonb_array_elements(d -> 'changes') c WHERE (c ->> 'default_accept')::boolean), NULL);
  PERFORM pg_temp.eq(r ->> 'applied', '3', 'P02: taking the offered changes applies them');
  PERFORM pg_temp.eq(app.get_plan('22222222-2222-2222-2222-222222222222', v_pid) -> 'template_update', 'null'::jsonb,
    'P02: up to date afterwards');
END $$;
SET LOCAL search_path TO "$user", public, extensions;

CREATE TEMP TABLE after1 AS SELECT
  (SELECT count(*) FROM app.exercise_revision) AS revisions,
  (SELECT count(*) FROM app.protocol_version) AS versions,
  (SELECT count(*) FROM app.protocol_phase_exercise) AS template_rows,
  (SELECT sum(revision) FROM app.exercise) AS revision_sum,
  (SELECT count(*) FROM app.exercise WHERE deleted_at IS NULL) AS live_rows;
SQL

cat supabase/migrations/0066_catalog_cleanup_reconcile.sql

cat <<'SQL'
SELECT pg_temp.eq((SELECT row(a.*)::text FROM after1 a),
  (SELECT row((SELECT count(*) FROM app.exercise_revision), (SELECT count(*) FROM app.protocol_version),
              (SELECT count(*) FROM app.protocol_phase_exercise), (SELECT sum(revision) FROM app.exercise),
              (SELECT count(*) FROM app.exercise WHERE deleted_at IS NULL))::text),
  'a second run changes nothing');

ROLLBACK;
SQL
} | docker exec -i supabase_db_recoveryos psql -U postgres -X -q
