#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
// scripts/ingest-exercises.ts
// T-14 — ingest `exercises-dataset-main` into the system exercise library.
//
// Walks the local dataset, upserts app.exercise + app.exercise_media rows
// (system library: clinic_id = NULL), and uploads each 180x180 thumbnail and
// animation GIF to the `exercise-media` Storage bucket.
//
// Idempotent: every row is keyed by a UUID deterministically derived from the
// dataset's own id (uuid_generate_v5), so re-running refreshes metadata and
// media URLs in place and never duplicates.
//
// By default `verified_at` is NOT written — ingested media stays unverified
// (CLAUDE.md §Media: dataset media is © Gym visual, unverified until licensed);
// use scripts/verify-media.ts for selective verification. Pass --verify (or
// INGEST_VERIFY=true) to mark all freshly-ingested dataset media verified in the
// same run — the "media seed step" for a local DB, since a `supabase db reset`
// wipes exercise_media and ingest has to run again afterwards anyway.
//
// Reports rather than guessing (TASKS T-14):
//   - dataset records whose media files are missing on disk
//   - media files on disk that no dataset record references
//   - exercises in the DB that still have no media row, by source
//
// Usage:
//   deno run --allow-read --allow-write --allow-net --allow-env scripts/ingest-exercises.ts [--dry-run] [--verify] [--report <path>]
// Requires: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   (see `supabase status`). DRY_RUN=true is equivalent to --dry-run.

import { Client } from 'jsr:@db/postgres@0.19';

const BUCKET = 'exercise-media';
const OBJECT_PREFIX = 'dataset';
const MEDIA_DIM = 180; // dataset media is fixed 180x180
const UPLOAD_CONCURRENCY = 8;

const args = new Set(Deno.args);
const DRY_RUN = args.has('--dry-run') || Deno.env.get('DRY_RUN') === 'true';
const VERIFY = args.has('--verify') || Deno.env.get('INGEST_VERIFY') === 'true';
const reportPath = (() => {
  const i = Deno.args.indexOf('--report');
  return i >= 0 ? Deno.args[i + 1] : null;
})();

const DB_URL = Deno.env.get('SUPABASE_DB_URL');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!DB_URL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are all required (see `supabase status`).',
  );
  Deno.exit(1);
}

const datasetRoot = new URL('../exercises-dataset-main/', import.meta.url);
const jsonPath = new URL('data/exercises.json', datasetRoot);

interface DatasetRecord {
  id: string;
  name: string;
  category: string;
  body_part: string;
  equipment: string;
  instructions?: Record<string, string>;
  muscle_group?: string;
  secondary_muscles?: string[];
  target?: string;
  media_id: string;
  image: string; // "images/0001-2gPfomN.jpg"
  gif_url: string; // "videos/0001-2gPfomN.gif"
}

// --- derived fields ------------------------------------------------------------
// The dataset classifies by body part, not by rehab intent; category is a
// keyword guess (same approach as scripts/_gen-protocols-import.cjs) and worth a
// clinical review pass. region is stored verbatim from body_part — for system
// rows the exercise search derives region from protocol usage anyway.

function mapCategory(rec: DatasetRecord): string {
  const n = rec.name.toLowerCase();
  if (rec.body_part === 'cardio') return 'Cardio';
  if (/\b(stretch|mobility|foam roll|foam-roll)\b/.test(n)) return 'Mobility';
  if (/\b(balance|stability|bosu|wobble)\b/.test(n)) return 'Balance';
  return 'Strength';
}

