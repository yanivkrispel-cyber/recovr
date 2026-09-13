-- T-28 continued — add body_region_id/muscle_group, backfill from the old
-- free-text region/region_en (see 0028 for the "why"), then rename/drop the
-- old columns. Assumes 0028's 9-row app.body_region seed already ran.

ALTER TABLE app.exercise
  ADD COLUMN body_region_id UUID REFERENCES app.body_region(id),
  ADD COLUMN muscle_group TEXT;

ALTER TABLE app.protocol
  ADD COLUMN body_region_id UUID REFERENCES app.body_region(id);

CREATE INDEX app_exercise_body_region_idx ON app.exercise(body_region_id);
CREATE INDEX app_protocol_body_region_idx ON app.protocol(body_region_id);

-- --------------------------------------------------------------------------
-- Backfill app.protocol.body_region_id from the old region/region_en text,
-- collapsing the 20 distinct strings onto the 9 canonical regions. The
-- original text is preserved verbatim in region_detail/region_detail_en
-- (renamed below) — e.g. "Knee (Medial)" keeps its qualifier, it's just no
-- longer the only region signal used for filtering/grouping.
-- --------------------------------------------------------------------------
UPDATE app.protocol pr
SET body_region_id = br.id
FROM (VALUES
  ('מרפק',               'Elbow',                     'elbow'),
  ('ברך',                'Knee',                       'knee'),
  ('ירך אחורית',         'Posterior Thigh',            'hip_thigh'),
  ('עמוד שדרה מותני',    'Lumbar Spine',                'spine'),
  ('כתף',                'Shoulder',                   'shoulder'),
  ('קרסול',              'Ankle',                       'ankle_foot'),
  ('ברך/ירך לטרלי',      'Lateral Knee/Hip',            'knee'),
  ('עמוד שדרה צווארי',   'Cervical Spine',              'spine'),
  ('שורש כף היד',        'Wrist/Hand',                  'wrist_hand'),
  ('שוק',                'Calf',                        'lower_leg'),
  ('קרסול/עקב',          'Ankle/Heel',                  'ankle_foot'),
  ('כף רגל/עקב',         'Foot/Heel',                   'ankle_foot'),
  ('ברך (פקעת השוקה)',   'Knee (Tibial Tuberosity)',    'knee'),
  ('שוק תחתונה',         'Lower Leg',                   'lower_leg'),
  ('ברך (מדיאלי)',       'Knee (Medial)',               'knee'),
  ('ירך',                'Hip',                         'hip_thigh'),
  ('ירך קדמית',          'Thigh',                       'hip_thigh'),
  ('מפשעה/ירך',          'Groin/Hip',                   'hip_thigh'),
  ('שוק תחתונה/כף רגל',  'Lower Leg/Foot',              'lower_leg'),
  ('Knee',               NULL,                          'knee')
) AS m(region_text, region_en_text, slug)
JOIN app.body_region br ON br.slug = m.slug
WHERE pr.region = m.region_text
  AND (pr.region_en = m.region_en_text OR (pr.region_en IS NULL AND m.region_en_text IS NULL));

-- Anything left with a region set but unmapped — log for manual review,
-- never silently drop the clinician's intent.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, slug, region, region_en FROM app.protocol
    WHERE body_region_id IS NULL AND region IS NOT NULL
  LOOP
    RAISE NOTICE 'protocol % (%) has unmapped region=% region_en=% — left body_region_id NULL, review manually',
      r.id, r.slug, r.region, r.region_en;
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Backfill app.exercise. System dataset rows (source='system' with an
-- external_ref) get their bodybuilding taxonomy copied into muscle_group —
-- a different, legitimate concept (which muscle group the exercise trains,
-- not which clinical region it treats) that was wrongly living in `region`.
-- body_region_id is intentionally left NULL for these: their true clinical
-- region comes from protocol association, same as before this migration
-- (see search_exercises in 0030).
-- --------------------------------------------------------------------------
UPDATE app.exercise
SET muscle_group = region
WHERE source = 'system' AND external_ref IS NOT NULL AND region IS NOT NULL;

-- Non-dataset rows (hand-seeded system exercises + clinic-custom exercises)
-- run through the same region->slug mapping as protocols.
UPDATE app.exercise ex
SET body_region_id = br.id
FROM (VALUES
  ('מרפק', 'elbow'), ('ברך', 'knee'), ('ירך אחורית', 'hip_thigh'),
  ('עמוד שדרה מותני', 'spine'), ('כתף', 'shoulder'), ('קרסול', 'ankle_foot'),
  ('ברך/ירך לטרלי', 'knee'), ('עמוד שדרה צווארי', 'spine'),
  ('שורש כף היד', 'wrist_hand'), ('שוק', 'lower_leg'), ('קרסול/עקב', 'ankle_foot'),
  ('כף רגל/עקב', 'ankle_foot'), ('ברך (פקעת השוקה)', 'knee'),
  ('שוק תחתונה', 'lower_leg'), ('ברך (מדיאלי)', 'knee'), ('ירך', 'hip_thigh'),
  ('ירך קדמית', 'hip_thigh'), ('מפשעה/ירך', 'hip_thigh'),
  ('שוק תחתונה/כף רגל', 'lower_leg'), ('Knee', 'knee')
) AS m(region_text, slug)
JOIN app.body_region br ON br.slug = m.slug
WHERE (ex.source != 'system' OR ex.external_ref IS NULL)
  AND ex.region = m.region_text;

-- Anything left unmapped on a non-dataset row (e.g. a clinician typed a
-- muscle-group-style value like "waist" into the old free-text field) falls
-- back to 'other' rather than losing the tag entirely — logged for review.
DO $$
DECLARE
  r RECORD;
  v_other_id UUID;
BEGIN
  SELECT id INTO v_other_id FROM app.body_region WHERE slug = 'other';
  FOR r IN
    SELECT id, name, region FROM app.exercise
    WHERE body_region_id IS NULL AND region IS NOT NULL
      AND (source != 'system' OR external_ref IS NULL)
  LOOP
    RAISE NOTICE 'exercise % (%) has unmapped region=% — assigned to other, review manually',
      r.id, r.name, r.region;
    UPDATE app.exercise SET body_region_id = v_other_id WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE app.protocol RENAME COLUMN region TO region_detail;
ALTER TABLE app.protocol RENAME COLUMN region_en TO region_detail_en;

ALTER TABLE app.exercise DROP COLUMN region;
