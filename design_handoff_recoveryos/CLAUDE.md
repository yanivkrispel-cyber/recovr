# CLAUDE.md — agent brief for RecoveryOS

You are implementing RecoveryOS from the design bundle in this folder. Read this file first,
then `RULES.md`. Everything below is decided — do not re-litigate it.

## What this is
A private clinic platform for managing sports-injury rehab. Two apps, one database:
- **Clinician** — desktop-first web app at `/app`
- **Patient** — mobile-first installable PWA at `/m`
Hebrew, RTL by default. Scope: P0 + P1 of `PRD.md`.

## Locked decisions
| Decision | Value |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Backend / DB | Supabase (Postgres 15, Auth, Storage, Edge Functions, pg_cron) |
| Hosting | Vercel (web) + Supabase (data) |
| Tenancy | **Schema per clinic** — see `ARCHITECTURE.md` §2 |
| Clinical logic | Postgres functions + Edge Functions. **Never in the client.** |
| PDF | Browser print of the home-program route (no server renderer in v1) |
| Auth screens | Not designed. Build minimal, token-styled — see §Auth below |
| Exercise media | Dev-only until licensing is resolved — see §Media |
| Working mode | Milestone by milestone; stop for review at each milestone boundary |

## Hard rules — violating these is a bug even if tests pass
1. **No automatic phase advancement, anywhere.** A phase changes only through the clinician
   approval endpoint, which writes an immutable `phase_transition`. `RULES.md` §2.
2. **Adherence is computed server-side only** — training days completed ÷ planned, rolling
   7 days. The client renders a number it received; it never calculates one. `RULES.md` §1.
3. **Alerts are computed server-side only.** `RULES.md` §4.
4. **Tenant isolation:** an id from another clinic returns **404**, never 403.
5. **Every clinician read of a patient record writes `audit_log`.** `RULES.md` §7.
6. **Soft delete only** on clinical rows (`deleted_at`). No hard deletes, ever.
7. **Measurements:** goniometric ROM and functional tests are separate measures, never
   interchangeable; AAOS is cited only for goniometric ROM; an untouched optional field
   never overwrites stored data; measurements are append-only (an edit supersedes).
   `RULES.md` §5b, full spec in `ROM_MEASUREMENT.md`.
8. **Log idempotency:** the server dedupes `session_item` on the client-generated id.
   Replaying an offline queue twice must not create duplicates.
9. **No patient names or clinical values in email bodies.** Links and counts only.
10. **RTL first.** No `left`/`right` in CSS — use `inline-start`/`inline-end` logical
    properties. Test every screen in Hebrew before calling it done.
11. **No design tokens inline.** Colors, type, spacing, radii come from the token layer
    generated in T-02 from `DESIGN_TOKENS.md`. An ad-hoc hex in a component is a review reject.

## Order of work
Follow `TASKS.md` top to bottom. Milestones: M0 foundations → M1 clinician core →
M2 patient app → M3 content & media → M4 signals → M5 hardening.

**At the end of each milestone: stop.** Post a summary (what shipped, what deviated, open
questions), and wait for review before starting the next milestone. Do not run ahead.

## Definition of Done (per task)
- Acceptance criteria in `TASKS.md` all pass, demonstrably.
- Typecheck, lint, unit tests, build all green.
- The screen matches `SCREENS.md` and the prototype at the documented breakpoints.
- Loading / empty / error / offline states exist and use the Hebrew copy from `COPY.md`.
- Keyboard reachable, visible focus ring, body-text contrast ≥ 4.5:1.
- Relevant scenarios in `QA_PLAN.md` pass.
- No new `any`, no commented-out code, no TODO without an owner and a task id.

## Auth (not designed — build minimal)
Supabase Auth, email + password, MFA-ready. Screens: clinician login, forgot password,
reset password, patient invite acceptance (token → set password → consent → done).
Style them from the token layer using existing primitives (Card, Input, Button, EmptyState).
Single centered card, logo, one column, no marketing copy. Patient invite must capture
consent (`consent_version`, `consent_at`) and show the disclaimer from `COPY.md`.

## Media
`exercises-dataset-main` media is © Gym visual; the repo's MIT license covers code only.
Therefore: ingest it (T-14) but treat every row as unverified. **`exercise_media` is only
served to a patient or into a PDF when `verified_at IS NOT NULL`**, and nothing is verified
until the license question is answered. Everywhere else, render the labeled placeholder frame
from the prototype. Do not ship dataset media to a real patient account.

## What not to touch
- `support.js`, `doc-page.js`, `browser-window.jsx`, `ios-frame.jsx` — runtime and device
  frames for the design files, not product code.
- The `.dc.html` files — they are the spec. Read them; don't port them.
- `RULES.md`, `DATA_MODEL.md`, `API_CONTRACT.md`, `ROM_MEASUREMENT.md` — if implementation
  forces a change, raise it in your milestone summary instead of editing silently.

## Asking vs deciding
Decide freely: file layout inside the documented structure, library choices for charts,
forms, dates, test tooling, naming.
Ask (stop and surface it): anything that changes a rule in `RULES.md`, the data model,
tenancy, consent/audit behavior, the definition of adherence, or any measurement rule in
`ROM_MEASUREMENT.md`.
