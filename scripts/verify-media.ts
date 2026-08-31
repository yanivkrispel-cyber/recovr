#!/usr/bin/env -S deno run --allow-net --allow-env
// scripts/verify-media.ts
// T-14 — mark ingested exercise media as verified.
//
// An `app.exercise_media` row is served to a patient or into a printed program
// only when `verified_at IS NOT NULL` (CLAUDE.md §Media, RULES §7). This script
// is the one place that sets it: a clinician confirms the media depicts the
// exercise AND that the licensing question is answered.
//
// It refuses to run without ALLOW_MEDIA_VERIFY=true, because the bundled
// `exercises-dataset-main` media is © Gym visual and nothing may be verified
// before that license is resolved.
//
// Usage:
//   ALLOW_MEDIA_VERIFY=true VERIFIED_BY=<app.user id> \
//     deno run --allow-net --allow-env scripts/verify-media.ts --all
//   ... --exercise 0001 --exercise 0002        (scope to dataset ids)
//   ... --unverify --all                        (revert; VERIFIED_BY not needed)
// Requires: SUPABASE_DB_URL (see `supabase status`).

import { Client } from 'jsr:@db/postgres@0.19';

const DB_URL = Deno.env.get('SUPABASE_DB_URL');
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is required (see `supabase status`).');
  Deno.exit(1);
}

const argv = Deno.args;
const unverify = argv.includes('--unverify');
const all = argv.includes('--all');
const exerciseRefs = argv.reduce<string[]>((acc, a, i) => {
  if (a === '--exercise' && argv[i + 1]) acc.push(argv[i + 1]);
  return acc;
}, []);

if (!all && exerciseRefs.length === 0) {
  console.error('Nothing selected. Pass --all or one or more --exercise <dataset-id>.');
  Deno.exit(1);
}

if (!unverify && Deno.env.get('ALLOW_MEDIA_VERIFY') !== 'true') {
  console.error(
    'Refusing to verify: set ALLOW_MEDIA_VERIFY=true only once the Gym visual license question is resolved (CLAUDE.md §Media).',
  );
  Deno.exit(1);
}

const verifiedBy = Deno.env.get('VERIFIED_BY') ?? null;
if (!unverify && !verifiedBy) {
  console.error('VERIFIED_BY (an app.user id) is required when verifying.');
  Deno.exit(1);
}

const db = new Client(DB_URL);
await db.connect();
try {
  await db.queryArray('SET search_path TO app, public, extensions');

  const scope = all
    ? `e.external_ref ~ '^[0-9]{4}$'`
    : `e.external_ref = ANY($SCOPE)`;

  const setClause = unverify
    ? 'verified_at = NULL, verified_by = NULL'
    : 'verified_at = now(), verified_by = $BY::uuid';

  let sql = `
    WITH upd AS (
      UPDATE app.exercise_media m
      SET ${setClause}
      FROM app.exercise e
      WHERE m.exercise_id = e.id
        AND e.source = 'system'
        AND ${scope}
      RETURNING 1
    )
    SELECT count(*) AS n FROM upd
  `;

  const params: unknown[] = [];
  if (!unverify) {
    params.push(verifiedBy);
    sql = sql.replace('$BY', `$${params.length}`);
  }
  if (!all) {
    params.push(exerciseRefs);
    sql = sql.replace('$SCOPE', `$${params.length}`);
  }

  const res = await db.queryObject<{ n: bigint }>(sql, params);
  const n = Number(res.rows[0].n);
  console.log(`${unverify ? 'Unverified' : 'Verified'} ${n} exercise_media row(s).`);
} finally {
  await db.end();
}
