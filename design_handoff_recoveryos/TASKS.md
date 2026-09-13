# TASKS.md — sequenced implementation

Each task lists its acceptance criteria. A task is done only when its criteria pass.
Suggested order is dependency order. Read `CLAUDE.md` first — it locks the stack and the
non-negotiable rules, and it defines Definition of Done for every task below.

**Locked:** React+TS+Vite · Supabase (Postgres/Auth/Storage/Edge/pg_cron) · Vercel+Supabase
hosting · schema-per-clinic tenancy · clinical logic in Postgres + Edge Functions ·
browser-print PDF · minimal (undesigned) auth screens · dataset media dev-only until licensed.
**Mode:** stop for review at the end of every milestone.

## M0 — Foundations
**T-01 Project scaffold & CI**
- Monorepo per `ARCHITECTURE.md` §4; lint, typecheck, test, build all run in CI.
- Supabase local dev works from a clean clone: `supabase start` + migrate + seed.
- `app.provision_clinic()` and `scripts/apply-to-all-clinics.ts` exist and are tested against
  two clinic schemas (`ARCHITECTURE.md` §2).
- Two app shells route separately: `/app` (clinician, desktop-first) and `/m` (patient, mobile-first PWA).
- Hebrew RTL is the default document direction; no layout depends on LTR.

**T-02 Design tokens & primitives**
- Tokens from `DESIGN_TOKENS.md` exist as the single source (no ad-hoc hex in components).
- Primitives built: Button (3 variants × 3 states), Input, Select, Checkbox, Toggle, Badge/Pill,
  Card, Table, Modal, Drawer, Toast, Tabs, EmptyState, Skeleton.
- Fonts self-hosted; Hebrew and Latin render at every weight used.

**T-03 Auth & tenancy**
- Supabase Auth; screens built minimal per `CLAUDE.md` §Auth (not designed — no invention).
- Clinician login, refresh, logout, forgot/reset. Patient invite → accept → password set →
  consent captured (`consent_version`, `consent_at`) with the disclaimer from `COPY.md`.
- Clinic schema resolved from the JWT in the API layer; clinic schemas are not PostgREST-exposed.
- Every query is clinic-scoped; a cross-clinic id returns 404, not 403.
- `audit_log` row on every patient-record read.

## M1 — Clinician core (P0)
**T-04 Data model + seed**
- Schema from `DATA_MODEL.md` migrated; `protocols-data.js` imported as system protocols.
- Seeding is idempotent and re-runnable.

**T-05 Dashboard**
- 4 KPI cards, patient table with filters (all / attention / ready / inactive), alert inbox.
- Loads in < 1.5s with 200 patients; empty state and error state implemented.

**T-06 Patient list & Patient Overview**
- Search by name, filters, sortable columns.
- Overview shows: summary, alerts, current goals, criteria progress, today's activity,
  recent-activity timeline, tabs (overview / assessments / history).

**T-07 Plan screen + Edit Plan**
- Phase timeline, current phase, exercise table matching the prototype.
- Editor: per-phase navigation, add/remove/reorder/modify exercise, copy phase, save as template.
- Save creates a new `plan_version` atomically; Discard leaves no trace; a 409 on a stale
  version shows a recoverable conflict dialog rather than losing the draft.
- Removing an exercise requires a reason.

**T-08 Add Exercise + Exercise library**
- Search + filters (category, region, limb, muscle, side, phase); multi-select add.
- Duplicate detection warns before adding an exercise already in the phase.
- Clinic-custom exercise creation.

**T-09 Progression criteria + approval**
- Criteria editor per phase; live met/not-met evaluation from measurements.
- Approve action writes an immutable `phase_transition`; approving without all criteria met
  requires a reason. **No automatic advancement anywhere in the codebase.**

**T-09b Measurement module (ROM & functional tests)**
- `measure_definition` seeded from `ROM_CATALOG` in the prototype; `measurement` and
  `assessment_visit` per `DATA_MODEL.md`; endpoints per `API_CONTRACT.md`.
- Measurement panel: arc gauge for degrees, horizontal ruler for cm, pass/fail +
  compensations; three attempts with governing-value picker for goniometric measures,
  numeric keypad for functional ones.
- WBLT, Thomas, Modified Schober, heel-to-buttock and deep squat appear automatically in
  their joint's list, each with its `ⓘ` protocol tooltip.
- Flag rules and colour-only treatment exactly per `RULES.md` §5b.
- An untouched optional field (tibial angle, compensations) never overwrites stored data.
- Editing a measurement supersedes rather than mutates; history stays complete.
- Acceptance criteria list in `ROM_MEASUREMENT.md` §6 all pass.

