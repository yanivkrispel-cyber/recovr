# SCREENS.md

Every screen below exists in `Rehab Platform Prototype.dc.html`. Open it and switch with the
header controls: **מטפל / מטופל** toggle, the state chips (normal / loading / error / offline /
empty), the viewport chips (1440 / 1024), and the patient selector.

Prototype state keys are given so you can find each screen in the logic class.

## Clinician (desktop-first, 1440 design width, must work at 1024)
| # | Screen | Prototype key | Purpose |
|---|---|---|---|
| 1 | Dashboard | `cView:'dashboard'` | 10-second status: KPIs, attention list, alert inbox |
| 2 | Patient list | `cView:'patients'` | Search, filter, open a patient |
| 3 | Patient overview | `cView:'overview'`, tab `overview` | Summary, alerts, goals, criteria, today, timeline |
| 4 | Assessments tab | `cOverviewTab:'assessments'` | Measurements, record new, overdue |
| 4a | ROM & functional tests card | `cOverviewTab:'assessments'`, joint switcher `romJointSel` | Per-joint measurement table: value, healthy side, side comparison, norm/target, progress. Spec: `ROM_MEASUREMENT.md` |
| 4b | Measurement panel | `romOpen`, `romMotionId` | Record/edit one measurement — gauge (degrees), ruler (cm) or pass/fail, attempts or keypad, pain/end-feel/swelling, reference, history |
| 4c | Assessment visit mode | `romVisitActive`, `romVisitDone` | Group several measurements into one clinical visit |
| 5 | History tab | `cOverviewTab:'history'` | Session history, plan changes, phase transitions |
| 6 | Plan | inside overview | Phase timeline, current phase, exercise table |
| 7 | Edit plan | `editPlanOpen` | Draft editor: phases, exercises, criteria, templates |
| 8 | Add exercise | `addExerciseOpen` | Filtered library search, multi-select |
| 9 | Exercise detail | `exerciseDetailOpen` | Instructions, cues, mistakes, usage count |
| 10 | Progression criteria | `progressionOpen` | Criteria state + approve/regress with reason |
| 11 | Protocol library | `cView:'protocolLibrary'` | Browse protocols, phases, criteria |
| 12 | Exercise library | `cView:'exerciseLibrary'` | Browse and search exercises, create custom (`nxOpen`) |
| 13 | New patient | `addPatientOpen` | 2-step: details → protocol + phase + exclusions |
| 14 | Settings | `cView:'settings'` | Alert toggles, adherence threshold, units, digest |
| 15 | Notifications | `notificationsOpen` | Alert inbox panel |

## Patient (mobile-first, 390px design width, PWA)
| # | Screen | Prototype key | Purpose |
|---|---|---|---|
| 16 | Home / today | `pView:'home'` | What to do today, progress, start CTA |
| 17 | Exercise detail | `pView:'exercise'`, `pExerciseSubState:'detail'` | Instructions before starting |
| 18 | Active exercise | `pExerciseSubState:'active'` | Set counter, rest timer |
| 19 | Exercise feedback | `pExerciseSubState:'feedback'` | Pain 0–10, difficulty, note |
| 20 | Daily completion | `pView:'completion'` | Day summary, what's next |
| 21 | Progress | `pView:'progress'` | Adherence, pain trend, phase timeline |
| 22 | Education | `pView:'education'` | Phase-specific guidance |
| 23 | Messages | messages thread | Two-way with clinician |
| 24 | Notifications | `pView:'notifications'` | Patient notification list |
| 25 | Skip / rest day | `skipOpen` | Skip with reason |

## Cross-cutting states (implement for every screen)
Loading (skeleton + shimmer) · Error + retry · Offline banner · Empty (no patients / no plan /
no exercises today) · Saving/dirty (unsaved-changes bar in the plan editor) · Toast confirmations.

## Not yet designed — design before building
Login, forgot/reset password, patient invite acceptance, onboarding + consent, account settings.
These are required for v1 but were explicitly out of scope for the design prototype. Ask the
designer for them, or build them from the tokens in `DESIGN_TOKENS.md` and keep them plain.
