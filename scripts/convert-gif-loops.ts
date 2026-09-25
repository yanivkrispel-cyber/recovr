#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-run
// scripts/convert-gif-loops.ts
// Gives every animated-GIF media row a small MP4 rendition (loop_url, 0053):
// downloads the GIF from the private exercise-media bucket, converts it with
// ffmpeg (H.264, yuv420p, faststart, no audio, transparency flattened onto
// white), uploads `<path>.loop.mp4` next to it and records the path. The
// library's 180x180 loops shrink ~92 KB -> ~8 KB. Idempotent: only rows with
// loop_url IS NULL are touched, so it can be re-run after an ingest or after
// clinics upload more GIFs.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   deno run --allow-read --allow-write --allow-net --allow-env --allow-run \
//     scripts/convert-gif-loops.ts [--dry-run] [--limit N]
//
// ffmpeg: uses a local `ffmpeg` if it's on PATH, otherwise runs it through
// Docker (linuxserver/ffmpeg).

const BUCKET = 'exercise-media';
const CONCURRENCY = 4;
const CACHE_CONTROL = 'max-age=2592000'; // matches the 30-day signed-URL reuse

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  Deno.exit(1);
}
const DRY_RUN = Deno.args.includes('--dry-run');
const limitArg = Deno.args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(Deno.args[limitArg + 1]) : Infinity;

const auth = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
const appSchema = { 'Accept-Profile': 'app', 'Content-Profile': 'app' };

async function hasLocalFfmpeg(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command('ffmpeg', { args: ['-version'], stdout: 'null', stderr: 'null' }).output();
    return success;
  } catch {
    return false;
  }
}

// Flatten any transparency onto white (a few library GIFs have it; H.264 has
// no alpha, so it would otherwise turn black), then even dimensions for 4:2:0.
const FFMPEG_FILTER = '[0:v]format=rgba,split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';

function ffmpegArgs(input: string, output: string): string[] {
  return ['-v', 'error', '-y', '-i', input, '-filter_complex', FFMPEG_FILTER,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-movflags', '+faststart', '-an', output];
}

async function convert(dir: string, local: boolean): Promise<void> {
  const cmd = local
    ? new Deno.Command('ffmpeg', { args: ffmpegArgs(`${dir}/in.gif`, `${dir}/out.mp4`), stderr: 'piped' })
    : new Deno.Command('docker', {
      args: ['run', '--rm', '-v', `${dir}:/w`, 'linuxserver/ffmpeg:latest', ...ffmpegArgs('/w/in.gif', '/w/out.mp4')],
      stderr: 'piped',
    });
  const { success, stderr } = await cmd.output();
  if (!success) throw new Error(`ffmpeg failed: ${new TextDecoder().decode(stderr).slice(0, 300)}`);
}

interface Row { id: string; url: string }

async function pendingRows(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/exercise_media?select=id,url&kind=eq.gif&loop_url=is.null&order=id`,
      { headers: { ...auth, ...appSchema, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const page: Row[] = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows.filter((r) => r.url && !r.url.startsWith('http') && !r.url.startsWith('/storage/'));
}

async function processRow(row: Row, local: boolean): Promise<string | null> {
  const loopPath = row.url.replace(/\.gif$/i, '') + '.loop.mp4';
  const dir = await Deno.makeTempDir({ prefix: 'gifloop-' });
  try {
    const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${row.url}`, {
      headers: auth, signal: AbortSignal.timeout(30_000),
    });
    if (!dl.ok) return `download ${dl.status}`;
    await Deno.writeFile(`${dir}/in.gif`, new Uint8Array(await dl.arrayBuffer()));

    await convert(dir, local);
    const mp4 = await Deno.readFile(`${dir}/out.mp4`);

    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${loopPath}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'video/mp4', 'x-upsert': 'true', 'cache-control': CACHE_CONTROL },
      body: mp4,
      signal: AbortSignal.timeout(30_000),
    });
    if (!up.ok) return `upload ${up.status} ${(await up.text()).slice(0, 120)}`;

    const patch = await fetch(`${SUPABASE_URL}/rest/v1/exercise_media?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...auth, ...appSchema, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ loop_url: loopPath }),
    });
    if (!patch.ok) return `update ${patch.status} ${(await patch.text()).slice(0, 120)}`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const rows = (await pendingRows()).slice(0, LIMIT);
console.log(`${rows.length} GIF media row(s) without an MP4 rendition.`);
if (DRY_RUN || rows.length === 0) Deno.exit(0);

const local = await hasLocalFfmpeg();
console.log(`ffmpeg: ${local ? 'local' : 'docker (linuxserver/ffmpeg)'}`);

let done = 0;
const failures: string[] = [];
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const batch = rows.slice(i, i + CONCURRENCY);
  const results = await Promise.all(batch.map((r) => processRow(r, local)));
  results.forEach((err, j) => {
    if (err) failures.push(`${batch[j].url}: ${err}`);
    else done++;
  });
  if ((i / CONCURRENCY) % 25 === 0) console.log(`  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}`);
}

console.log(`Converted ${done}/${rows.length}.`);
if (failures.length) {
  console.log(`${failures.length} failed (left with loop_url NULL, safe to re-run):`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  Deno.exit(1);
}