**T-28 Canonical body-region taxonomy**
- Fix: exercise/protocol `region` was free text with no shared vocabulary — 27 protocols had
  20 distinct `region` strings for what's clinically ~9 regions (e.g. "Knee", "Knee (Medial)",
  "Lateral Knee/Hip" were three separate strings for "knee"), so the exercise-library region
  filter in `search_exercises` silently missed related protocols.
- Adds `app.body_region` (9-value canonical list, see `DATA_MODEL.md`), backfills
  exercise/protocol onto it via FK, keeps the original free text as an optional
  `region_detail`/`region_detail_en` qualifier on protocol.
- Separates the exercise dataset's unrelated bodybuilding "muscle group" values (previously
  misusing the same `region` column) into their own `muscle_group` column — a different
  concept, not used for clinical region filtering.
- Migrations 0028-0030; `region=` query param on `GET /exercises` renamed to `region_id=`
  (see `API_CONTRACT.md`).

## M2 — Patient app (P0)
**T-10 Today / Home**
- Today's session, progress ring, exercise list with done state, start-first-incomplete CTA.
- Hit targets ≥ 44px; usable one-handed at 390px width.

**T-11 Exercise flow**
- Detail → active (set counter, rest timer) → per-exercise feedback (pain 0–10, difficulty, note)
  → next exercise → daily completion.
- Interrupting mid-session and returning restores exact position.

**T-12 Offline + sync**
- Airplane-mode run of a full session succeeds; queued items flush on reconnect within 30s.
- Replaying the same queue twice creates no duplicate `session_item`.
- Today's plan and current-phase media are cached by the service worker.

**T-13 Progress & education**
- Adherence series, pain trend, phase timeline, phase education content.
- Positive but not gamified: no streaks-as-pressure, no badges.

## M3 — Content & media
**T-14 Ingest `exercises-dataset-main`**
- Walk the local dataset folder; create/refresh `exercise` rows and `exercise_media`.
- Match each media file to its exercise via the dataset's own identifier; record
  `source_file` and `external_ref` for traceability.
- Report unmatched files and exercises without media rather than guessing.
- Media only becomes patient-visible once `verified_at` is set.

**T-15 Home program PDF**
- A print route renders the 2-page A4 document in `Home Program PDF.dc.html` from live plan
  data; the user exports via the browser print dialog (no server renderer in v1).
- Hebrew RTL renders correctly in print; page count and margins match the design at Letter/A4.
- Only verified media appears; otherwise the labeled placeholder frame.

## M4 — Signals (P1)
**T-16 Adherence engine**
- Implements RULES §1 exactly, including rest-day exclusion and partial-day counting.
- Unit tests cover: no planned days, all skipped, partial day, timezone boundary, DST.

**T-17 Alerts engine**
- All five alert types with dedupe keys per RULES §4; alerts computed server-side only.
- Marking reviewed removes it from the inbox and it does not re-fire within its dedupe window.

**T-18 Notifications**
- Web Push for the 6 events in `Notification Templates.dc.html`, with quiet hours, caps,
  deep links, and per-category opt-out.
- Weekly clinician email digest contains no patient names or clinical values.

**T-19 Messaging**
- Two-way thread, unread badge, push on new message, read receipts.

**T-20 Assessments & settings**
- Record measurements (pain / ROM / strength / functional test), overdue detection.
- Settings: adherence threshold, alert toggles, units, weekly digest.

## M5 — Hardening
**T-21 States & validation**
- Every screen has loading (skeleton), empty, error+retry, and offline states as designed.
- Every form: inline validation, disabled-until-valid submit, server-error surfacing.

**T-22 Accessibility & responsive**
- Keyboard reachable, visible focus rings, contrast ≥ 4.5:1 for body text.
- Clinician usable at 1024px; **tablet is view-only for v1** (editing surfaces hidden, not broken).
- Screen-reader labels in Hebrew.

**T-23 Privacy & compliance**
- Encryption at rest, consent capture, export and delete-my-data endpoints, retention job.
- Disclaimer at patient onboarding and on the printed program.

**T-24 Performance & release**
- Patient app: interactive < 2s on mid-tier Android over 4G; installable PWA.
- Error tracking, structured logs, backup + restore rehearsed once.

## Cross-cutting
**T-25 Hebrew copy layer**
- Every user-facing string comes from the i18n layer, keys per `COPY.md`. No inline JSX text.
- All loading / empty / error / offline / validation / confirm / toast keys implemented.

**T-26 QA scenarios**
- Scenarios in `QA_PLAN.md` executed per milestone; the **[auto]** ones exist as tests in CI.
- Demo seed produces the patient mix in `QA_PLAN.md` → "Seed data for testing".
