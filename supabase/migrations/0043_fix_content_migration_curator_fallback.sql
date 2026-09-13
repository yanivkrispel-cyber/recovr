-- Migrations 0037, 0040 and 0042 each write catalog content through
-- app.catalog_save_exercise acting as the local demo/seed curator
-- ('22222222-2222-2222-2222-222222222222'). That user correctly does not
-- exist on production (it's a demo login with a known password), so on any
-- database without it those three migrations silently no-op'd: they report
-- success (no SQL error) but wrote nothing -- confirmed on the linked
-- production project, where 1324 dataset exercises + 107 core exercises
-- have zero content from those three migrations despite `db push` having
-- "applied" them.
--
-- Fix: rewrite each function in place so the hardcoded demo-curator literal
-- falls back to any existing app.catalog_curator, then re-invoke all three.
-- Patched via pg_get_functiondef + a targeted text substitution rather than
-- re-typing the ~1300-row embedded JSON payloads verbatim. Idempotent
-- everywhere -- catalog_save_exercise no-ops per-row when the patch already
-- matches, so this is a no-op on databases where the demo curator already
-- made 0037/0040/0042 apply (local/seed).

DO $$
DECLARE
  v_fn TEXT;
  v_src TEXT;
  v_patched TEXT;
  v_from TEXT := $lit$'22222222-2222-2222-2222-222222222222'$lit$;
  v_to TEXT := $lit$COALESCE(
    (SELECT id FROM app."user" WHERE id = '22222222-2222-2222-2222-222222222222'),
    (SELECT user_id FROM app.catalog_curator ORDER BY granted_at LIMIT 1)
  )$lit$;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'app._catalog_apply_p0_content_2026_09_13()',
    'app._catalog_apply_dataset_enrichment_2026_09_13()',
    'app._catalog_apply_dataset_enrichment_batch2_2026_09_13()'
  ]
  LOOP
    SELECT pg_get_functiondef(v_fn::regprocedure) INTO v_src;
    IF v_src NOT LIKE '%' || v_from || '%' THEN
      RAISE EXCEPTION 'expected curator literal not found in %', v_fn;
    END IF;
    v_patched := replace(v_src, v_from, v_to);
    EXECUTE v_patched;
  END LOOP;

  PERFORM app._catalog_apply_p0_content_2026_09_13();
  PERFORM app._catalog_apply_dataset_enrichment_2026_09_13();
  PERFORM app._catalog_apply_dataset_enrichment_batch2_2026_09_13();
END $$;
