// One-off generator (catalog cleanup step 5, 2026-09-13): embeds
// scripts/_dataset-enrichment-patches.json into a migration that applies it
// via app.catalog_save_exercise — same mechanism as step 3 (0037). Curator
// identity (demo curator), region resolved from region_slug per-database
// since app.body_region ids are gen_random_uuid(), not fixed. See
// [[project-catalog-cleanup]].
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '_dataset-enrichment-patches.json');
const outPath = path.join(__dirname, '..', 'supabase', 'migrations', '0040_dataset_enrichment_2026_09_13.sql');
const json = fs.readFileSync(jsonPath, 'utf8');
const patches = JSON.parse(json);

const sql = `-- Catalog cleanup step 5 (2026-09-13) — enrich the rehab-relevant slice of
-- the dataset exercises (bodyweight/band/ball/roller equipment, minus
-- advanced calisthenics/plyometric/hanging-bar moves that don't belong in a
-- rehab catalog: muscle-ups, planches, handstands, box jumps, kipping,
-- boxing punches, ...) with a Hebrew name, a Hebrew instruction, a body
-- region and a rule-based dosage/safety. See [[project-catalog-cleanup]].
--
-- Applied without an interactive review pass (explicit "go without review"
-- instruction) but through the normal write path —
-- app.catalog_save_exercise, curator identity, revision history — and these
-- rows stay in whatever status they already have (draft). Nothing here
-- approves anything: the step-2 approval gate still guards the transition
-- to 'approved', so a bad translation blocks itself out of the picker
-- rather than reaching a patient.
--
-- Dosage/safety are rule-based (stretch/pose -> held; isometric/plank/wall
-- sit -> held; cardio category -> timed; everything else -> reps), not
-- individually authored — same template-by-exercise-type approach flagged
-- as legitimate in step 1 (unlike templating by protocol PHASE, which
-- wasn't). name_en is title-cased and "(male)"/"(female)"/"v. 2" stripped;
-- the original dataset name is kept as a search alias.
--
-- Runs here (idempotent: catalog_save_exercise no-ops when the patch
-- already matches) and again at the end of seed.sql, because on \`db reset\`
-- these exercise rows don't exist yet at migration time.
CREATE OR REPLACE FUNCTION app._catalog_apply_dataset_enrichment_2026_09_13()
RETURNS JSONB AS $$
DECLARE
  v_curator UUID := '22222222-2222-2222-2222-222222222222'; -- demo curator (seed.sql); harmless no-op on databases without this user
  v_data JSONB := $enrich_json$${json}$enrich_json$::jsonb;
  v_row JSONB;
  v_ext_ref TEXT;
  v_id UUID;
  v_patch JSONB;
  v_region UUID;
  v_res JSONB;
  v_applied INT := 0;
  v_skipped JSONB := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_curator) THEN
    RETURN jsonb_build_object('applied', 0, 'skipped', '[]'::jsonb, 'note', 'no curator user on this database');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_data) LOOP
    v_ext_ref := v_row ->> 'id';
    SELECT id INTO v_id FROM app.exercise WHERE external_ref = v_ext_ref AND clinic_id IS NULL AND deleted_at IS NULL;
    IF v_id IS NULL THEN
      CONTINUE; -- dataset row not ingested yet on this pass (scripts/ingest-exercises.ts is a separate manual step)
    END IF;
    SELECT id INTO v_region FROM app.body_region WHERE slug = (v_row ->> 'region_slug');
    v_patch := (v_row -> 'patch') || jsonb_build_object('body_region_id', v_region);
    v_res := app.catalog_save_exercise(v_curator, v_id, v_patch, NULL);
    IF v_res ? 'error' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'external_ref', v_ext_ref, 'reason', COALESCE(v_res ->> 'message', v_res ->> 'error'));
    ELSE
      v_applied := v_applied + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql;

SELECT app._catalog_apply_dataset_enrichment_2026_09_13();
`;

fs.writeFileSync(outPath, sql);
console.log('wrote', outPath, Buffer.byteLength(sql), 'bytes,', patches.length, 'patches');
