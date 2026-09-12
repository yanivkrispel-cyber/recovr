// Assembles apps/clinician/dist and apps/patient/dist into firebase-public/
// so Firebase Hosting can serve both PWAs from one site at /app and /m,
// matching their Vite `base` paths. Run `pnpm build` first.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'firebase-public');

const apps = [
  { name: 'clinician', dist: resolve(root, 'apps/clinician/dist'), target: 'app' },
  { name: 'patient', dist: resolve(root, 'apps/patient/dist'), target: 'm' },
];

for (const app of apps) {
  if (!existsSync(app.dist)) {
    console.error(`Missing ${app.dist} — run "pnpm build" before this script.`);
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const app of apps) {
  cpSync(app.dist, resolve(outDir, app.target), { recursive: true });
  console.log(`copied ${app.name} -> firebase-public/${app.target}`);
}

writeFileSync(
  resolve(outDir, 'index.html'),
  `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ReCOVR</title>
  </head>
  <body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem;">
    <h1>ReCOVR</h1>
    <p><a href="/app/">כניסת מטפל</a></p>
    <p><a href="/m/">כניסת מטופל</a></p>
  </body>
</html>
`,
);
console.log('wrote firebase-public/index.html (landing page)');
