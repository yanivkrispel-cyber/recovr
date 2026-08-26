# RecoveryOS

> Private clinic platform for sports-injury rehabilitation.
> Two apps: a clinician web console (`/app`) and a patient mobile-first PWA (`/m`).

## Status

**M0 — Foundations.** Repo scaffold, design tokens, shared UI primitives, Hebrew i18n, shared zod schemas, offline queue, Postgres schema (schema-per-clinic tenancy), three edge functions (me/today, me/sessions/:id/items, phase-approve), clinician login + dashboard, patient home + exercise flow.

## Stack

- **Monorepo** — pnpm workspaces
- **Apps** — `apps/clinician` (Vite + React 18), `apps/patient` (Vite + React 18 + PWA)
- **Packages** — `ui` (primitives), `tokens` (CSS design tokens), `shared` (i18n + zod schemas), `offline` (IndexedDB queue + UUIDv7)
- **Backend** — Supabase (Postgres 15, Auth, Edge Functions, Storage)
- **Tenancy** — schema-per-clinic; shared `app` schema holds cross-clinic data

## Layout

```
apps/
  clinician/   # /app — desktop-first web
  patient/     # /m   — mobile-first PWA
packages/
  ui/          # Button, Input, Card, Modal, Drawer, Table, Toast, ...
  tokens/      # CSS design tokens (colors, type, spacing, motion)
  shared/      # i18n (he), zod schemas, types
  offline/     # IndexedDB queue + UUIDv7 (idempotent client IDs)
supabase/
  migrations/  # 0001_initial_schema.sql
  functions/   # me-today, me-sessions-items, phase-approve, ...
  seed/        # demo clinic seed
```

## First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Set up Supabase locally (see "Supabase setup" below)

# 3. Apply migrations + seed
supabase db reset

# 4. Run both apps
pnpm dev
# → clinician: http://localhost:5173
# → patient:   http://localhost:5174/m
```

## Design rules (non-negotiable)

- **Hebrew RTL default.** Use logical CSS properties (`margin-inline-start`, `padding-block-end`) — no `left`/`right`.
- **Tokens only.** No ad-hoc hex in components — every color/spacing/radius/elevation comes from `packages/tokens/src/index.css`.
- **Clinical logic in Postgres + Edge Functions.** The client never decides adherence, alerts, or phase advancement.
- **No automatic phase advancement.** Every transition requires clinician approval with an immutable `phase_transition` row carrying a `criteria_snapshot`.
- **Append-only measurements.** Edits supersede, never mutate.
- **ROM is type-bound.** Goniometric (3 attempts) and functional (cm/pass-fail) are never interchangeable.

## Roadmap

- [x] M0 — Foundations (monorepo, tokens, UI, schemas, offline, auth shells, clinician dashboard, patient home + exercise flow)
- [ ] M1 — Patient flow complete (ROM entry, rest-day, adherence badge, PWA install)
- [ ] M2 — Clinician: patient detail, plan builder, plan versioning, ROM review
- [ ] M3 — Clinician: phase transitions, alerts review, assessments
- [ ] M4 — Multi-clinic, invitations, audit log UI
- [ ] M5 — Hardening, accessibility audit, performance, CI/CD

## Supabase setup

The Supabase CLI manages the local Postgres + Auth + Edge Functions stack. You need it installed.

### Install the CLI

```bash
# macOS / Linux / WSL2 — recommended
brew install supabase/tap/supabase

# Windows (PowerShell, native — works with this repo)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# Alternative: npm
npm i -g supabase
```

### Start the local stack

```bash
# From the repo root
supabase start

# This will print something like:
#   API URL:    http://127.0.0.1:54321
#   DB URL:     postgresql://postgres:postgres@127.0.0.1:54322/postgres
#   Studio URL: http://127.0.0.1:54323
#   anon key:   eyJ...
#   service_role key: eyJ...
```

### Wire the apps

Copy these values into `apps/clinician/.env` and `apps/patient/.env`:

```env
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key from `supabase status`>
```

### Apply migrations and seed

```bash
supabase db reset        # drops, re-applies all migrations, then runs supabase/seed/seed.sql
```

### Create a test clinician (one time)

The seed references a clinician by email. Create the auth user once via Studio (`http://127.0.0.1:54323`) → Authentication → Users → Add user → email `clinician@demo.recoveryos.app`, password `demo1234`, email confirm off. Then re-run the seed (or just `supabase db reset`).

## Scripts

```bash
pnpm dev         # run both apps in parallel
pnpm build       # build all packages + apps
pnpm lint        # eslint across the monorepo
pnpm typecheck   # tsc --noEmit across the monorepo
pnpm test        # vitest across the monorepo
```

## License

Proprietary — all rights reserved.
