#!/usr/bin/env -S deno run --allow-net --allow-env
// scripts/apply-to-all-clinics.ts
// Ensures every clinic schema has the current CLINIC SCHEMA TEMPLATE table
// set applied. Calls create_clinic_tables() per clinic over a direct
// Postgres connection: that function (and every clinic_<slug> schema it
// targets) is not exposed through PostgREST — see [api] schemas in
// config.toml, which lists only app/storage/graphql_public — so this
// can't go through supabase-js/REST like the rest of the codebase does.
// create_clinic_tables() only adds missing tables/indexes
// (CREATE ... IF NOT EXISTS); it never drops or alters existing ones, so
// this is safe to run against live clinic data.
//
// Usage: deno run --allow-net --allow-env scripts/apply-to-all-clinics.ts
// Requires: SUPABASE_DB_URL (see `supabase status` -> DB_URL).
// DRY_RUN=true previews without applying.

import { Client } from 'jsr:@db/postgres@0.19';

const DB_URL = Deno.env.get('SUPABASE_DB_URL');
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is required (see `supabase status` -> DB_URL).');
  Deno.exit(1);
}
const DRY_RUN = Deno.env.get('DRY_RUN') === 'true';

const client = new Client(DB_URL);
await client.connect();

try {
  const { rows: clinics } = await client.queryObject<{ slug: string; name: string }>(
    'SELECT slug, name FROM app.clinic',
  );

  if (clinics.length === 0) {
    console.log('No clinics found.');
  } else {
    console.log(`Applying to ${clinics.length} clinic(s)...`);
    for (const clinic of clinics) {
      const schemaName = `clinic_${clinic.slug}`;
      console.log(`  → ${clinic.name} (${schemaName})`);

      if (DRY_RUN) {
        console.log('    [DRY RUN — skipped]');
        continue;
      }

      try {
        await client.queryObject('SELECT create_clinic_tables($1)', [schemaName]);
        console.log('    ✓ Applied');
      } catch (err) {
        console.error(`    ✗ Failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
} finally {
  await client.end();
}
