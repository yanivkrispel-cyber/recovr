-- Performance: exercise_id foreign keys on these two tables had no index.
-- app.search_exercises() does a correlated lookup against both for every row
-- in its result set (up to 300 rows), which meant a sequential scan repeated
-- hundreds of times on every exercise-picker open. Postgres does not
-- auto-index foreign key columns.
CREATE INDEX IF NOT EXISTS exercise_media_exercise_idx ON app.exercise_media(exercise_id);
CREATE INDEX IF NOT EXISTS protocol_phase_exercise_exercise_idx ON app.protocol_phase_exercise(exercise_id);
