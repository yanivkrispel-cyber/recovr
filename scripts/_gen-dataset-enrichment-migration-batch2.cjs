// Step 6b generator (2026-09-13): embeds
// scripts/_dataset-enrichment-patches-batch2.json into a migration that
// applies it via app.catalog_save_exercise, mirroring
// scripts/_gen-dataset-enrichment-migration.cjs (step 5 / migration 0040)
// exactly. See [[project-catalog-cleanup]].
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '_dataset-enrichment-patches-batch2.json');
const outPath = path.join(__dirname, '..', 'supabase', 'migrations', '0042_dataset_enrichment_batch2_2026_09_13.sql');
const json = fs.readFileSync(jsonPath, 'utf8');
const patches = JSON.parse(json);

const sql = `-- Catalog cleanup step 6b (2026-09-13) -- enrich the remaining 1038
-- dataset exercises step 5 left untouched (mostly gym-machine/free-weight
-- equipment: barbell, cable, leverage machine, dumbbell, kettlebell, smith
-- machine, plus the advanced-calisthenics/plyometric moves step 5
-- deliberately excluded as not rehab-relevant -- muscle-ups, planches,
-- levers, handstands, box jumps, etc.). Unlike step 5's hand-authored
-- Hebrew, this batch is template-generated: a movement keyword matched
-- against the English name (curl/press/row/raise/extension/squat/...),
-- disambiguated by target muscle where the same word means different
-- things (e.g. "curl" = elbow flexion for biceps, knee flexion for
-- hamstrings), composed with the equipment name. ~141 names that don't
-- match any movement keyword (planche/lever/muscle-up/chin-up
-- variants/kettlebell windmills/cable rotation drills/...) were translated
-- individually. See scripts/_gen-dataset-enrichment-hebrew-batch2.cjs for
-- the full template/exception tables -- this is mechanical, not
-- individually clinically authored, so translation quality should be
-- spot-checked by a curator before any of these rows are promoted past
-- draft. Region mapping, dosage rules and safety text reuse step 5's rule
-- tables verbatim (scripts/_gen-dataset-enrichment-batch2.cjs).
--
-- Applied without an interactive review pass, same as step 5, through the
-- normal write path -- app.catalog_save_exercise, curator identity,
-- revision history -- rows stay in whatever status they already have
-- (draft). Nothing here approves anything: the step-2 approval gate still
-- guards the transition to 'approved'.
--
-- Runs here (idempotent) and again from scripts/ingest-exercises.ts,
-- because on \`db reset\` these exercise rows don't exist yet at migration
-- time -- same reason as 0040.
CREATE OR REPLACE FUNCTION app._catalog_apply_dataset_enrichment_batch2_2026_09_13()
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

SELECT app._catalog_apply_dataset_enrichment_batch2_2026_09_13();
`;

fs.writeFileSync(outPath, sql);
console.log('wrote', outPath, Buffer.byteLength(sql), 'bytes,', patches.length, 'patches');
