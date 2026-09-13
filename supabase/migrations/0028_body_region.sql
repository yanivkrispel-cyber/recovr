-- T-28 — canonical body-region taxonomy.
--
-- Fixes: app.exercise.region and app.protocol.region/region_en were free
-- text with no shared vocabulary. Live data before this migration: 27
-- protocols had 20 distinct `region` strings for what's clinically ~9
-- regions (e.g. "ברך"/"Knee", "ברך (מדיאלי)"/"Knee (Medial)",
-- "ברך/ירך לטרלי"/"Lateral Knee/Hip" are four different strings that are
-- all clinically "knee"), and app.exercise.region separately held the
-- exercises-dataset-main import's bodybuilding muscle-group taxonomy
-- ("upper arms", "waist", "chest", ...) plus a few stray hand-seeded
-- clinical values. Because search_exercises's region filter matched exact
-- text, filtering by "Knee" only returned the one protocol literally
-- spelled that way — the medial-knee, lateral-knee/hip, and
-- tibial-tuberosity protocols were invisible to it.
--
-- 0028 (this file) adds the canonical reference table. 0029 adds the FK
-- columns and backfills/renames/drops the old free-text columns. 0030
-- updates every function that reads or writes region.

CREATE TABLE app.body_region (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,   -- Hebrew
  name_en     TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global reference data (no clinic_id), same as system exercise/protocol
-- rows. Not granted to `authenticated` directly — read only via
-- app.exercise_filter_options, same access pattern as every other table in
-- this schema (business logic lives in SECURITY DEFINER functions, which
-- run with the definer's privileges regardless of table grants).
INSERT INTO app.body_region (slug, name, name_en, sort_order) VALUES
  ('shoulder',   'כתף',           'Shoulder',     1),
  ('elbow',      'מרפק',          'Elbow',        2),
  ('wrist_hand', 'שורש כף היד',   'Wrist & Hand', 3),
  ('spine',      'עמוד שדרה',     'Spine',        4),
  ('hip_thigh',  'ירך ומפשעה',    'Hip & Thigh',  5),
  ('knee',       'ברך',           'Knee',         6),
  ('lower_leg',  'שוק',           'Lower Leg',    7),
  ('ankle_foot', 'קרסול וכף רגל', 'Ankle & Foot', 8),
  ('other',      'אחר',           'Other',        9);
