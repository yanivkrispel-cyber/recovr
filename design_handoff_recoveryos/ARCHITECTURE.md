# ARCHITECTURE.md

## 1. Stack
- **Web:** React 18 + TypeScript + Vite. Two entry points, one design-token layer:
  `/app` clinician (desktop-first, usable at 1024px, **tablet view-only in v1**),
  `/m` patient (mobile-first PWA, installable, offline-capable).
- **Data:** Supabase Postgres 15. Auth: Supabase Auth. Files: Supabase Storage.
  Server code: Edge Functions (Deno) + Postgres functions. Scheduling: `pg_cron`.
- **Hosting:** Vercel for the web build; Supabase for data/auth/storage/functions.
- **PDF:** browser print of `/m/program/print` (and clinician equivalent). No server renderer
  in v1 — the print stylesheet is the contract.

## 2. Tenancy — schema per clinic (chosen)
Shared `app` schema holds only cross-clinic data:
`app.clinic`, `app.user`, system `exercise` / `exercise_media` / `protocol` library,
`app.audit_log`.

Every clinic gets its own schema `clinic_<slug>` containing all clinical tables from
`DATA_MODEL.md` (patient, plan*, session*, measurement, adherence_daily, phase_transition,
alert, notification, message, plan_template, clinic-custom exercises/protocols).

Implementation:
1. `app.clinic_template` schema is the canonical DDL. Migrations are written **once**
   against the template and applied to every clinic schema by a migration runner
   (`supabase/migrations/*` + `scripts/apply-to-all-clinics.ts`). Never hand-edit one clinic.
2. `app.provision_clinic(name, timezone)` clones the template schema, seeds settings, returns
   the schema name. Idempotent.
3. **Clinic schemas are not exposed to PostgREST.** All access goes through the API layer with
   the service role; the layer resolves the caller's `clinic_id` from the JWT and sets
   `search_path` to that clinic's schema for the transaction. This is what makes rule 4
   (cross-clinic → 404) structural rather than a check someone can forget.
4. RLS stays enabled inside clinic schemas as defense in depth (clinician sees own clinic;
   patient sees only own `patient_id`).

**Cost to accept:** N schemas means migrations run N times and cross-clinic reporting needs
explicit fan-out. Acceptable at the expected clinic count; if it exceeds ~50 clinics, revisit
before M4 rather than after.

## 3. Where logic lives (recommended, adopt unless told otherwise)
| Concern | Home |
|---|---|
| Adherence computation | Postgres function `recompute_adherence(patient_id, date)`, called by trigger on session write **and** nightly `pg_cron` at 02:00 patient-local |
| Criteria evaluation | Postgres function over latest `measurement` rows; result cached on `plan_criterion.is_met` |
| Alerts | `pg_cron` job → Postgres function per alert type, dedupe by `dedupe_key` |
| Phase approval, plan versioning, invite acceptance, consent | Edge Function (transactional, audited) |
| Notification scheduling & send | Edge Function + `pg_cron` drain of `notification` where `scheduled_for <= now()`, honoring quiet hours and caps |
| Reads for screens | Edge Function endpoints per `API_CONTRACT.md` (never client-direct, see §2.3) |
| Client | Rendering, local draft state, offline queue. No clinical arithmetic. |

Rationale: the rules in `RULES.md` are data-shaped (windows, thresholds, dedupe), so they
belong next to the data — one implementation, testable in SQL, impossible to skip from a
client. Edge Functions handle only what needs a transaction boundary or an external call.

## 4. Repository layout
```
/apps
  /clinician        React app  → /app
  /patient          React app  → /m  (PWA: manifest, service worker)
/packages
  /ui               primitives from DESIGN_TOKENS.md (Button, Input, Table, Modal, …)
  /tokens           generated token layer — single source of style values
  /shared           types generated from the DB, zod schemas, formatters, i18n (he)
  /offline          IndexedDB queue + sync (patient only)
/supabase
  /migrations       template-schema DDL, versioned
  /functions        Edge Functions, one folder per endpoint group
  /seed             system protocols (protocols-data.js), demo clinic, dev users
/scripts            apply-to-all-clinics, ingest-exercises, verify-media
/docs               this bundle, copied in
```

## 5. Frontend conventions
- Data access through generated typed clients only; no fetch calls in components.
- Server state: TanStack Query. Local/draft state: component state or a small store.
  The plan editor holds a **draft** and commits atomically (`RULES.md` §3).
- Forms: react-hook-form + zod, schemas shared with the API layer from `packages/shared`.
- i18n: `he` only in v1, but all strings come from the i18n layer (`COPY.md`), never inline
  JSX text — the English fallback fields in the data model exist for a reason.
- Direction: `dir="rtl"` on `<html>`; logical CSS properties only.
- Dates and timezones: everything stored UTC, displayed in the patient's timezone.
  Day boundaries for sessions/adherence are **patient-local**, not server-local.

## 6. Offline (patient)
Service worker: cache-first for exercise media of the current phase, stale-while-revalidate
for today's plan JSON, network-only for everything else. Session logs are written to an
IndexedDB queue with a client-generated UUIDv7 id and flushed on reconnect. Server is
authoritative for plan content, client for logs (`RULES.md` §6).

## 7. Environments
`local` (Supabase CLI) → `staging` (own Supabase project, seeded demo clinic) →
`production`. No production data in any other environment, ever. Secrets in Vercel/Supabase
env vars; see `.env.example`.
