# Screenshots — RecoveryOS prototype (visual source of truth)

Captured from `Rehab Platform Prototype.dc.html` at 50% page zoom (full 1480px desktop chrome / iOS frame visible in each shot).
Patient in all clinician shots: **מאיה שלו (maya)** — achilles tendinopathy → ankle ROM catalog, phase 4, day 74.

If implemented UI diverges from these images, **the images win**. Match colors, type, spacing, radii, borders and RTL layout exactly.

## Clinician web app (desktop, 1480px)
| # | File | State |
|---|---|---|
| 01 | 01-clinician-dashboard.png | `cView: dashboard` — clinic overview, alert cards, patient rows |
| 02 | 02-clinician-patients-list.png | `cView: patients` — full list + filter chips (all/attention/active/inactive) |
| 03 | 03-patient-overview-tab.png | `cView: overview`, `cOverviewTab: overview` |
| 04 | 04-patient-plan-tab.png | `cOverviewTab: plan` — phase plan, exercises, criteria |
| 05 | 05-patient-progress-tab.png | `cOverviewTab: progress` — adherence, pain, ROM trends |
| 06 | 06-assessments-tab-rom-table.png | `cOverviewTab: assessments` — **ROM table**: motion rows, affected vs contralateral, symmetry, norm/target, trend sparkline. Ankle catalog incl. WBLT row |
| 07 | 07-patient-history-tab.png | `cOverviewTab: history` |
| 08 | 08-rom-panel-wblt-cm.png | **ROM entry panel — WBLT** (`ank_wblt`): horizontal bar gauge 0–15 cm, norm 11 cm marker, side-diff/`<9cm` red flagging, optional degrees field, ⓘ protocol tooltip, large numeric keypad |
| 09 | 09-rom-panel-ankle-dorsiflexion-goniometer.png | **ROM entry panel — goniometric** (`ank_df`): degrees, 3 attempts, governing value, pain/end-feel/swelling, AAOS norm reference |
| 10 | 10-edit-plan-modal-exercises.png | `editPlanOpen: true`, `editPlanTab: exercises` — phase editor modal |
| 11 | 11-protocol-library.png | `cView: protocolLibrary` |
| 12 | 12-exercise-library.png | `cView: exerciseLibrary` |
| 13 | 13-assessments-queue.png | `cView: assessments` — pending/overdue/recorded queue |
| 14 | 14-clinic-settings.png | `cView: settings` |

## Patient mobile app (iOS frame)
| # | File | State |
|---|---|---|
| 15 | 15-patient-app-home.png | `pView: home` — today's program, banner, progress ring |
| 16 | 16-patient-app-exercise.png | `pView: exercise`, `pExerciseSubState: detail` — set tracker, rest timer |
| 17 | 17-patient-app-completion.png | `pView: completion` — session summary + feedback (pain / difficulty / note) |
| 18 | 18-patient-app-progress.png | `pView: progress` |
| 19 | 19-patient-app-education.png | `pView: education` |
| 20 | 20-patient-app-notifications.png | `pView: notifications` |
| 21 | 21-patient-app-messages.png | `pView: messages` — clinician chat |

## Notes for implementation
- All copy is **Hebrew-first RTL** with an English secondary line (`Hebrew · English`). Keep both.
- ROM: two distinct panel layouts — goniometric (degrees, AAOS reference) vs functional (cm/pass-fail, protocol tooltip, no AAOS attribution). See 08 vs 09.
- Functional tests present in the catalog: `ank_wblt` (cm), `knee_h2b` (cm), `knee_squat` (pass/fail + compensations), `hip_thomas` (deg, deficit), `lum_schober` (cm, unilateral).
- Spec details in `ROM_MEASUREMENT.md`.
