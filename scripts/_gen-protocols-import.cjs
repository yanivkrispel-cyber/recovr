// One-off generator: reads supabase/seed/protocols-data.json and writes
// supabase/seed/protocols_import.sql, embedding the JSON as a dollar-quoted
// literal inside the import DO block. Not part of the runtime seed path —
// run again only if protocols-data.json changes.
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '..', 'supabase', 'seed', 'protocols-data.json');
const outPath = path.join(__dirname, '..', 'supabase', 'seed', 'protocols_import.sql');
const json = fs.readFileSync(jsonPath, 'utf8');

const sql = `-- ============================================================================
-- System protocol library — imported from design_handoff_recoveryos/protocols-data.js
-- (see scripts/_gen-protocols-import.cjs; supabase/seed/protocols-data.json is the
-- extracted JSON this file embeds). Loaded via [db.seed] sql_paths in config.toml,
-- separately from seed.sql, since this is global system data (clinic_id = NULL),
-- not demo-clinic data.
--
-- Idempotent: every row uses a UUID deterministically derived from its natural
-- key (uuid_generate_v5), so ON CONFLICT (id) DO NOTHING makes re-running safe.
--
-- Two things aren't in the source data and are derived here:
--   - exercise.category: source data doesn't classify exercises, so it's guessed
--     from the English name via keyword heuristics (see the CASE below). This is
--     a starting point, not a clinical judgment — worth a review pass later.
--   - protocol_phase_criterion operator/value/unit: parsed out of labelEn text
--     (e.g. "Pain ≤ 4/10" -> lte/4/"0-10", "Minimum 14 days" -> gte/14/"days").
--     Non-numeric criteria (e.g. "ROM within normal limits", "Clinician
--     approval") become a manual eq/1 flag — is_met is then set by the
--     clinician, not computed.
-- ============================================================================

DO $$
DECLARE
  v_data JSONB := $protocols_json$${json}$protocols_json$::jsonb;
  -- region (Hebrew) -> app.body_region.slug, collapsing the source data's 19
  -- distinct region/regionEn pairs onto the 9 canonical clinical regions
  -- (T-28). The original region/regionEn text is kept verbatim in
  -- region_detail/region_detail_en — it's not lost, just no longer the only
  -- region signal used for filtering/grouping.
  v_region_map JSONB := '{
    "מרפק": "elbow",
    "ברך": "knee",
    "ירך אחורית": "hip_thigh",
    "עמוד שדרה מותני": "spine",
    "כתף": "shoulder",
    "קרסול": "ankle_foot",
    "ברך/ירך לטרלי": "knee",
    "עמוד שדרה צווארי": "spine",
    "שורש כף היד": "wrist_hand",
    "שוק": "lower_leg",
    "קרסול/עקב": "ankle_foot",
    "כף רגל/עקב": "ankle_foot",
    "ברך (פקעת השוקה)": "knee",
    "שוק תחתונה": "lower_leg",
    "ברך (מדיאלי)": "knee",
    "ירך": "hip_thigh",
    "ירך קדמית": "hip_thigh",
    "מפשעה/ירך": "hip_thigh",
    "שוק תחתונה/כף רגל": "lower_leg"
  }'::jsonb;
  v_protocol_slug TEXT;
  v_protocol JSONB;
  v_protocol_id UUID;
  v_body_region_slug TEXT;
  v_phase JSONB;
  v_phase_id UUID;
  v_exercise JSONB;
  v_exercise_id UUID;
  v_exercise_name_en TEXT;
  v_category TEXT;
  v_ex_order INT;
  v_sets INT;
  v_reps INT;
  v_criterion JSONB;
  v_crit_order INT;
  v_db_type TEXT;
  v_label_en TEXT;
  v_op TEXT;
  v_val NUMERIC;
  v_unit TEXT;
BEGIN
  FOR v_protocol_slug, v_protocol IN SELECT * FROM jsonb_each(v_data) LOOP
    v_protocol_id := uuid_generate_v5(uuid_ns_url(), 'recoveryos:protocol:' || v_protocol_slug);
    v_body_region_slug := v_region_map->>(v_protocol->>'region');

    INSERT INTO app.protocol (id, clinic_id, slug, name, name_en, body_region_id, region_detail, region_detail_en, source, version, is_active)
    VALUES (
      v_protocol_id, NULL, v_protocol->>'slug',
      v_protocol->>'name', v_protocol->>'nameEn',
      (SELECT id FROM app.body_region WHERE slug = v_body_region_slug),
      v_protocol->>'region', v_protocol->>'regionEn',
      'system', '1.0', true
    )
    ON CONFLICT (id) DO NOTHING;

    FOR v_phase IN SELECT * FROM jsonb_array_elements(v_protocol->'phases') LOOP
      v_phase_id := uuid_generate_v5(uuid_ns_url(), 'recoveryos:protocol_phase:' || v_protocol_slug || ':' || (v_phase->>'n'));

      INSERT INTO app.protocol_phase (id, protocol_id, n, name, name_en, duration_days, goals, "order")
      VALUES (
        v_phase_id, v_protocol_id, (v_phase->>'n')::int, v_phase->>'name', v_phase->>'nameEn',
        (v_phase->>'durationDays')::int, COALESCE(v_phase->'goals', '[]'::jsonb), (v_phase->>'n')::int
      )
      ON CONFLICT (id) DO NOTHING;

      v_ex_order := 0;
      FOR v_exercise IN SELECT * FROM jsonb_array_elements(v_phase->'exercises') LOOP
        v_ex_order := v_ex_order + 1;
        v_exercise_name_en := v_exercise->>'nameEn';

        v_exercise_id := uuid_generate_v5(uuid_ns_url(), 'recoveryos:exercise:' || (v_exercise->>'name'));

        v_category := CASE
          WHEN v_exercise_name_en ~* 'running|jogging|\\ybike\\y|walking program|low-impact cardio|aqua jogging|sprint progression'
            THEN 'Cardio'
          WHEN v_exercise_name_en ~* 'balance|wobble'
            THEN 'Balance'
          WHEN v_exercise_name_en ~* 'stretch|\\yrom\\y|mobility|nerve glide|foam rolling|cat-cow|pendulum|slides|alphabet|tendon glide'
            THEN 'Mobility'
          WHEN v_exercise_name_en ~* 'agility|plyometric|landing mechanics|change of direction|rhythmic stabilization|return to (sport|run|racquet)|gait (retraining|assessment)|cutting|hopping|drills|running (gait|mechanics)'
            THEN 'Control'
          ELSE 'Strength'
        END;

        INSERT INTO app.exercise (id, clinic_id, name, name_en, category, source, is_active)
        VALUES (v_exercise_id, NULL, v_exercise->>'name', v_exercise_name_en, v_category, 'system', true)
        ON CONFLICT (id) DO NOTHING;

        v_sets := NULLIF(trim(split_part(v_exercise->>'prescription', '×', 1)), '')::int;
        v_reps := NULLIF(trim(split_part(v_exercise->>'prescription', '×', 2)), '')::int;

        INSERT INTO app.protocol_phase_exercise (id, protocol_phase_id, exercise_id, prescription, frequency, "order")
        VALUES (
          uuid_generate_v5(uuid_ns_url(), 'recoveryos:ppe:' || v_protocol_slug || ':' || (v_phase->>'n') || ':' || v_ex_order),
          v_phase_id, v_exercise_id,
          jsonb_build_object('sets', v_sets, 'reps', v_reps),
          v_exercise->>'frequency', v_ex_order
        )
        ON CONFLICT (id) DO NOTHING;
      END LOOP;

      v_crit_order := 0;
      FOR v_criterion IN SELECT * FROM jsonb_array_elements(v_phase->'criteria') LOOP
        v_crit_order := v_crit_order + 1;
        v_label_en := v_criterion->>'labelEn';

        v_db_type := CASE v_criterion->>'type'
          WHEN 'זמן' THEN 'time'
          WHEN 'כאב' THEN 'pain'
          WHEN 'ROM' THEN 'rom'
          WHEN 'כוח' THEN 'strength'
          WHEN 'הערכה' THEN 'assessment'
          WHEN 'אישור ידני' THEN 'manual'
          ELSE 'manual'
        END;

        v_val := NULLIF((regexp_match(v_label_en, '(\\d+(\\.\\d+)?)'))[1], '')::numeric;
        v_op := CASE
          WHEN v_label_en ~ '≤' THEN 'lte'
          WHEN v_label_en ~ '≥' THEN 'gte'
          WHEN v_val IS NOT NULL AND v_db_type = 'time' THEN 'gte'
          ELSE 'eq'
        END;
        v_unit := CASE
          WHEN v_label_en ~ '/10' THEN '0-10'
          WHEN v_label_en ~ '%' THEN '%'
          WHEN v_db_type = 'time' THEN 'days'
          ELSE NULL
        END;
        IF v_val IS NULL THEN
          v_val := 1; -- non-numeric criteria (e.g. "ROM within normal limits", "Clinician approval")
        END IF;

        INSERT INTO app.protocol_phase_criterion (id, protocol_phase_id, type, label, label_en, operator, value, unit, "order")
        VALUES (
          uuid_generate_v5(uuid_ns_url(), 'recoveryos:ppc:' || v_protocol_slug || ':' || (v_phase->>'n') || ':' || v_crit_order),
          v_phase_id, v_db_type, v_criterion->>'label', v_label_en, v_op, v_val, v_unit, v_crit_order
        )
        ON CONFLICT (id) DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
`;

fs.writeFileSync(outPath, sql);
console.log('wrote', outPath, Buffer.byteLength(sql), 'bytes');