function mapMuscles(rec: DatasetRecord): string[] {
  const raw = [rec.target, rec.muscle_group, ...(rec.secondary_muscles ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw) {
    const v = (m ?? '').trim().toLowerCase();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function mapEquipment(rec: DatasetRecord): string[] {
  const e = (rec.equipment ?? '').trim();
  return !e || e.toLowerCase() === 'body weight' ? [] : [e];
}

function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'gif') return 'image/gif';
  if (ext === 'png') return 'image/png';
  return 'image/jpeg';
}

// --- main --------------------------------------------------------------------

const raw = await Deno.readTextFile(jsonPath);
const records: DatasetRecord[] = JSON.parse(raw);
console.log(`Dataset: ${records.length} records${DRY_RUN ? ' (dry run)' : ''}`);

// Referenced media filenames, and which exist on disk.
const referenced = new Set<string>();
const missingFiles: { id: string; name: string; missing: string[] }[] = [];
const mediaToUpload: { objectPath: string; absPath: URL; contentType: string }[] = [];
const mediaRows: Record<string, unknown>[] = [];

for (const rec of records) {
  const imgRel = rec.image; // images/xx.jpg
  const gifRel = rec.gif_url; // videos/xx.gif
  referenced.add(imgRel);
  referenced.add(gifRel);

  const imgAbs = new URL(imgRel, datasetRoot);
  const gifAbs = new URL(gifRel, datasetRoot);
  const imgExists = await fileExists(imgAbs);
  const gifExists = await fileExists(gifAbs);

  const missing: string[] = [];
  if (!imgExists) missing.push(imgRel);
  if (!gifExists) missing.push(gifRel);
  if (missing.length) {
    missingFiles.push({ id: rec.id, name: rec.name, missing });
  }

  const imgFile = imgRel.split('/').pop()!;
  const gifFile = gifRel.split('/').pop()!;
  const imgObject = `${OBJECT_PREFIX}/${imgFile}`;
  const gifObject = `${OBJECT_PREFIX}/${gifFile}`;

  if (imgExists) {
    mediaToUpload.push({ objectPath: imgObject, absPath: imgAbs, contentType: contentTypeFor(imgFile) });
  }
  if (gifExists) {
    mediaToUpload.push({ objectPath: gifObject, absPath: gifAbs, contentType: contentTypeFor(gifFile) });
  }

  // gif is the primary display (order 0); the still thumbnail is order 1.
  if (gifExists) {
    mediaRows.push({
      key: rec.id,
      kind: 'gif',
      url: gifObject,
      thumb_url: imgExists ? imgObject : null,
      width: MEDIA_DIM,
      height: MEDIA_DIM,
      source_file: gifFile,
    });
  }
  if (imgExists) {
    mediaRows.push({
      key: rec.id,
      kind: 'image',
      url: imgObject,
      thumb_url: null,
      width: MEDIA_DIM,
      height: MEDIA_DIM,
      source_file: imgFile,
    });
  }
}

// Files on disk that nothing references.
const unmatchedFiles: string[] = [];
for (const dir of ['images', 'videos']) {
  for await (const entry of Deno.readDir(new URL(`${dir}/`, datasetRoot))) {
    if (!entry.isFile) continue;
    const rel = `${dir}/${entry.name}`;
    if (!referenced.has(rel)) unmatchedFiles.push(rel);
  }
}

const exerciseRows = records.map((rec) => ({
  key: rec.id,
  name: rec.name, // no Hebrew in the dataset — English name is a placeholder
  name_en: rec.name,
  category: mapCategory(rec),
  region: rec.body_part,
  muscles: mapMuscles(rec),
  equipment: mapEquipment(rec),
  instructions: rec.instructions?.en ?? null,
  is_bilateral: false,
}));

let uploaded = 0;
let uploadFailed = 0;
let exercisesUpserted = 0;
let mediaUpserted = 0;
let mediaVerified = 0;
let withoutMedia: { total: number; by_source: Record<string, number> } = { total: 0, by_source: {} };

if (!DRY_RUN) {
  // 1. Upload media to Storage via the REST API (bucket comes from migration
  //    0002). x-upsert makes re-runs overwrite in place.
  console.log(`Uploading ${mediaToUpload.length} media files to ${BUCKET}/${OBJECT_PREFIX}/ ...`);
  for (let i = 0; i < mediaToUpload.length; i += UPLOAD_CONCURRENCY) {
    const batch = mediaToUpload.slice(i, i + UPLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(async (m) => {
      const bytes = await Deno.readFile(m.absPath);
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${m.objectPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': m.contentType,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!res.ok) return `${res.status} ${(await res.text()).slice(0, 200)}`;
      return null;
    }));
    for (const err of results) {
      if (err) {
        uploadFailed++;
        if (uploadFailed <= 5) console.error(`  upload failed: ${err}`);
      } else {
        uploaded++;
      }
    }
  }
  if (uploadFailed) console.error(`  ${uploadFailed} upload(s) failed`);

  // 2. Upsert rows.
  const db = new Client(DB_URL);
  await db.connect();
  try {
    await db.queryArray('SET search_path TO app, public, extensions');

    const ex = await db.queryObject<{ n: bigint }>(
      `
      WITH up AS (
        INSERT INTO app.exercise
          (id, clinic_id, name, name_en, category, region, muscles, equipment,
           instructions, is_bilateral, source, external_ref, is_active)
        SELECT
          uuid_generate_v5(uuid_ns_url(), 'recoveryos:exercise:dataset:' || (r->>'key')),
          NULL, r->>'name', r->>'name_en', r->>'category', r->>'region',
          ARRAY(SELECT jsonb_array_elements_text(r->'muscles')),
          ARRAY(SELECT jsonb_array_elements_text(r->'equipment')),
          r->>'instructions', (r->>'is_bilateral')::boolean,
          'system', r->>'key', true
        FROM jsonb_array_elements($1::jsonb) AS r
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, name_en = EXCLUDED.name_en, category = EXCLUDED.category,
          region = EXCLUDED.region, muscles = EXCLUDED.muscles, equipment = EXCLUDED.equipment,
          instructions = EXCLUDED.instructions, external_ref = EXCLUDED.external_ref,
          is_active = EXCLUDED.is_active
        RETURNING 1
      )
      SELECT count(*) AS n FROM up
      `,
      [JSON.stringify(exerciseRows)],
    );
    exercisesUpserted = Number(ex.rows[0].n);

    const md = await db.queryObject<{ n: bigint }>(
      `
      WITH up AS (
        INSERT INTO app.exercise_media
          (id, exercise_id, kind, url, thumb_url, width, height, "order", source_file)
        SELECT
          uuid_generate_v5(uuid_ns_url(), 'recoveryos:exercise_media:dataset:' || (r->>'key') || ':' || (r->>'kind')),
          uuid_generate_v5(uuid_ns_url(), 'recoveryos:exercise:dataset:' || (r->>'key')),
          r->>'kind', r->>'url', r->>'thumb_url',
          (r->>'width')::int, (r->>'height')::int,
          CASE r->>'kind' WHEN 'gif' THEN 0 ELSE 1 END,
          r->>'source_file'
        FROM jsonb_array_elements($1::jsonb) AS r
        ON CONFLICT (id) DO UPDATE SET
          url = EXCLUDED.url, thumb_url = EXCLUDED.thumb_url, width = EXCLUDED.width,
          height = EXCLUDED.height, source_file = EXCLUDED.source_file
        -- verified_by / verified_at are deliberately left untouched on conflict.
        RETURNING 1
      )
      SELECT count(*) AS n FROM up
      `,
      [JSON.stringify(mediaRows)],
    );
    mediaUpserted = Number(md.rows[0].n);

    // Optional: mark all dataset media verified in the same run (--verify /
    // INGEST_VERIFY=true). This is the local "media seed step" — a db reset
    // wipes exercise_media, so verification has to happen alongside ingest.
    // verified_by prefers an admin, then any clinician, else NULL.
    if (VERIFY) {
      const vr = await db.queryObject<{ n: bigint }>(
        `
        WITH u AS (
          UPDATE app.exercise_media m
          SET verified_at = now(),
              verified_by = (SELECT id FROM app."user" ORDER BY (role = 'admin') DESC LIMIT 1)
          FROM app.exercise e
          WHERE m.exercise_id = e.id
            AND e.source = 'system'
            AND e.external_ref ~ '^[0-9]{4}$'
            AND m.verified_at IS NULL
          RETURNING 1
        )
        SELECT count(*) AS n FROM u
        `,
      );
      mediaVerified = Number(vr.rows[0].n);
    }

    const wm = await db.queryObject<{ source: string; n: bigint }>(
      `
      SELECT COALESCE(e.source, 'unknown') AS source, count(*) AS n
      FROM app.exercise e
      WHERE NOT EXISTS (SELECT 1 FROM app.exercise_media m WHERE m.exercise_id = e.id)
      GROUP BY COALESCE(e.source, 'unknown')
      `,
    );
    withoutMedia = { total: 0, by_source: {} };
    for (const row of wm.rows) {
      const n = Number(row.n);
      withoutMedia.by_source[row.source] = n;
      withoutMedia.total += n;
    }
  } finally {
    await db.end();
  }
}

const report = {
  ran_at: new Date().toISOString(),
  dry_run: DRY_RUN,
  dataset_records: records.length,
  exercises_upserted: exercisesUpserted,
  media_rows_planned: mediaRows.length,
  media_rows_upserted: mediaUpserted,
  media_rows_verified: mediaVerified,
  verify_requested: VERIFY,
  media_files_uploaded: uploaded,
  media_files_upload_failed: uploadFailed,
  records_with_missing_files: missingFiles,
  unmatched_files_on_disk: unmatchedFiles,
  db_exercises_without_media: withoutMedia,
};

console.log('\n--- ingest report ---');
console.log(`  dataset records ............ ${report.dataset_records}`);
console.log(`  exercises upserted ......... ${report.exercises_upserted}`);
console.log(`  media rows upserted ........ ${report.media_rows_upserted} / ${report.media_rows_planned} planned`);
console.log(`  media rows verified ........ ${VERIFY ? report.media_rows_verified : 'skipped (pass --verify)'}`);
console.log(`  media files uploaded ....... ${report.media_files_uploaded}${uploadFailed ? ` (${uploadFailed} failed)` : ''}`);
console.log(`  records w/ missing files ... ${missingFiles.length}`);
console.log(`  unmatched files on disk .... ${unmatchedFiles.length}`);
if (!DRY_RUN) {
  console.log(`  DB exercises without media . ${withoutMedia.total} (${
    Object.entries(withoutMedia.by_source).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'
  })`);
}
if (missingFiles.length) {
  console.log('\n  first missing:');
  for (const m of missingFiles.slice(0, 10)) console.log(`    ${m.id} ${m.name} -> ${m.missing.join(', ')}`);
}
if (unmatchedFiles.length) {
  console.log('\n  first unmatched:');
  for (const f of unmatchedFiles.slice(0, 10)) console.log(`    ${f}`);
}

if (reportPath) {
  await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written to ${reportPath}`);
}

async function fileExists(u: URL): Promise<boolean> {
  try {
    const st = await Deno.stat(u);
    return st.isFile;
  } catch {
    return false;
  }
}
