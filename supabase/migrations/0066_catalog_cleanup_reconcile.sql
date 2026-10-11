-- ============================================================================
-- Catalog cleanup, part 2: bring production's catalog, seeded before
-- 2026-09-13, in line with the repo.
--
-- The September cleanup (0035-0044) changed the catalog in places that never
-- run on a database seeded before it:
--   - protocols_import.sql / protocols-data.json (renames, merges, replaced
--     protocol entries) and the tail of seed.sql (three cross-source merges,
--     region / category / item_kind fixes);
--   - the content migrations (0037, 0039, 0041) wrote to rows by id, and the
--     cleaned-up rows' ids (uuid_generate_v5 of the new Hebrew name) don't
--     exist there.
-- So production still has 69 pre-cleanup core rows (52 renamed or merged
-- away, 17 generic entries the cleanup replaced), lacks 30 cleaned-up rows,
-- and 72 core rows have no instructions. Detail in
-- docs/research/exercise-library-audit-2026-10-07/README.md.
--
-- Pre-cleanup rows are found by the id the seed gave them (uuid_generate_v5
-- of their original Hebrew name), so a later rename can't hide one.
--   1. Create the 30 missing rows with the repo's ids, names, category and
--      regions (as a database built from the repo has them), and their
--      step-3 content: the matching entries of
--      scripts/_p0-content-patches-2026-09-13.json.
--   2. Merge the 52 renamed rows, and the 3 rows seed.sql folds into the
--      hand-written e0000001 rows, into their row (catalog_merge_exercise).
--      Protocols, patient plans, media, favorites, clinic versions and pick
--      history follow. It's the same exercise under its corrected name, so
--      plans change without review: patients see the new name and its
--      instructions, with the same prescription.
--   3. Apply the cleanup's protocol edits to the system protocols (6
--      removals, 17 replacements, 1 addition), each only where the protocol
--      still has the original entry, then snapshot each changed protocol.
--      Patients already on it are offered the change per patient through
--      the template review (0061); no plan changes here.
--   4. Archive the 17 replaced generic rows ("Rotator Cuff Strengthening",
--      "ROM Exercises"...), unless a system protocol still uses one. Plans
--      that use one keep it until the clinician takes the template change.
--   5. The seed.sql-only fixes: regions, categories, item kinds (and the
--      generic cue 0044 gave the education/program items).
-- Nothing a person edited is overwritten: content only fills rows without
-- instruction steps, regions only fill NULLs, categories and kinds only move
-- off the import's value. Writes go through catalog_save_exercise /
-- catalog_set_status / catalog_merge_exercise as a catalog curator, so they
-- show in each exercise's history.
--
-- No-op on a fresh database (the seed runs after migrations and builds the
-- cleaned-up catalog itself) and on one seeded after the cleanup.
-- ============================================================================

