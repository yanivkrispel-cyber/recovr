-- Catalog cleanup step 4 (2026-09-13) — link the dataset animation to a core
-- exercise where it's genuinely the same movement. See [[project-catalog-cleanup]].
--
-- Reviewed by trigram + exact-name matching over all 107 core exercises
-- against the 1,324 dataset exercises, then judged by hand (equipment and
-- body position, not just name text — the same "Chin Tucks -> chin-up"
-- false-positive class flagged in step 1's audit ruled out most
-- higher-scoring candidates: "Straight leg raise" -> "hanging straight leg
-- raise" is an ab exercise on a bar, "Band External Rotation" -> "band lying
-- hip internal rotation" is the wrong joint, "Bridge" -> "london bridge" is
-- an unrelated named exercise, etc.). Only 6 of 107 were a confident,
-- unqualified match — the dataset is overwhelmingly gym/bodybuilding
-- equipment (barbell, cable, machine), the core catalog is rehab bodyweight/
-- band work, so a low hit rate here is the honest result, not a bug.
--
-- These stay UNVERIFIED (verified_by/verified_at left NULL) per CLAUDE.md's
-- Media rule: dataset media is treated as unverified until the Gym visual
-- license question is answered, and unverified media is never served to a
-- patient or into a PDF (app.exercise_media_visible / the verified_at THEN
-- checks in patient_today, patient_plan, HomeProgramPrint). Linking here
-- only makes the candidate visible to a curator in the library workspace,
-- for their own reference — it does not ship anything to a patient. A
-- curator can verify (app.catalog_media_verify) once licensing is resolved.
--
-- Idempotent: guarded on (exercise_id, url) not already present. No
-- dependency on scripts/ingest-exercises.ts having run yet (that's a
-- separate manual step, [[project-exercise-ingest]]) — these rows just
-- reference the same dataset/ storage paths it uploads to, same as any
-- dataset-media row.
--
-- Wrapped in a function and called both here (existing databases) and again
-- at the end of seed.sql: on `db reset` these exercise rows don't exist yet
-- at migration time — protocols_import.sql/seed.sql run after every
-- migration — so the EXISTS guard below finds nothing on the first pass.
CREATE OR REPLACE FUNCTION app._catalog_link_dataset_media_2026_09_13() RETURNS VOID AS $$
INSERT INTO app.exercise_media (exercise_id, clinic_id, kind, url, thumb_url, width, height, "order", rights, attribution, review_note)
SELECT v.exercise_id, NULL, v.kind, v.url, v.thumb_url, 180, 180, v.ord, 'unknown',
  '© Gym visual — https://gymvisual.com/',
  'Matched from the exercises dataset during catalog cleanup step 4 (2026-09-13) — pending license verification before patient use.'
FROM (VALUES
  -- exercise_id, dataset exercise (for reference), kind, url, thumb_url, order
  ('ce43cf7b-b241-5870-9390-0eb8db6bce5b'::uuid, 'gif',   'dataset/1511-99rWm7w.gif', 'dataset/1511-99rWm7w.jpg', 0), -- Hamstring Stretch <- "hamstring stretch"
  ('ce43cf7b-b241-5870-9390-0eb8db6bce5b'::uuid, 'image', 'dataset/1511-99rWm7w.jpg', NULL, 1),
  ('64b549c2-2bab-598a-a34b-fca2fa9aff0a'::uuid, 'gif',   'dataset/0020-xAySMB0.gif', 'dataset/0020-xAySMB0.jpg', 0), -- Balance Board <- "balance board"
  ('64b549c2-2bab-598a-a34b-fca2fa9aff0a'::uuid, 'image', 'dataset/0020-xAySMB0.jpg', NULL, 1),
  ('a8266b74-a709-54f0-80f8-1937abee0d92'::uuid, 'gif',   'dataset/0276-iny3m5y.gif', 'dataset/0276-iny3m5y.jpg', 0), -- Dead Bug <- "dead bug"
  ('a8266b74-a709-54f0-80f8-1937abee0d92'::uuid, 'image', 'dataset/0276-iny3m5y.jpg', NULL, 1),
  ('c11013d4-e4f9-51e8-99b4-4e2d99510a14'::uuid, 'gif',   'dataset/3147-NKJ8o6x.gif', 'dataset/3147-NKJ8o6x.jpg', 0), -- Pelvic Tilts <- "pelvic tilt"
  ('c11013d4-e4f9-51e8-99b4-4e2d99510a14'::uuid, 'image', 'dataset/3147-NKJ8o6x.jpg', NULL, 1),
  ('17622353-f0f1-5592-a250-169312932696'::uuid, 'gif',   'dataset/0710-7WaDzyL.gif', 'dataset/0710-7WaDzyL.jpg', 0), -- Side-Lying Hip Abduction <- "side hip abduction"
  ('17622353-f0f1-5592-a250-169312932696'::uuid, 'image', 'dataset/0710-7WaDzyL.jpg', NULL, 1),
  ('d9d6ff62-b4fc-5eb3-afa3-3689e8c7b4d3'::uuid, 'gif',   'dataset/3645-rmEukuS.gif', 'dataset/3645-rmEukuS.jpg', 0), -- Single-Leg Bridge <- "single leg bridge with outstretched leg"
  ('d9d6ff62-b4fc-5eb3-afa3-3689e8c7b4d3'::uuid, 'image', 'dataset/3645-rmEukuS.jpg', NULL, 1)
) AS v(exercise_id, kind, url, thumb_url, ord)
WHERE EXISTS (SELECT 1 FROM app.exercise WHERE id = v.exercise_id AND deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = v.exercise_id AND m.url = v.url);
$$ LANGUAGE sql;

SELECT app._catalog_link_dataset_media_2026_09_13();
