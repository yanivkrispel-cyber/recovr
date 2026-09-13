// One-off generator (catalog cleanup step 3, 2026-09-13): embeds the
// curator-approved content batch from _p0-content-patches-2026-09-13.json
// (drafted from https://claude.ai/code/artifact/2100e702-1a30-4f2b-a32c-58f5c1e6567a,
// all 107 items approved) into a migration that applies it via
// app.catalog_save_exercise — the same function the editor UI uses, so this
// bumps revision and writes an exercise_revision row exactly like a curator
// editing by hand. See [[project-catalog-cleanup]].
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '_p0-content-patches-2026-09-13.json');
const outPath = path.join(__dirname, '..', 'supabase', 'migrations', '0037_catalog_p0_content_2026_09_13.sql');
const json = fs.readFileSync(jsonPath, 'utf8');
const patches = JSON.parse(json);

const sql = `-- Catalog cleanup step 3 (2026-09-13) — P0 content for the 107 core
-- exercises: instruction_steps, key_cues, safety_notes/contraindications and
-- a typed default_prescription. Drafted and curator-approved at
-- https://claude.ai/code/artifact/2100e702-1a30-4f2b-a32c-58f5c1e6567a
-- (all 107 items approved) — see [[project-catalog-cleanup]].
--
-- Applied through app.catalog_save_exercise (0032/0036), the same function
-- the library workspace editor uses: it bumps revision and writes an
-- app.exercise_revision row per exercise, exactly like a curator editing by
-- hand. These 107 rows are already 'approved' and stay that way — this only
-- fills in content, it does not touch status.
--
-- Runs here (idempotent: catalog_save_exercise is a no-op when the patch
-- already matches) and again at the end of seed.sql, because on \`db reset\`
-- these exercise rows don't exist yet at migration time — they're created by
-- protocols_import.sql / seed.sql, which run after every migration.
CREATE OR REPLACE FUNCTION app._catalog_apply_p0_content_2026_09_13()
RETURNS JSONB AS $$
DECLARE
  v_curator UUID := '22222222-2222-2222-2222-222222222222'; -- demo curator (seed.sql); harmless no-op on databases without this user
  v_data JSONB := $p0_content$${json}$p0_content$::jsonb;
  v_row JSONB;
  v_id UUID;
  v_res JSONB;
  v_applied INT := 0;
  v_skipped JSONB := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app."user" WHERE id = v_curator) THEN
    RETURN jsonb_build_object('applied', 0, 'skipped', '[]'::jsonb, 'note', 'no curator user on this database');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_data) LOOP
    v_id := (v_row ->> 'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM app.exercise WHERE id = v_id AND deleted_at IS NULL) THEN
      CONTINUE; -- not seeded yet on this pass (migration-time call, before protocols_import.sql)
    END IF;
    v_res := app.catalog_save_exercise(v_curator, v_id, v_row -> 'patch', NULL);
    IF v_res ? 'error' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', COALESCE(v_res ->> 'message', v_res ->> 'error'));
    ELSE
      v_applied := v_applied + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql;

SELECT app._catalog_apply_p0_content_2026_09_13();
`;

fs.writeFileSync(outPath, sql);
console.log('wrote', outPath, Buffer.byteLength(sql), 'bytes,', patches.length, 'patches');
