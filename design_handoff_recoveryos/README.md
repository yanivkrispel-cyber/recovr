# Handoff: RecoveryOS — Sports Injury Rehab Platform (v1)

## Overview
RecoveryOS turns a professional rehab protocol into a personal, daily, measurable plan.
Two interfaces, one data model:
- **Clinician** (desktop-first web): manage patients, plans, progression, alerts.
- **Patient** (mobile-first PWA): do today's session, log pain/difficulty, see progress.

Language: **Hebrew, RTL by default**. Clinical terms may appear in English in parentheses.
Scope for v1: **P0 + P1** of the PRD. Platform for v1: **Web + PWA** (no native app).

## About the design files
The HTML files in this bundle are **design references** — prototypes showing intended look
and behavior. They are not production code to copy. Recreate them in the target codebase's
environment using its established patterns; if no environment exists, choose a stack
(recommended: React + TypeScript + Vite, server of your choice) and implement there.

The design is authored as "Design Components" (`*.dc.html`): a template plus a logic class.
Read them as annotated specs — markup shows structure and exact styling; the class shows
state and behavior.

## Fidelity
**High fidelity.** Colors, typography, spacing and copy in the prototype are final for v1.
Recreate pixel-accurately. Exact values in `DESIGN_TOKENS.md`.

## Where to start
0. `CLAUDE.md` — agent brief: locked stack decisions, hard rules, Definition of Done,
   working mode. Read before anything else.
1. `RULES.md` — the business rules that define the product (adherence, progression,
   alerts, notifications). Read this first; most bugs come from getting these wrong.
2. `DATA_MODEL.md` — tables, fields, relationships.
3. `API_CONTRACT.md` — endpoints, payloads, errors.
4. `TASKS.md` — sequenced work with acceptance criteria.
5. `SCREENS.md` — screen-by-screen spec mapped to the prototype files.
6. `DESIGN_TOKENS.md` — colors, type, spacing, radii, shadows, states.
7. `ARCHITECTURE.md` — stack, schema-per-clinic tenancy, where logic lives, repo layout.
8. `COPY.md` — Hebrew copy for every loading / empty / error / validation / confirm state.
9. `ROM_MEASUREMENT.md` — the range-of-motion & functional-test module (WBLT, Thomas,
   Schober, heel-to-buttock, deep squat): catalog fields, panel anatomy, flag rules,
   schema and endpoints. Read it before touching assessments.
10. `QA_PLAN.md` — acceptance scenarios per milestone.
11. `.env.example` — environment variables and dev seed accounts.

## Files in this bundle
| File | What it is |
|---|---|
| `Rehab Platform Prototype.dc.html` | Full interactive prototype — both sides, all v1 screens and states, incl. the ROM & functional-measurement module |
| `Home Program PDF.dc.html` | Printable 2-page A4 home program (PDF export) |
| `Notification Templates.dc.html` | 6 notification events: trigger, timing, variables, copy, rules |
| `Design System Sheet.dc.html` | Colors, type, components |
| `protocols-data.js` | Seed protocol library (protocols → phases → exercises + criteria) |
| `support.js`, `doc-page.js`, `browser-window.jsx`, `ios-frame.jsx` | Runtime and device frames for the design files (not product code) |
| `PRD.md` | Original product requirements (Hebrew) |

## Assets
- Fonts: **Heebo** (UI, Hebrew+Latin), **Frank Ruhl Libre** (display/headings),
  **Archivo** (Latin UI fallback), **Cormorant Garamond italic** (small English subtitles).
  All Google Fonts — self-host in production.
- **Exercise media is not in this bundle.** The user maintains a local library
  (`exercises-dataset-main`) of exercise images and GIFs. A dedicated task
  (`TASKS.md` → T-14) covers ingesting that folder and mapping each file to an
  exercise row. Until then the designs use labeled placeholder frames.
- Icons: inline SVG, 1.6px stroke, currentColor. No icon font.

## Out of scope for v1
Billing, EMR integration, appointment scheduling, video calls, marketing email,
SMS/WhatsApp channels, advanced analytics, gamification/streak notifications.
