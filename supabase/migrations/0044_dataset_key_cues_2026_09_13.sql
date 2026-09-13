-- Catalog cleanup step 7 (2026-09-13) -- key_cues was the one P0 field none
-- of the rule-based dataset-enrichment passes (steps 5/6b) ever wrote, so
-- every one of the ~1330 auto-enriched system-catalog exercises is stuck at
-- the approval gate added in 0036 (approving an 'exercise' item requires at
-- least one key cue). That's what blocked approving the calf-raise
-- exercises -- singly or from the bulk grid, which was silently skipping
-- every selected row with reason=missing_required_fields.
--
-- Fix: derive one generic cue per exercise from its already-computed
-- default_prescription (set by the same rule tables in steps 5/6b) -- same
-- "template by exercise type, not individually authored" approach used for
-- instructions/safety/dosage in those steps. See [[project-catalog-cleanup]].
--
-- Scope: clinic_id IS NULL only (system catalog rows from the dataset
-- import) -- never touches a clinic's own drafted exercises. Applied
-- through the normal write path (app.catalog_save_exercise, curator
-- identity, revision history), same curator fallback as 0043. Nothing here
-- approves anything -- it only unblocks the gate so a curator can review
-- and approve row by row.
--
-- Runs here (idempotent -- catalog_save_exercise no-ops when key_cues
-- already has an entry) and again from scripts/ingest-exercises.ts, same
-- reason as 0040/0042: `db reset` wipes dataset rows back to revision 0.
CREATE OR REPLACE FUNCTION app._catalog_apply_key_cues_2026_09_13()
RETURNS JSONB AS $$
DECLARE
  v_curator UUID := COALESCE(
    (SELECT id FROM app."user" WHERE id = '22222222-2222-2222-2222-222222222222'),
    (SELECT user_id FROM app.catalog_curator ORDER BY granted_at LIMIT 1)
  );
  v_row RECORD;
  v_cue TEXT;
  v_res JSONB;
  v_applied INT := 0;
  v_skipped JSONB := '[]'::jsonb;
BEGIN
  IF v_curator IS NULL THEN
    RETURN jsonb_build_object('applied', 0, 'skipped', '[]'::jsonb, 'note', 'no curator on this database');
  END IF;

  FOR v_row IN
    SELECT id, default_prescription FROM app.exercise
    WHERE item_kind = 'exercise' AND clinic_id IS NULL AND cardinality(key_cues) = 0 AND deleted_at IS NULL
  LOOP
    v_cue := CASE
      WHEN v_row.default_prescription ->> 'mode' = 'hold' AND COALESCE((v_row.default_prescription ->> 'hold_sec')::int, 0) >= 20
        THEN 'מתחו לאט עד לתחושת מתיחה קלה, ללא קפיצות ולא עד כאב'
      WHEN v_row.default_prescription ->> 'mode' = 'hold'
        THEN 'שמרו על יציבות המנח לאורך כל זמן ההחזקה ונשמו באופן סדיר'
      WHEN v_row.default_prescription ->> 'mode' = 'duration'
        THEN 'שמרו על קצב אחיד ונשימה סדירה לאורך כל התרגיל'
      WHEN v_row.default_prescription ->> 'mode' = 'reps' AND COALESCE((v_row.default_prescription ->> 'reps')::int, 99) <= 10
        THEN 'בצעו בטווח תנועה נוח ובשליטה, ללא כאב'
      ELSE 'בצעו בטווח תנועה מלא ובקצב מבוקר, ללא נדנוד בגוף'
    END;

    v_res := app.catalog_save_exercise(v_curator, v_row.id, jsonb_build_object('key_cues', to_jsonb(ARRAY[v_cue])), NULL);
    IF v_res ? 'error' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_row.id, 'reason', COALESCE(v_res ->> 'message', v_res ->> 'error'));
    ELSE
      v_applied := v_applied + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$ LANGUAGE plpgsql;

SELECT app._catalog_apply_key_cues_2026_09_13();
