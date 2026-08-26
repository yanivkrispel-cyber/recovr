#!/usr/bin/env node
// scripts/apply-to-all-clinics.ts
// Reads each clinic schema name from app.clinic, then applies the template DDL to it.
// Usage: deno run --allow-all scripts/apply-to-all-clinics.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DRY_RUN = process.env.DRY_RUN === 'true';

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function applyToAllClinics() {
  const { data: clinics, error } = await admin
    .from('app.clinic')
    .select('slug, name');

  if (error) throw error;
  if (!clinics?.length) {
    console.log('No clinics found.');
    return;
  }

  console.log(`Applying to ${clinics.length} clinic(s)...`);

  for (const clinic of clinics) {
    const schemaName = `clinic_${clinic.slug}`;
    console.log(`  → ${clinic.name} (${schemaName})`);

    if (DRY_RUN) {
      console.log('    [DRY RUN — skipped]');
      continue;
    }

    // Set search_path to the clinic schema and apply the migration
    // The template schema SQL is applied as-is with schema prefix replaced.
    const migrationSQL = Deno.readTextFileSync('supabase/migrations/0001_initial_schema.sql');

    // Extract only the clinic-schema tables (everything after the line that starts clinic schema)
    const lines = migrationSQL.split('\n');
    const clinicSectionStart = lines.findIndex(
      (l) => l.includes('-- CLINIC SCHEMA TEMPLATE'),
    );
    if (clinicSectionStart === -1) {
      console.warn(`  WARNING: No clinic schema section found in migration`);
      continue;
    }

    const clinicDDL = lines.slice(clinicSectionStart).join('\n');

    // Replace all unqualified table references with schema-qualified ones
    const qualified = clinicDDL.replace(
      /CREATE TABLE ([a-z_]+)/gi,
      `CREATE TABLE ${schemaName}.$1`,
    );

    try {
      await admin.rpc('exec', { sql: qualified });
      console.log(`    ✓ Applied`);
    } catch (err) {
      console.error(`    ✗ Failed: ${err}`);
    }
  }
}

applyToAllClinics().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
