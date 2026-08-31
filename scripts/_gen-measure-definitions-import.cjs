// One-off generator: extracts ROM_CATALOG from the prototype .dc.html
// (a trusted local design file, not user input — safe to evaluate as JS)
// and writes supabase/seed/measure_definitions_import.sql. Re-run only if
// ROM_MEASUREMENT.md's catalog changes.
const fs = require('fs');
const path = require('path');

const protoPath = path.join(__dirname, '..', 'design_handoff_recoveryos', 'Rehab Platform Prototype.dc.html');
const outPath = path.join(__dirname, '..', 'supabase', 'seed', 'measure_definitions_import.sql');
const src = fs.readFileSync(protoPath, 'utf8');

const start = src.indexOf('const ROM_CATALOG = {') + 'const ROM_CATALOG = '.length;
const end = src.indexOf('\n};', start) + 3;
const literal = src.slice(start, end).replace(/;\s*$/, '');

// eslint-disable-next-line no-new-func
const ROM_CATALOG = new Function(`return (${literal});`)();

const joints = Object.keys(ROM_CATALOG);
let count = 0;
const rows = [];

for (const joint of joints) {
  for (const m of ROM_CATALOG[joint]) {
    count++;
    const unit = m.unit === 'cm' ? 'cm' : m.unit === 'pf' ? 'pass_fail' : 'deg';
    // Same fallback the prototype's romScaleOf() uses when scale is omitted.
    const scale = m.scale != null
      ? Math.abs(m.scale)
      : (m.deficit ? 20 : Math.max(20, Math.ceil((Math.abs(m.norm || 0) * 1.15) / 10) * 10));
    const normSource = m.normSource ?? (m.fx ? null : 'AAOS');
    const flags = {
      deficit: !!m.deficit,
      lower: !!m.lower,
      fx: !!m.fx,
      bilat: m.bilat !== false,
      deg_opt: !!m.degOpt,
    };
    if (m.sideDiff != null) flags.side_diff = m.sideDiff;
    if (m.riskBelow != null) flags.risk_below = m.riskBelow;

    rows.push({
      code: m.id,
      joint,
      name_he: m.he,
      name_en: m.en,
      unit,
      norm: m.norm ?? null,
      target: m.target ?? null,
      scale,
      flags,
      norm_source: normSource,
      protocol_tip: m.tip ?? null,
    });
  }
}

function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

const values = rows.map((r) => `  (
    uuid_generate_v5(uuid_ns_url(), 'recoveryos:measure_definition:' || ${sqlLit(r.code)}),
    NULL, ${sqlLit(r.code)}, ${sqlLit(r.joint)}, ${sqlLit(r.name_he)}, ${sqlLit(r.name_en)},
    ${sqlLit(r.unit)}, ${sqlLit(r.norm)}, ${sqlLit(r.target)}, ${sqlLit(r.scale)},
    '${JSON.stringify(r.flags)}'::jsonb, ${sqlLit(r.norm_source)}, ${sqlLit(r.protocol_tip)}
  )`).join(',\n');

const sql = `-- ============================================================================
-- Measure definition catalog — imported from ROM_CATALOG in
-- design_handoff_recoveryos/Rehab Platform Prototype.dc.html
-- (see scripts/_gen-measure-definitions-import.cjs; T-09b).
-- Loaded via [db.seed] sql_paths in config.toml, separate from seed.sql,
-- since this is global system data (clinic_id = NULL), not demo-clinic data.
-- Idempotent: id is uuid_generate_v5 derived from the measure code, so
-- ON CONFLICT (id) DO NOTHING makes re-running safe.
-- ============================================================================

INSERT INTO public.measure_definition (
  id, clinic_id, code, joint, name_he, name_en, unit, norm, target, scale, flags, norm_source, protocol_tip
) VALUES
${values}
ON CONFLICT (id) DO NOTHING;
`;

fs.writeFileSync(outPath, sql);
console.log('wrote', outPath, count, 'measure definitions across', joints.length, 'joints');