-- 0035's merge, plus two things it missed:
--   - a clinic's own version of the merged row (exercise_override) moves to
--     the target; where the clinic has one for both, the target's fields win;
--   - saved protocol versions (0057) point at the target too. A merge is the
--     same exercise under one id, not a template edit: left alone, every plan
--     on a protocol that used the merged row would be offered a template
--     update that only swaps the id.
CREATE OR REPLACE FUNCTION app.catalog_merge_exercise(p_clinician_id UUID, p_from_id UUID, p_to_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_from app.exercise;
  v_to app.exercise;
  v_schema TEXT;
BEGIN
  IF p_clinician_id IS NOT NULL AND NOT app.is_catalog_curator(p_clinician_id) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_from_id = p_to_id THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'same_exercise');
  END IF;

  SELECT * INTO v_from FROM app.exercise WHERE id = p_from_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO v_to FROM app.exercise WHERE id = p_to_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_from IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_from.clinic_id IS NOT NULL OR v_to.clinic_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'validation_failed', 'message', 'master_rows_only');
  END IF;

  UPDATE app.protocol_phase_exercise SET exercise_id = p_to_id WHERE exercise_id = p_from_id;
  UPDATE app.exercise_media SET exercise_id = p_to_id WHERE exercise_id = p_from_id;

  -- exercise_favorite has PK (user_id, exercise_id): repoint only where the
  -- user doesn't already favorite the target, drop the rest to avoid a
  -- conflict.
  UPDATE app.exercise_favorite f SET exercise_id = p_to_id
  WHERE f.exercise_id = p_from_id
    AND NOT EXISTS (SELECT 1 FROM app.exercise_favorite g WHERE g.user_id = f.user_id AND g.exercise_id = p_to_id);
  DELETE FROM app.exercise_favorite WHERE exercise_id = p_from_id;

  UPDATE app.exercise_pick_event SET exercise_id = p_to_id WHERE exercise_id = p_from_id;

  INSERT INTO app.exercise_override (clinic_id, exercise_id, fields, revision, updated_by, updated_at)
  SELECT o.clinic_id, p_to_id, o.fields, 0, o.updated_by, now()
  FROM app.exercise_override o
  WHERE o.exercise_id = p_from_id
  ON CONFLICT (clinic_id, exercise_id) DO UPDATE
    SET fields = EXCLUDED.fields || app.exercise_override.fields,
        revision = app.exercise_override.revision + 1,
        updated_at = now();
  DELETE FROM app.exercise_override WHERE exercise_id = p_from_id;

  FOR v_schema IN SELECT 'clinic_' || slug FROM app.clinic LOOP
    IF to_regclass(format('%I.plan_exercise', v_schema)) IS NOT NULL THEN
      EXECUTE format('UPDATE %I.plan_exercise SET exercise_id = $1 WHERE exercise_id = $2', v_schema)
        USING p_to_id, p_from_id;
    END IF;
  END LOOP;

  -- Exercises re-sorted like app._protocol_content(), so a protocol whose
  -- content didn't otherwise change still equals its latest snapshot.
  UPDATE app.protocol_version pv
  SET snapshot = (
    SELECT COALESCE(jsonb_agg(
      jsonb_set(ph, '{exercises}', (
        SELECT COALESCE(jsonb_agg(x.e ORDER BY (x.e ->> 'order')::int, (x.e ->> 'exercise_id')::uuid), '[]'::jsonb)
        FROM (
          SELECT CASE WHEN e ->> 'exercise_id' = p_from_id::text
                      THEN jsonb_set(e, '{exercise_id}', to_jsonb(p_to_id::text))
                      ELSE e END AS e
          FROM jsonb_array_elements(ph -> 'exercises') e
        ) x
      ))
      ORDER BY t.ord), '[]'::jsonb)
    FROM jsonb_array_elements(pv.snapshot) WITH ORDINALITY AS t(ph, ord)
  )
  WHERE pv.snapshot::text LIKE '%' || p_from_id::text || '%';

  UPDATE app.exercise SET
    aliases = ARRAY(
      SELECT DISTINCT x FROM unnest(aliases || ARRAY[v_from.name_en, v_from.name] || COALESCE(v_from.aliases, '{}')) x
      WHERE x IS NOT NULL AND btrim(x) <> ''
    ),
    revision = revision + 1, updated_at = now()
  WHERE id = p_to_id;

  UPDATE app.exercise SET
    status = 'archived', is_active = false, deleted_at = now(), updated_at = now()
  WHERE id = p_from_id;

  INSERT INTO app.exercise_revision (exercise_id, clinic_id, scope, action, changes, changed_by)
  VALUES (p_to_id, NULL, 'master', 'duplicate',
          jsonb_build_object('merged_from', jsonb_build_object('id', p_from_id, 'name', v_from.name, 'name_en', v_from.name_en)),
          p_clinician_id);

  RETURN jsonb_build_object('ok', true, 'from', p_from_id, 'to', p_to_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION app.catalog_merge_exercise(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.catalog_merge_exercise(UUID, UUID, UUID) TO authenticated, service_role;

-- id protocols_import.sql gives a system exercise: uuid_generate_v5 of its
-- Hebrew name.
CREATE OR REPLACE FUNCTION pg_temp.rc_exercise_id(p_name TEXT) RETURNS UUID AS $$
  SELECT uuid_generate_v5(uuid_ns_url(), 'recoveryos:exercise:' || p_name);
$$ LANGUAGE sql IMMUTABLE SET search_path = extensions, public;

DO $reconcile$
DECLARE
  -- 1. The 30 rows a pre-cleanup catalog lacks, as a database built from the
  -- repo has them (27 from protocols-data.json, 3 hand-written in seed.sql).
  v_new JSONB := $j$[
    {"id":"c3f7957b-6e36-53c7-afd7-a50dfafe9a2f","name":"ריצה במים","name_en":"Aqua Jogging","category":"Cardio","region":"lower_leg","secondary":[],"instructions":null},
    {"id":"d7cddd6e-b488-5c55-bafc-18c3a72a48a4","name":"לחיצת כדור","name_en":"Ball Squeeze","category":"Strength","region":"wrist_hand","secondary":[],"instructions":null},
    {"id":"c88c65d7-b3df-5619-a9c9-33b7db52d314","name":"כפיפה דורסלית של הקרסול עם גומייה","name_en":"Band Ankle Dorsiflexion","category":"Strength","region":"lower_leg","secondary":[],"instructions":null},
    {"id":"ffcc95d6-b08b-5915-850b-579c70cccc8a","name":"רוטציה חיצונית עם גומייה","name_en":"Band External Rotation","category":"Strength","region":"shoulder","secondary":[],"instructions":null},
    {"id":"098634a9-3b7e-5aa7-a087-02b4ea79e2be","name":"פשיטת שורש כף היד עם גומייה","name_en":"Band Wrist Extension","category":"Strength","region":"elbow","secondary":[],"instructions":null},
    {"id":"948725e5-4e3d-5e2e-9432-02fe68518590","name":"סקוואט במשקל גוף","name_en":"Bodyweight Squat","category":"Strength","region":"hip_thigh","secondary":[],"instructions":null},
    {"id":"2de558fb-f2cb-5a23-b6b7-fe6595bd2a5f","name":"משיכת סנטר (רטרקציה צווארית)","name_en":"Chin Tuck","category":"Strength","region":"spine","secondary":[],"instructions":null},
    {"id":"d11ec357-84e1-5f12-b70a-c6632b5c3a9c","name":"צדפה (Clamshell)","name_en":"Clamshell","category":"Strength","region":"knee","secondary":[],"instructions":null},
    {"id":"90572bc2-9ce3-5ab5-8c30-e69ceb4cbfb6","name":"פשיטת שורש כף היד אקסצנטרית","name_en":"Eccentric Wrist Extension","category":"Strength","region":"elbow","secondary":[],"instructions":null},
    {"id":"5b0ebaa6-5347-5ca2-9fff-6be16f475469","name":"כפיפה ויישור של המרפק","name_en":"Elbow Flexion–Extension ROM","category":"Mobility","region":"elbow","secondary":[],"instructions":null},
    {"id":"29e9e464-8f4a-5e7a-90ed-f4f8b8e7db16","name":"גלגול ITB על גליל","name_en":"Foam Rolling: ITB","category":"Mobility","region":"knee","secondary":[],"instructions":null},
    {"id":"e0000001-0000-0000-0000-000000000002","name":"החלקת עקב","name_en":"Heel slide","category":"Mobility","region":"knee","secondary":[],"instructions":"שכב על הגב. החלק את העקב לכיוון הישבן תוך כדי הרפיית הברך. חזור למצב התחלתי."},
    {"id":"d754ef4e-992e-57c0-8f26-ba9799535bdd","name":"החזקה איזומטרית בהרמת עקב","name_en":"Isometric Calf Hold","category":"Strength","region":"lower_leg","secondary":["ankle_foot"],"instructions":null},
    {"id":"e8c494ad-0803-52bc-884d-402760aa25de","name":"פשיטת שורש כף היד איזומטרית","name_en":"Isometric Wrist Extension","category":"Strength","region":"elbow","secondary":[],"instructions":null},
    {"id":"043e6dae-a316-5a95-811d-40200cc5f70f","name":"כפיפת בטן מק'גיל","name_en":"McGill Curl-Up","category":"Strength","region":"spine","secondary":[],"instructions":null},
    {"id":"0dcb2055-19db-5cc0-8c22-4aea813e2563","name":"לחיצה מעל הראש","name_en":"Overhead Press","category":"Strength","region":"shoulder","secondary":[],"instructions":null},
    {"id":"15fcf5ae-5d19-55dd-af51-94f3e12d58c5","name":"מתיחת הפסציה הפלנטרית","name_en":"Plantar Fascia Stretch","category":"Mobility","region":"ankle_foot","secondary":[],"instructions":null},
    {"id":"08615396-5a27-5662-aeba-e9ee953afbe4","name":"קפיצות פוגו","name_en":"Pogo Hops","category":"Strength","region":"ankle_foot","secondary":[],"instructions":null},
    {"id":"e09d5ed8-0f56-58c0-9f14-8684dfd1f86f","name":"יישור גב בשכיבה על הבטן (מקנזי)","name_en":"Prone Press-Ups (McKenzie)","category":"Mobility","region":"spine","secondary":[],"instructions":null},
    {"id":"e0000001-0000-0000-0000-000000000001","name":"כיווץ ירך-ארבע ראשי","name_en":"Quad set","category":"Strength","region":"knee","secondary":[],"instructions":"שכב על הגב עם רגליים ישרות. כווץ את שריר הירך הקדמי ולחץ את הברך כלפי המזרן. החזק 5 שניות."},
    {"id":"befdabab-0e7e-53bf-9a4b-910e57ba5491","name":"החלקת עצב סיאטי","name_en":"Sciatic Nerve Glide","category":"Mobility","region":"spine","secondary":[],"instructions":null},
    {"id":"556e61a4-c2c5-5cf5-88de-24d8bc9a9e2b","name":"תרגיל כף רגל קצרה","name_en":"Short Foot Exercise","category":"Strength","region":"ankle_foot","secondary":[],"instructions":null},
    {"id":"17622353-f0f1-5592-a250-169312932696","name":"הרחקת ירך בשכיבה על הצד","name_en":"Side-Lying Hip Abduction","category":"Strength","region":"hip_thigh","secondary":["knee"],"instructions":null},
    {"id":"c1d8b972-7e36-59ba-97c7-dc9b6f04b02a","name":"מתיחת Sleeper (רוטציה פנימית בשכיבה על הצד)","name_en":"Sleeper Stretch","category":"Mobility","region":"shoulder","secondary":[],"instructions":null},
    {"id":"ddaca530-c2a8-51a1-a7c3-ed637c04e7c1","name":"כפיפת ירך בעמידה עם גומייה","name_en":"Standing Hip Flexion with Band","category":"Strength","region":"hip_thigh","secondary":[],"instructions":null},
    {"id":"e0000001-0000-0000-0000-000000000003","name":"הרמת רגל ישרה","name_en":"Straight leg raise","category":"Strength","region":"knee","secondary":[],"instructions":"שכב על הגב, רגל אחת כפופה והשנייה ישרה. הרים את הרגל הישרה לגובה הברך הכפופה, החזק 3 שניות, הורד לאט."},
    {"id":"43ce86f8-2c9d-5ec1-a77a-3932a9c95109","name":"יישור ברך סופי עם גומייה (TKE)","name_en":"Terminal Knee Extension (Band)","category":"Strength","region":"knee","secondary":[],"instructions":null},
    {"id":"7aaacbcd-3d78-5aed-971d-21cce45473c2","name":"תרגילי אצבעות עם פלסטלינה טיפולית","name_en":"Therapy Putty Finger Exercises","category":"Strength","region":"wrist_hand","secondary":[],"instructions":null},
    {"id":"4417da53-4f5f-535b-b14b-404d5b1b6831","name":"יישור עמוד שדרה חזי","name_en":"Thoracic Extension","category":"Mobility","region":"spine","secondary":[],"instructions":null},
    {"id":"7974743a-c7e1-5e89-9f5b-9fd841fe4204","name":"מתיחת פושטי שורש כף היד","name_en":"Wrist Extensor Stretch","category":"Mobility","region":"elbow","secondary":[],"instructions":null}
  ]$j$;

  -- Their step-3 content, verbatim from scripts/_p0-content-patches-2026-09-13.json.
  v_content JSONB := $j$[
    {"id":"e0000001-0000-0000-0000-000000000003","patch":{"instruction_steps":["לשכב על הגב, רגל אחת כפופה והשנייה ישרה","להרים את הרגל הישרה עד לגובה הברך הכפופה ולהחזיק 3 שניות","להוריד את הרגל לאט לרצפה"],"key_cues":["לשמור על הברך נעולה וישרה","לא להרים גבוה מהברך השנייה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":12,"rest_sec":45}}},
    {"id":"e0000001-0000-0000-0000-000000000001","patch":{"instruction_steps":["לשכב על הגב עם הרגליים ישרות","לכווץ את שריר הירך הקדמי ולדחוף את הברך כלפי המזרן","להחזיק ואז להרפות"],"key_cues":["לנשום באופן חופשי במהלך הכיווץ","להרגיש כיווץ בחלק הקדמי של הירך"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":5,"rest_sec":30}}},
    {"id":"e0000001-0000-0000-0000-000000000002","patch":{"instruction_steps":["לשכב על הגב עם הרגליים ישרות","להחליק את העקב לאט לכיוון הישבן תוך כיפוף הברך","לחזור לאט למצב ההתחלתי"],"key_cues":["התנועה צריכה להיות חלקה וללא קפיצות","לעצור אם מורגש כאב חד בברך"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":2,"reps":12,"rest_sec":30}}},
    {"id":"ffcc95d6-b08b-5915-850b-579c70cccc8a","patch":{"instruction_steps":["לעמוד עם מרפק כפוף 90 מעלות צמוד לגוף, גומייה מחוברת מהצד","לסובב את האמה החוצה תוך שמירה על המרפק צמוד לגוף","לחזור לאט למצב ההתחלתי"],"key_cues":["המרפק לא זז מהגוף לאורך כל התנועה","תנועה איטית ונשלטת"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":12,"rest_sec":45}}},
    {"id":"d754ef4e-992e-57c0-8f26-ba9799535bdd","patch":{"instruction_steps":["לעמוד עם המשקל על כף הרגל הפגועה, אפשר להיעזר בקיר לאיזון","לעלות מעט על קצות האצבעות ולהחזיק את התנוחה","לרדת לאט ולנוח"],"key_cues":["נשימה חופשית לאורך ההחזקה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":20,"rest_sec":45}}},
    {"id":"17622353-f0f1-5592-a250-169312932696","patch":{"instruction_steps":["לשכב על הצד עם הרגליים ישרות זו על זו","להרים את הרגל העליונה כלפי מעלה תוך שמירה על האגן יציב","להוריד לאט חזרה"],"key_cues":["לא לסובב את האגן אחורה","תנועה מהירך, לא מהגב"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"d7cddd6e-b488-5c55-bafc-18c3a72a48a4","patch":{"instruction_steps":["להחזיק כדור רך או מגבת מגולגלת בכף היד","ללחוץ בחוזקה ולהחזיק","לשחרר לאט"],"key_cues":["לחיצה מלאה מבלי לכאוב"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":5,"rest_sec":30}}},
    {"id":"d11ec357-84e1-5f12-b70a-c6632b5c3a9c","patch":{"instruction_steps":["לשכב על הצד עם ברכיים כפופות וגומייה מעל הברכיים","לפתוח את הברך העליונה כלפי מעלה תוך שמירה על כפות הרגליים צמודות","לסגור לאט חזרה"],"key_cues":["האגן נשאר יציב, לא מתגלגל אחורה","התנועה מהירך"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"29e9e464-8f4a-5e7a-90ed-f4f8b8e7db16","patch":{"instruction_steps":["לשכב על הצד עם גליל קצף מתחת לירך החיצונית","להתגלגל לאט מהירך ועד מעל הברך","להתעכב מעט על נקודות רגישות"],"key_cues":["לחץ בינוני, לא חזק מדי"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"duration","duration_min":2}}},
    {"id":"0dcb2055-19db-5cc0-8c22-4aea813e2563","patch":{"instruction_steps":["לעמוד או לשבת זקוף, גומייה מתחת לרגליים או משקולת קלה בכל יד","ללחוץ את הידיים כלפי מעלה עד יישור כמעט מלא של המרפקים","להוריד לאט חזרה לגובה הכתפיים"],"key_cues":["לא לקמר יתר בגב התחתון","תנועה איטית ונשלטת"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":12,"rest_sec":45}}},
    {"id":"556e61a4-c2c5-5cf5-88de-24d8bc9a9e2b","patch":{"instruction_steps":["לשבת עם כף הרגל שטוחה על הרצפה","לקצר את כף הרגל על ידי קירוב הבוהן הגדולה לעקב, מבלי לכופף אצבעות","להחזיק ולשחרר"],"key_cues":["האצבעות נשארות ארוכות ורפויות"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":5,"rest_sec":20}}},
    {"id":"c1d8b972-7e36-59ba-97c7-dc9b6f04b02a","patch":{"instruction_steps":["לשכב על הצד הפגוע, הזרוע מתחת לגוף כפופה 90 מעלות","להשתמש ביד השנייה כדי ללחוץ בעדינות את האמה כלפי מטה, לכיוון הרצפה","להחזיק עד תחושת מתיחה עדינה בכתף האחורית"],"key_cues":["לחץ עדין בלבד, לא כואב"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":25,"rest_sec":15}}},
    {"id":"c3f7957b-6e36-53c7-afd7-a50dfafe9a2f","patch":{"instruction_steps":["להיכנס לבריכה עמוקה עם חגורת ציפה","לבצע תנועת ריצה טבעית במים ללא מגע עם הקרקע","לשמור על קצב נוח לאורך הזמן שנקבע"],"key_cues":[],"safety_notes":"יש להפסיק בסחרחורת, קוצר נשימה חריג או כאב בחזה.","contraindications":null,"default_prescription":{"mode":"duration","duration_min":15}}},
    {"id":"c88c65d7-b3df-5619-a9c9-33b7db52d314","patch":{"instruction_steps":["לשבת עם גומייה כרוכה סביב כף הרגל ומחוברת קבוע מלפנים","למשוך את כף הרגל כלפי הגוף כנגד התנגדות הגומייה","לשחרר לאט חזרה"],"key_cues":["תנועה מהקרסול בלבד"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"098634a9-3b7e-5aa7-a087-02b4ea79e2be","patch":{"instruction_steps":["לשבת עם האמה נשענת על שולחן, כף יד כלפי מטה, גומייה מתחת לכף הרגל ואחוזה ביד","להרים את גב כף היד כלפי מעלה כנגד התנגדות הגומייה","להוריד לאט"],"key_cues":["רק שורש כף היד זז, לא כל הזרוע"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"948725e5-4e3d-5e2e-9432-02fe68518590","patch":{"instruction_steps":["לעמוד עם הרגליים ברוחב הכתפיים","לרדת לאחור כמו ישיבה על כיסא, ברכיים מעל הקרסוליים","לעלות חזרה למעלה"],"key_cues":["המשקל על העקבים","הגב נשאר זקוף"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":12,"rest_sec":45}}},
    {"id":"2de558fb-f2cb-5a23-b6b7-fe6595bd2a5f","patch":{"instruction_steps":["לשבת או לעמוד זקוף","למשוך את הסנטר אחורה כאילו יוצרים ״כפל סנטר״, מבלי להרכין את הראש","להחזיק ולשחרר"],"key_cues":["מבט קדימה לאורך כל התרגיל"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":5,"rest_sec":20}}},
    {"id":"90572bc2-9ce3-5ab5-8c30-e69ceb4cbfb6","patch":{"instruction_steps":["לשבת עם האמה נשענת, כף יד כלפי מטה מעבר לקצה השולחן, מחזיקים משקולת קלה","להרים את היד ליישור מלא בעזרת היד השנייה","להוריד לבד לאט ובשליטה"],"key_cues":["הירידה איטית, כ-4 שניות"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"5b0ebaa6-5347-5ca2-9fff-6be16f475469","patch":{"instruction_steps":["לשבת עם הזרוע במנוחה לצד הגוף","לכופף את המרפק במלואו ואז ליישר לגמרי","לחזור לאט"],"key_cues":["טווח מלא ונוח"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":2,"reps":12,"rest_sec":20}}},
    {"id":"e8c494ad-0803-52bc-884d-402760aa25de","patch":{"instruction_steps":["לשבת עם האמה נשענת על שולחן, כף יד תלויה בקצה","להרים את גב כף היד כלפי מעלה כנגד יד המפעילה התנגדות קלה","להחזיק ולשחרר"],"key_cues":["תנועה קטנה בלבד"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":5,"rest_sec":30}}},
    {"id":"043e6dae-a316-5a95-811d-40200cc5f70f","patch":{"instruction_steps":["לשכב על הגב, רגל אחת כפופה והשנייה ישרה, ידיים מתחת לגב התחתון","להרים את הראש והכתפיים מעט מהרצפה מבלי לכופף את הגב התחתון","להחזיק ולהוריד לאט"],"key_cues":["תנועה קטנה, הדגש על כיווץ ולא על גובה ההרמה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":"להימנע בכאב גב חריף","default_prescription":{"mode":"hold","sets":3,"hold_sec":7,"rest_sec":30}}},
    {"id":"15fcf5ae-5d19-55dd-af51-94f3e12d58c5","patch":{"instruction_steps":["לשבת ולהניח את הרגל הפגועה על הברך השנייה","לאחוז באצבעות כף הרגל ולמשוך אותן לאחור בעדינות כלפי השוק","להחזיק עד תחושת מתיחה בכף הרגל"],"key_cues":["אפשר גם להיעזר בכדור קטן ולגלגל תחת כף הרגל"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":25,"rest_sec":15}}},
    {"id":"08615396-5a27-5662-aeba-e9ee953afbe4","patch":{"instruction_steps":["לעמוד זקוף על שתי הרגליים","לקפוץ קפיצות קטנות ומהירות מעל הקרסוליים, ריקושט מהיר מהרצפה","לשמור על ברכיים כמעט ישרות"],"key_cues":["מגע קצר עם הרצפה בכל קפיצה"],"safety_notes":"יש לבצע על משטח יציב ובנעליים מתאימות. להפסיק אם יש כאב או חוסר ביטחון בנחיתה.","contraindications":"לא לפני החלמה מלאה מדלקת גיד אכילס חריפה","default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"e09d5ed8-0f56-58c0-9f14-8684dfd1f86f","patch":{"instruction_steps":["לשכב על הבטן, ידיים מתחת לכתפיים כמו בשכיבת סמיכה","לדחוף את פלג הגוף העליון כלפי מעלה תוך השארת האגן על הרצפה, ליצירת קשת בגב","לרדת לאט חזרה למטה"],"key_cues":["האגן ורגליים נשארים רפויים על הרצפה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":2,"reps":10,"rest_sec":20}}},
    {"id":"befdabab-0e7e-53bf-9a4b-910e57ba5491","patch":{"instruction_steps":["לשכב על הגב עם ברך אחת כפופה כלפי החזה","ליישר את הברך תוך כיפוף כף הרגל כלפי הגוף בעדינות","לחזור למצב הכפוף"],"key_cues":["תנועה עדינה, לא למתוח עד כאב או נימול"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":2,"reps":10,"rest_sec":20}}},
    {"id":"ddaca530-c2a8-51a1-a7c3-ed637c04e7c1","patch":{"instruction_steps":["לעמוד עם גומייה מקובעת מאחורי הקרסול","להרים את הברך קדימה וכלפי מעלה כנגד ההתנגדות","להוריד לאט"],"key_cues":["הגו נשאר זקוף, ללא הטיה אחורה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"43ce86f8-2c9d-5ec1-a77a-3932a9c95109","patch":{"instruction_steps":["לקשור גומייה מאחורי הברך, מקובעת מלפנים בגובה נמוך","לעמוד עם ברך מעט כפופה ולדחוף אותה ליישור מלא כנגד ההתנגדות","לחזור לאט לכיפוף קל"],"key_cues":["רק טווח היישור האחרון, לא כפיפה עמוקה"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":45}}},
    {"id":"7aaacbcd-3d78-5aed-971d-21cce45473c2","patch":{"instruction_steps":["להחזיק כדור פלסטלינה טיפולית בכף היד","ללחוץ, לגלגל או למתוח אותה באצבעות לפי ההנחיה","לשחרר לאט"],"key_cues":["לבחור התנגדות שנוחה לביצוע ללא כאב"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":3,"reps":15,"rest_sec":30}}},
    {"id":"4417da53-4f5f-535b-b14b-404d5b1b6831","patch":{"instruction_steps":["לשבת על כיסא עם גליל קצף אופקי בגובה בית החזה העליון","לתמוך בראש בידיים ולהיטות אחורה מעל הגליל, ליצירת יישור בגב העליון","לחזור קדימה לאט"],"key_cues":["תנועה מבית החזה, לא מהצוואר"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"reps","sets":2,"reps":10,"rest_sec":30}}},
    {"id":"7974743a-c7e1-5e89-9f5b-9fd841fe4204","patch":{"instruction_steps":["ליישר את הזרוע קדימה עם כף היד כלפי מטה ואצבעות כפופות","למשוך בעדינות את גב כף היד כלפי הגוף עם היד השנייה","להחזיק עד תחושת מתיחה באמה"],"key_cues":["מתיחה עדינה, ללא כאב"],"safety_notes":"כאב עד 3/10 בזמן התרגיל מקובל אם הוא חולף תוך 24 שעות. יש להפסיק בכאב חד, נימול או הקרנה.","contraindications":null,"default_prescription":{"mode":"hold","sets":3,"hold_sec":25,"rest_sec":15}}}
  ]$j$;

  -- 2. Renamed or merged rows: [pre-cleanup name, name in the repo, English]
  -- (RENAME in scripts/_apply-catalog-cleanup.cjs).
  v_merges JSONB := $j$[
    ["גשר עכוז","גשר","Glute Bridge -> Bridge"],
    ["Clamshells","צדפה (Clamshell)","Clamshells -> Clamshell"],
    ["חיזוק מפשקי ירך (Clamshell)","צדפה (Clamshell)","Hip Abductor Strengthening -> Clamshell"],
    ["הרמת רגל בשכיבה צידית","הרחקת ירך בשכיבה על הצד","Side-Lying Leg Raise -> Side-Lying Hip Abduction"],
    ["חיזוק מפשקי ירך","הרחקת ירך בשכיבה על הצד","Hip Abductor Strengthening -> Side-Lying Hip Abduction"],
    ["ישיבת קיר איזומטרית","ישיבה על הקיר","Isometric Wall Sit -> Wall Sit"],
    ["הרמות עקב","הרמת עקב בעמידה","Calf Raises -> Standing Calf Raise"],
    ["הורדת עקב אקסצנטרית","הורדת עקב אקסצנטרית (אלפרדסון)","Eccentric Heel Drop -> Eccentric Heel Drop (Alfredson)"],
    ["הרמת עקב אקסצנטרית","הורדת עקב אקסצנטרית (אלפרדסון)","Eccentric Calf Raise -> Eccentric Heel Drop (Alfredson)"],
    ["כיווץ איזומטרי לשוק","החזקה איזומטרית בהרמת עקב","Isometric Calf Contraction -> Isometric Calf Hold"],
    ["החזקות איזומטריות לשוק","החזקה איזומטרית בהרמת עקב","Isometric Calf Holds -> Isometric Calf Hold"],
    ["סחיטת שכמות","קירוב שכמות","Scapular Squeeze -> Scapular Retraction"],
    ["רוטציה חיצונית עם תרהבנד","רוטציה חיצונית עם גומייה","Theraband External Rotation -> Band External Rotation"],
    ["חיזוק רוטציה חיצונית","רוטציה חיצונית עם גומייה","External Rotation Strengthening -> Band External Rotation"],
    ["רוטציה עם תרהבנד","רוטציה חיצונית עם גומייה","Theraband Rotation -> Band External Rotation"],
    ["מתיחת שוק עדינה","מתיחת שוק","Calf Stretch (Gentle) -> Calf Stretch"],
    ["מתיחת כופף ירך עדינה","מתיחת כופפי ירך","Gentle Hip Flexor Stretch -> Hip Flexor Stretch"],
    ["גלגול IT Band","גלגול ITB על גליל","Foam Rolling IT Band -> Foam Rolling: ITB"],
    ["גלגול ITB","גלגול ITB על גליל","Foam Rolling ITB -> Foam Rolling: ITB"],
    ["אימון שיווי משקל","שיווי משקל חד-רגלי","Balance Training -> Single-Leg Balance"],
    ["לחיצה מעל הראש בהדרגה","לחיצה מעל הראש","Overhead Press Progression -> Overhead Press"],
    ["התקדמות מעל הראש","לחיצה מעל הראש","Overhead Progression -> Overhead Press"],
    ["משיכת סנטר","משיכת סנטר (רטרקציה צווארית)","Chin Tucks -> Chin Tuck"],
    ["חזרה הדרגתית לריצה","תוכנית חזרה לריצה","Gradual Return to Running -> Return to Run Program"],
    ["התקדמות הדרגתית בריצה","תוכנית חזרה לריצה","Gradual Running Progression -> Return to Run Program"],
    ["התקדמות בריצה קלה","תוכנית חזרה לריצה","Jogging Progression -> Return to Run Program"],
    ["חזרה לריצה/זריזות","תוכנית חזרה לריצה","Return to Running/Agility -> Return to Run Program"],
    ["מכניקת ריצה","תיקון דפוס ריצה","Running Mechanics -> Running Gait Retraining"],
    ["זריזות לחזרה לספורט","חזרה הדרגתית לספורט","Return to Sport Agility -> Gradual Return to Sport"],
    ["תרגילי חזרה לספורט","חזרה הדרגתית לספורט","Return to Sport Drills -> Gradual Return to Sport"],
    ["תרגילי חיתוך וזריזות","תרגילי שינוי כיוון","Cutting/Agility Drills -> Change of Direction Drills"],
    ["מתיחת אמה","מתיחת כופפים/יישור שורש","Forearm Stretch -> Wrist Flexor/Extensor Stretch"],
    ["יישור בית החזה","יישור עמוד שדרה חזי","Thoracic Extension -> Thoracic Extension"],
    ["מתיחת שרירי כף היד","מתיחת פושטי שורש כף היד","Wrist Extensor Stretch -> Wrist Extensor Stretch"],
    ["כיווץ איזומטרי של יישור שורש כף היד","פשיטת שורש כף היד איזומטרית","Isometric Wrist Extension -> Isometric Wrist Extension"],
    ["יישור שורש כף היד אקסצנטרי (Tyler Twist)","פשיטת שורש כף היד אקסצנטרית","Eccentric Wrist Extension -> Eccentric Wrist Extension"],
    ["יישור שורש כף היד עם תרהבנד","פשיטת שורש כף היד עם גומייה","Theraband Wrist Extension -> Band Wrist Extension"],
    ["שכיבה על הבטן (מקנזי)","יישור גב בשכיבה על הבטן (מקנזי)","Prone Press-Ups (McKenzie) -> Prone Press-Ups (McKenzie)"],
    ["פיזיותרפיה במים","ריצה במים","Pool Therapy/Aqua Jogging -> Aqua Jogging"],
    ["מתיחת פאשיה כפית","מתיחת הפסציה הפלנטרית","Plantar Fascia Stretch -> Plantar Fascia Stretch"],
    ["מתיחת Sleeper","מתיחת Sleeper (רוטציה פנימית בשכיבה על הצד)","Sleeper Stretch -> Sleeper Stretch"],
    ["החלקות עצב","החלקת עצב סיאטי","Nerve Glides -> Sciatic Nerve Glide"],
    ["חיזוק שוקה קדמית","כפיפה דורסלית של הקרסול עם גומייה","Tibialis Anterior Strengthening -> Band Ankle Dorsiflexion"],
    ["חיזוק שרירי כף רגל פנימיים","תרגיל כף רגל קצרה","Intrinsic Foot Strengthening -> Short Foot Exercise"],
    ["חיזוק אחיזה","לחיצת כדור","Grip Strengthening -> Ball Squeeze"],
    ["חיזוק כופף ירך","כפיפת ירך בעמידה עם גומייה","Hip Flexor Strengthening -> Standing Hip Flexion with Band"],
    ["סקוואט פונקציונלי","סקוואט במשקל גוף","Functional Squats -> Bodyweight Squat"],
    ["טווח תנועה למרפק","כפיפה ויישור של המרפק","Elbow ROM -> Elbow Flexion–Extension ROM"],
    ["התקדמות בקפיצות","קפיצות פוגו","Hopping Progression -> Pogo Hops"],
    ["כיפוף מק-גיל","כפיפת בטן מק'גיל","McGill Curl-Up -> McGill Curl-Up"],
    ["הפעלת VMO","יישור ברך סופי עם גומייה (TKE)","VMO Activation -> Terminal Knee Extension (Band)"],
    ["תרגילי מוטוריקה עדינה","תרגילי אצבעות עם פלסטלינה טיפולית","Fine Motor Exercises -> Therapy Putty Finger Exercises"]
  ]$j$;

  -- The JSON-derived Quad Sets / Straight Leg Raise / Heel Slides, folded
  -- into the hand-written rows by seed.sql (M01-M03): [from id, to id].
  v_cross JSONB := $j$[
    ["97ff2d75-4689-5ecf-9e33-77b750cfa9ee", "e0000001-0000-0000-0000-000000000001"],
    ["ae360637-161c-5f8c-8599-59936368de08", "e0000001-0000-0000-0000-000000000003"],
    ["423b7cda-3452-5d58-a4ca-a45c126445ff", "e0000001-0000-0000-0000-000000000002"]
  ]$j$;

  -- 3. Protocol edits (REMOVE / REPLACE_IN_PHASE / ADD_TO_PHASE in the same
  -- script): [slug, phase, exercise, English] / [slug, phase, from, to,
  -- English] / [slug, phase, exercise, prescription, frequency, English].
  v_removes JSONB := $j$[
    ["jumpers_knee",2,"חיזוק ארבע ראשי","Quad Strengthening"],
    ["shin_splints",4,"הערכת נעליים ודפוס הליכה","Footwear/Gait Assessment"],
    ["chronic_neck",1,"רטרקציה צווארית","Cervical Retraction"],
    ["jumpers_knee",4,"התקדמות פליומטרית","Plyometric Progression"],
    ["hamstring_strain",1,"כפיפת ברך נורדית","Nordic Hamstring Curl"],
    ["adductor_strain",1,"פלאנק קופנהגן","Copenhagen Plank"]
  ]$j$;
  v_replaces JSONB := $j$[
    ["adductor_strain",2,"חיזוק ירך","הרחקת ירך בשכיבה על הצד","Hip Strengthening -> Side-Lying Hip Abduction"],
    ["shoulder_impingement",3,"חיזוק מותג הכתף","רוטציה חיצונית עם גומייה","Rotator Cuff Strengthening -> Band External Rotation"],
    ["slap_lesion",1,"ייצוב שכמה","קירוב שכמות","Scapular Stabilization -> Scapular Retraction"],
    ["adductor_strain",3,"יציבות ליבה","חרק מת","Core Stability -> Dead Bug"],
    ["hip_flexor_strain",2,"יציבות ליבה","חרק מת","Core Stability -> Dead Bug"],
    ["osgood_schlatter",3,"חיזוק עדין","ישיבה על הקיר","Gentle Strengthening -> Wall Sit"],
    ["quad_contusion",3,"חיזוק הדרגתי","עליות מדרגה","Progressive Strengthening -> Step-Ups"],
    ["stress_fracture",2,"חיזוק איזומטרי","החזקה איזומטרית בהרמת עקב","Isometric Strengthening -> Isometric Calf Hold"],
    ["mcl_sprain",1,"תרגילי טווח תנועה","החלקות עקב","ROM Exercises -> Heel Slides"],
    ["meniscus_tear",1,"תרגילי טווח תנועה","החלקות עקב","ROM Exercises -> Heel Slides"],
    ["quad_contusion",1,"טווח תנועה עדין לברך","החלקות עקב","Gentle Knee ROM -> Heel Slides"],
    ["stress_fracture",1,"טווח תנועה ללא נשיאת משקל","אלף-בית קרסול","Non-Weight-Bearing ROM -> Ankle Alphabet"],
    ["quad_contusion",2,"מתיחה ללא כאב","מתיחת ארבע ראשי","Pain-Free Stretching -> Quad Stretch"],
    ["chronic_neck",4,"תיקון יציבה","קירוב שכמות","Postural Correction -> Scapular Retraction"],
    ["shoulder_impingement",4,"תיקון יציבה","Y-T-W בשכיבה","Postural Correction -> Prone Y-T-W"],
    ["stress_fracture",3,"אירובי בעצימות נמוכה","אופניים נייחים","Low-Impact Cardio -> Stationary Bike"],
    ["hamstring_strain",4,"עומס אקסצנטרי לירך אחורית","כפיפת ברך נורדית","Eccentric Hamstring Loading -> Nordic Hamstring Curl"]
  ]$j$;
  v_adds JSONB := $j$[
    ["adductor_strain",3,"פלאנק קופנהגן",{"sets":3,"reps":10},"4×/שבוע","Copenhagen Plank"]
  ]$j$;

  -- 4. The generic rows the cleanup replaced rather than renamed: [name, English].
  v_retire JSONB := $j$[
    ["עומס אקסצנטרי לירך אחורית","Eccentric Hamstring Loading"],
    ["חיזוק ארבע ראשי","Quad Strengthening"],
    ["התקדמות פליומטרית","Plyometric Progression"],
    ["רטרקציה צווארית","Cervical Retraction"],
    ["תיקון יציבה","Postural Correction"],
    ["ייצוב שכמה","Scapular Stabilization"],
    ["חיזוק עדין","Gentle Strengthening"],
    ["הערכת נעליים ודפוס הליכה","Footwear/Gait Assessment"],
    ["תרגילי טווח תנועה","ROM Exercises"],
    ["חיזוק מותג הכתף","Rotator Cuff Strengthening"],
    ["יציבות ליבה","Core Stability"],
    ["טווח תנועה עדין לברך","Gentle Knee ROM"],
    ["מתיחה ללא כאב","Pain-Free Stretching"],
    ["חיזוק הדרגתי","Progressive Strengthening"],
    ["טווח תנועה ללא נשיאת משקל","Non-Weight-Bearing ROM"],
    ["חיזוק איזומטרי","Isometric Strengthening"],
    ["אירובי בעצימות נמוכה","Low-Impact Cardio"]
  ]$j$;

  -- 5. seed.sql's fixes for rows both catalogs have: [name, region, English]
  -- (only where NULL), [name, import's category, category, English],
  -- [name, item_kind, English].
  v_regions JSONB := $j$[
    ["גשר","hip_thigh","Bridge"],
    ["שיווי משקל חד-רגלי","ankle_foot","Single-Leg Balance"],
    ["מתיחת ירך אחורית","hip_thigh","Hamstring Stretch"],
    ["הרמת עקב בישיבה","lower_leg","Seated Calf Raise"],
    ["הרמת עקב חד-רגלית","lower_leg","Single-Leg Calf Raise"],
    ["אופניים נייחים","knee","Stationary Bike"],
    ["חיזוק ירך","knee","Hip Strengthening"]
  ]$j$;
  v_categories JSONB := $j$[
    ["תיקון דפוס ריצה","Cardio","Control","Running Gait Retraining"],
    ["תוכנית חזרה לריצה","Control","Cardio","Return to Run Program"],
    ["גלגול בקבוק קפוא","Strength","Mobility","Frozen Bottle Roll"],
    ["הטיית אגן","Strength","Control","Pelvic Tilts"],
    ["הפעלת כופפים עמוקים","Strength","Control","Deep Neck Flexor Activation"],
    ["קפיצות צדיות","Strength","Control","Lateral Hops"]
  ]$j$;
  v_kinds JSONB := $j$[
    ["הדרכת סד לילה","education","Night Splint Education"],
    ["הדרכת רצועת פטלה","education","Patellar Tendon Strap Education"],
    ["הדרכת סד ניטרלי","education","Wrist Neutral Splint Education"],
    ["קרח והתאמת פעילות","education","Ice/Activity Modification"],
    ["תרגילי יציבה ארגונומית","education","Ergonomic Posture Drills"],
    ["תוכנית חזרה לריצה","program","Return to Run Program"],
    ["חזרה הדרגתית לספורט","program","Gradual Return to Sport"],
    ["תוכנית הליכה","program","Walking Program"],
    ["התקדמות בספרינט","program","Sprint Progression"],
    ["התקדמות עומס עצם","program","Bone-Loading Progression"],
    ["העמסת משקל הדרגתית","program","Gradual Weight-Bearing Progression"],
    ["התקדמות בזריקה מעל הראש","program","Overhead Throwing Progression"],
    ["תרגילי חזרה למחבט","program","Return to Racquet Drills"],
    ["חזרה הדרגתית להרמה","program","Gradual Return to Lifting"],
    ["תיקון דפוס הליכה","program","Gait Retraining"]
  ]$j$;
  -- The cues 0044 gives any cue-less 'exercise' row; wrong on an
  -- education or program item.
  v_generic_cues TEXT[] := ARRAY[
    'מתחו לאט עד לתחושת מתיחה קלה, ללא קפיצות ולא עד כאב',
    'שמרו על יציבות המנח לאורך כל זמן ההחזקה ונשמו באופן סדיר',
    'שמרו על קצב אחיד ונשימה סדירה לאורך כל התרגיל',
    'בצעו בטווח תנועה נוח ובשליטה, ללא כאב',
    'בצעו בטווח תנועה מלא ובקצב מבוקר, ללא נדנוד בגוף'
  ];

  v_curator UUID;
  v_row JSONB;
  v_id UUID;
  v_to UUID;
  v_ex app.exercise;
  v_patch JSONB;
  v_res JSONB;
  v_n INT;
  v_phase_id UUID;
  v_protocol_id UUID;
  v_ids UUID[];
  v_touched UUID[] := '{}';
  v_skipped TEXT[] := '{}';
  v_created INT := 0;
  v_filled INT := 0;
  v_merged INT := 0;
  v_edits INT := 0;
  v_retired INT := 0;
  v_fixed INT := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.exercise
    WHERE clinic_id IS NULL AND deleted_at IS NULL
      AND id IN (SELECT pg_temp.rc_exercise_id(m ->> 0) FROM jsonb_array_elements(v_merges) m
                 UNION ALL
                 SELECT (c ->> 0)::uuid FROM jsonb_array_elements(v_cross) c)
  ) THEN
    RAISE NOTICE 'catalog reconcile: no pre-cleanup rows, nothing to do';
    RETURN;
  END IF;

  v_curator := COALESCE(
    (SELECT id FROM app."user" WHERE id = '22222222-2222-2222-2222-222222222222'),
    (SELECT user_id FROM app.catalog_curator ORDER BY granted_at LIMIT 1)
  );
  IF v_curator IS NULL THEN
    RAISE EXCEPTION 'catalog reconcile: no catalog curator to make the changes as';
  END IF;

  -- 1. Missing rows, then their content.
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    v_id := (v_row ->> 'id')::uuid;
    INSERT INTO app.exercise (id, clinic_id, name, name_en, category, body_region_id, instructions,
                              source, status, reviewed_at, is_active)
    VALUES (v_id, NULL, v_row ->> 'name', v_row ->> 'name_en', v_row ->> 'category',
            (SELECT id FROM app.body_region WHERE slug = v_row ->> 'region'), v_row ->> 'instructions',
            'system', 'approved', now(), true)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_created := v_created + 1;
      INSERT INTO app.exercise_secondary_region (exercise_id, body_region_id)
      SELECT v_id, br.id
      FROM jsonb_array_elements_text(v_row -> 'secondary') s
      JOIN app.body_region br ON br.slug = s
      ON CONFLICT DO NOTHING;
    ELSIF NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_id AND clinic_id IS NULL AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'catalog reconcile: % (%) exists but is deleted or not a system row', v_row ->> 'name_en', v_id;
    END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_content) LOOP
    v_id := (v_row ->> 'id')::uuid;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM app.exercise WHERE id = v_id AND COALESCE(cardinality(instruction_steps), 0) = 0
    );
    v_res := app.catalog_save_exercise(v_curator, v_id, v_row -> 'patch');
    IF v_res ? 'error' THEN
      RAISE EXCEPTION 'catalog reconcile: content for % failed: %', v_id, v_res;
    END IF;
    v_filled := v_filled + 1;
  END LOOP;

  -- 0039's dataset animation for Side-Lying Hip Abduction, one of the new
  -- rows. Unverified, so curators see it and patients don't.
  INSERT INTO app.exercise_media (exercise_id, clinic_id, kind, url, thumb_url, width, height, "order", rights, attribution, review_note)
  SELECT v.exercise_id, NULL, v.kind, v.url, v.thumb_url, 180, 180, v.ord, 'unknown',
    '© Gym visual — https://gymvisual.com/',
    'Matched from the exercises dataset during catalog cleanup step 4 (2026-09-13) — pending license verification before patient use.'
  FROM (VALUES
    ('17622353-f0f1-5592-a250-169312932696'::uuid, 'gif',   'dataset/0710-7WaDzyL.gif', 'dataset/0710-7WaDzyL.jpg', 0),
    ('17622353-f0f1-5592-a250-169312932696'::uuid, 'image', 'dataset/0710-7WaDzyL.jpg', NULL, 1)
  ) AS v(exercise_id, kind, url, thumb_url, ord)
  WHERE NOT EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = v.exercise_id AND m.url = v.url);

  -- 2. Merges.
  FOR v_row IN
    SELECT jsonb_build_array(pg_temp.rc_exercise_id(m ->> 0), pg_temp.rc_exercise_id(m ->> 1), m ->> 0)
    FROM jsonb_array_elements(v_merges) m
    UNION ALL
    SELECT c || jsonb_build_array(c ->> 0) FROM jsonb_array_elements(v_cross) c
  LOOP
    v_id := (v_row ->> 0)::uuid;
    v_to := (v_row ->> 1)::uuid;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_id AND clinic_id IS NULL AND deleted_at IS NULL);
    v_res := app.catalog_merge_exercise(v_curator, v_id, v_to);
    IF NOT COALESCE((v_res ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION 'catalog reconcile: merging % failed: %', v_row ->> 2, v_res;
    END IF;
    v_merged := v_merged + 1;
  END LOOP;

  -- 3. Protocol edits, system protocols only. Targets resolve through the
  -- cross-source merges (Heel Slides -> the hand-written row).
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_removes) LOOP
    WITH del AS (
      DELETE FROM app.protocol_phase_exercise ppe
      USING app.protocol_phase ph, app.protocol p
      WHERE ppe.protocol_phase_id = ph.id AND ph.protocol_id = p.id
        AND p.clinic_id IS NULL AND p.slug = v_row ->> 0 AND ph.n = (v_row ->> 1)::int
        AND ppe.exercise_id = pg_temp.rc_exercise_id(v_row ->> 2)
      RETURNING p.id
    )
    SELECT array_agg(DISTINCT id) INTO v_ids FROM del;
    IF v_ids IS NULL THEN
      v_skipped := v_skipped || format('remove %s from %s/%s: not there', v_row ->> 2, v_row ->> 0, v_row ->> 1);
    ELSE
      v_touched := v_touched || v_ids;
      v_edits := v_edits + 1;
    END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_replaces) LOOP
    v_id := pg_temp.rc_exercise_id(v_row ->> 2);
    v_to := pg_temp.rc_exercise_id(v_row ->> 3);
    v_to := COALESCE((SELECT (c ->> 1)::uuid FROM jsonb_array_elements(v_cross) c WHERE (c ->> 0)::uuid = v_to), v_to);
    IF NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_to AND clinic_id IS NULL AND deleted_at IS NULL AND status = 'approved') THEN
      v_skipped := v_skipped || format('replace %s with %s in %s/%s: target not an approved system exercise',
                                       v_row ->> 2, v_row ->> 3, v_row ->> 0, v_row ->> 1);
      CONTINUE;
    END IF;
    WITH upd AS (
      UPDATE app.protocol_phase_exercise ppe SET exercise_id = v_to
      FROM app.protocol_phase ph JOIN app.protocol p ON p.id = ph.protocol_id
      WHERE ppe.protocol_phase_id = ph.id
        AND p.clinic_id IS NULL AND p.slug = v_row ->> 0 AND ph.n = (v_row ->> 1)::int
        AND ppe.exercise_id = v_id
        AND NOT EXISTS (SELECT 1 FROM app.protocol_phase_exercise x WHERE x.protocol_phase_id = ph.id AND x.exercise_id = v_to)
      RETURNING p.id
    )
    SELECT array_agg(DISTINCT id) INTO v_ids FROM upd;
    IF v_ids IS NULL THEN
      v_skipped := v_skipped || format('replace %s with %s in %s/%s: not there', v_row ->> 2, v_row ->> 3, v_row ->> 0, v_row ->> 1);
    ELSE
      v_touched := v_touched || v_ids;
      v_edits := v_edits + 1;
    END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_adds) LOOP
    v_to := pg_temp.rc_exercise_id(v_row ->> 2);
    SELECT ph.id, p.id INTO v_phase_id, v_protocol_id
    FROM app.protocol_phase ph JOIN app.protocol p ON p.id = ph.protocol_id
    WHERE p.clinic_id IS NULL AND p.slug = v_row ->> 0 AND ph.n = (v_row ->> 1)::int;
    IF v_phase_id IS NULL
       OR EXISTS (SELECT 1 FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_phase_id AND exercise_id = v_to)
       OR NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_to AND clinic_id IS NULL AND deleted_at IS NULL AND status = 'approved') THEN
      v_skipped := v_skipped || format('add %s to %s/%s: phase missing, already there, or not approved', v_row ->> 2, v_row ->> 0, v_row ->> 1);
      CONTINUE;
    END IF;
    INSERT INTO app.protocol_phase_exercise (protocol_phase_id, exercise_id, prescription, frequency, "order")
    VALUES (v_phase_id, v_to, v_row -> 3, v_row ->> 4,
            COALESCE((SELECT max("order") FROM app.protocol_phase_exercise WHERE protocol_phase_id = v_phase_id), 0) + 1);
    v_touched := v_touched || v_protocol_id;
    v_edits := v_edits + 1;
  END LOOP;

  FOR v_protocol_id IN SELECT DISTINCT x FROM unnest(v_touched) x LOOP
    PERFORM app.protocol_snapshot(v_protocol_id);
  END LOOP;

  -- 4. Retire the replaced generic rows.
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_retire) LOOP
    v_id := pg_temp.rc_exercise_id(v_row ->> 0);
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM app.exercise WHERE id = v_id AND clinic_id IS NULL AND deleted_at IS NULL AND status <> 'archived'
    );
    IF EXISTS (
      SELECT 1 FROM app.protocol_phase_exercise ppe
      JOIN app.protocol_phase ph ON ph.id = ppe.protocol_phase_id
      JOIN app.protocol p ON p.id = ph.protocol_id
      WHERE ppe.exercise_id = v_id AND p.clinic_id IS NULL AND p.is_active
    ) THEN
      v_skipped := v_skipped || format('archive %s: a system protocol still uses it', v_row ->> 1);
      CONTINUE;
    END IF;
    v_res := app.catalog_set_status(v_curator, ARRAY[v_id], 'archived');
    IF v_res ? 'error' OR jsonb_array_length(v_res -> 'skipped') > 0 THEN
      RAISE EXCEPTION 'catalog reconcile: archiving % failed: %', v_row ->> 1, v_res;
    END IF;
    v_retired := v_retired + 1;
  END LOOP;

  -- 5. seed.sql's fixes.
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_regions) LOOP
    v_id := pg_temp.rc_exercise_id(v_row ->> 0);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_id AND deleted_at IS NULL AND body_region_id IS NULL);
    v_res := app.catalog_save_exercise(v_curator, v_id,
      jsonb_build_object('body_region_id', (SELECT id FROM app.body_region WHERE slug = v_row ->> 1)));
    IF v_res ? 'error' THEN
      RAISE EXCEPTION 'catalog reconcile: region for % failed: %', v_row ->> 0, v_res;
    END IF;
    v_fixed := v_fixed + 1;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_categories) LOOP
    v_id := pg_temp.rc_exercise_id(v_row ->> 0);
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_id AND deleted_at IS NULL AND category = v_row ->> 1);
    v_res := app.catalog_save_exercise(v_curator, v_id, jsonb_build_object('category', v_row ->> 2));
    IF v_res ? 'error' THEN
      RAISE EXCEPTION 'catalog reconcile: category for % failed: %', v_row ->> 0, v_res;
    END IF;
    v_fixed := v_fixed + 1;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_kinds) LOOP
    SELECT * INTO v_ex FROM app.exercise
    WHERE id = pg_temp.rc_exercise_id(v_row ->> 0) AND deleted_at IS NULL AND item_kind = 'exercise';
    CONTINUE WHEN NOT FOUND;
    v_patch := jsonb_build_object('item_kind', v_row ->> 1);
    IF cardinality(v_ex.key_cues) = 1 AND v_ex.key_cues[1] = ANY (v_generic_cues) THEN
      v_patch := v_patch || jsonb_build_object('key_cues', '[]'::jsonb);
    END IF;
    v_res := app.catalog_save_exercise(v_curator, v_ex.id, v_patch);
    IF v_res ? 'error' THEN
      RAISE EXCEPTION 'catalog reconcile: item kind for % failed: %', v_row ->> 0, v_res;
    END IF;
    v_fixed := v_fixed + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM app.exercise
    WHERE clinic_id IS NULL AND deleted_at IS NULL
      AND id IN (SELECT pg_temp.rc_exercise_id(m ->> 0) FROM jsonb_array_elements(v_merges) m
                 UNION ALL
                 SELECT (c ->> 0)::uuid FROM jsonb_array_elements(v_cross) c)
  ) THEN
    RAISE EXCEPTION 'catalog reconcile: pre-cleanup rows still live after the merges';
  END IF;

  RAISE NOTICE 'catalog reconcile: created %, content %, merged %, protocol edits %, archived %, fixes %',
    v_created, v_filled, v_merged, v_edits, v_retired, v_fixed;
  IF cardinality(v_skipped) > 0 THEN
    RAISE NOTICE 'catalog reconcile: skipped %', array_to_string(v_skipped, '; ');
  END IF;
END
$reconcile$;
