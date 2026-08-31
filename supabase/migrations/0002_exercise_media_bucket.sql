-- Storage bucket for system exercise media (T-14).
--
-- Holds the ingested `exercises-dataset-main` thumbnails and animation GIFs.
-- Private: nothing here is patient-visible on its own. A media object only
-- reaches a patient or a printed program once its `app.exercise_media` row has
-- `verified_at` set (CLAUDE.md §Media, RULES §7), and that gate is enforced in
-- the API layer, not by bucket ACLs.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'exercise-media',
  'exercise-media',
  false,
  5242880,  -- 5 MiB; dataset media is 180x180, well under this
  ARRAY['image/jpeg', 'image/png', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;
