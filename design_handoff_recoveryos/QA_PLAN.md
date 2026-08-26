# QA_PLAN.md

Scenario-based acceptance. Each scenario is a manual walkthrough that must pass before its
milestone is reviewed; the ones marked **[auto]** must also exist as automated tests.

## Critical paths
**Q-01 Offline session (M2)** — Load `/m` online, go airplane mode, complete a full session
with pain + difficulty per exercise, close the app, reopen still offline, reconnect.
Expect: session runs fully offline, position restored on reopen, queue flushes within 30s,
exactly one `session_item` per exercise. **[auto]** replay the same queue twice → no duplicates.

**Q-02 Phase approval (M1)** — Patient with all criteria met. Expect `ready_for_advance` alert,
Approve unlocked, approval writes one immutable `phase_transition` with a criteria snapshot.
Then: approve with a criterion unmet → reason required, stored on the row.
**[auto]** no code path advances a phase without an approval record.

**Q-03 Plan version conflict (M1)** — Two clinician tabs open the same plan; both edit; both save.
Expect: first save wins, second gets 409 with a recoverable conflict dialog, draft not lost.
Logged work from today survives the edit.

**Q-04 Adherence correctness (M4) [auto]** — Cases: no planned days (no divide-by-zero, shows
"—"), all days skipped (0%), partial day counts as completed, rest days excluded from both
sides, timezone boundary at 23:59 patient-local, DST transition week, patient who started
mid-week. Rounding is half-up.

**Q-05 Tenant isolation (M0) [auto]** — Authenticated as clinic A, request every entity type by
a clinic-B id. Expect 404 on all, no row leakage in errors or logs, and no cross-schema query
possible without the API layer.

**Q-06 Audit trail (M0) [auto]** — Open a patient record → one `audit_log` row with actor,
action, entity, ip, ua. Export and delete-my-data endpoints produce complete output.

**Q-07 Alert dedupe (M4) [auto]** — Each of the five alert types: fire condition twice inside its
dedupe window → one alert. Mark reviewed → leaves inbox, does not re-fire in-window.
Condition resolves → `auto_closed`.

**Q-08 Notifications (M4)** — Generate each of the 6 events. Inside quiet hours (21:30–07:30
patient-local) → deferred to 07:30, except clinician `pain_spike` which sends immediately.
Patient cap of 2/day holds. Every push deep-links to the right route. Category opt-out works;
clinician `pain_spike` cannot be disabled. Weekly digest email contains no names or values.

**Q-09 Home program print (M3)** — Print the program for a patient with 8 exercises and long
Hebrew notes. Expect: 2 A4 pages, RTL correct, margins match the design, no clipped text,
unverified media replaced by the placeholder frame.

**Q-10 Media verification gate (M3) [auto]** — `exercise_media` with `verified_at = null` never
appears in a patient response or a PDF.

**Q-05b Measurement module (M1)** — Ankle, a patient with a recorded WBLT.
Record goniometric dorsiflexion (3 attempts, governing value) and WBLT (keypad, cm) as two
separate rows. Set WBLT to 7 cm against a 10.5 cm healthy side: value and side gap red.
Set 9.5 cm: both green. Save a new value **without** touching the tibial-angle field — the
stored angle survives and still shows in the reference panel. **[auto]**
Deep squat: no side switch, compensations persist into the row summary. Modified Schober:
no side switch, no healthy-side value. Thomas: gauge, 0–30°, `נורמה (Thomas)`.
Grep the rendered assessments screen for "AAOS" — it must not appear on any functional test.

## Cross-cutting sweeps (M5)
**Q-11 States sweep** — every screen in `SCREENS.md`: loading skeleton, empty, error + retry,
offline. Copy matches `COPY.md`.
**Q-12 Forms sweep** — inline validation, submit disabled until valid, server error surfaced
in-form, no silent failure.
**Q-13 RTL + responsive** — clinician at 1024/1280/1440; tablet is view-only (edit surfaces
hidden, nothing broken); patient at 360/390/430. No horizontal scroll, no LTR leakage.
**Q-14 Accessibility** — keyboard-only pass of the two critical paths (Q-01, Q-02), visible
focus, Hebrew screen-reader labels, contrast ≥ 4.5:1.
**Q-15 Performance** — dashboard < 1.5s with 200 patients; patient app interactive < 2s on
mid-tier Android over 4G; PWA installs.

## Seed data for testing
The demo clinic must include: a patient with 95% adherence, one at 40% (alert), one inactive
6 days, one ready to advance, one with a pain spike, one `invited` and never activated, and
one discharged. Plus one patient with an empty plan and one mid-phase with no measurements —
the empty and no-data states need a real subject.
