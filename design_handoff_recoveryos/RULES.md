# RULES.md — business rules

These are decisions, not suggestions. Implement exactly; expose the tunables noted.

## 1. Adherence
**Definition (v1, confirmed):** adherence = *training days completed* ÷ *training days planned*,
measured over a rolling **7-day window**.

- A day counts as **completed** if the patient marked at least one exercise done that day
  AND the day was a planned training day. (Partial day = completed day.)
- A day the plan does not schedule (rest day) is excluded from both numerator and denominator.
- Displayed as an integer percent, rounded half-up.
- Also store per-day `completion_ratio` (items done / items planned) for the clinician's
  detail views — but never use it for the headline adherence number.
- Recompute nightly per patient (job at 02:00 patient-local) and on every session write.

**Threshold:** default **70%**. Per-clinician setting, range 50–95, step 5.
Below threshold → `adherence_drop` alert (see §4).

## 2. Phase progression
**Gate: clinician approval, always.** Even when every criterion is met, the system never
advances a phase automatically.

- Criteria types: `time` (days in phase), `pain`, `rom`, `strength`, `assessment`, `manual`.
- Each criterion evaluates to met / not met / no data, from the latest measurement of that type.
- When **all** criteria are met → patient becomes `ready_for_advance`, clinician gets the
  `ready_for_advance` alert, and the Approve action unlocks in Patient Overview.
- Approving writes a `phase_transition` row (from_phase, to_phase, approved_by, approved_at,
  criteria snapshot as JSON) — this is a clinical audit record and is immutable.
- A clinician may advance **without** all criteria met; the UI requires a free-text reason,
  stored on the transition row.
- Regression (moving back a phase) uses the same mechanism with `direction: 'back'`.

## 3. Plan editing
- Plans are **versioned**. Saving an edit creates a new `plan_version`; the previous version
  stays readable for history and for sessions already logged against it.
- Edits are transactional: the editor holds a draft; Save commits all changes, Discard drops them.
- Removing an exercise requires a reason (enum + optional note) — it appears in patient history.
- Changing a plan for *today* does not invalidate work the patient already logged today.
- Reordering exercises only is a **silent** change (no patient notification).

## 4. Alerts (clinician, in-app + push)
| Alert | Condition | Dedupe |
|---|---|---|
| `adherence_drop` | 7-day adherence < threshold | 1 per patient / 7 days, until marked reviewed |
| `pain_spike` | reported pain ≥ 6/10, or +3 over the patient's 14-day mean | immediate, max 1 / patient / 24h |
| `ready_for_advance` | all phase criteria met | once per phase |
| `inactive` | no session for 4+ consecutive planned days | 1 per patient / 7 days |
| `assessment_overdue` | scheduled measurement > 7 days late | 1 per patient / 7 days |

Alerts have states: `open` → `reviewed` (clinician acted) → `auto_closed` (condition resolved).
Alerts are computed server-side; the client never derives them.

## 5. Notifications
Full copy, variables and timing per event in `Notification Templates.dc.html`. Global rules:
- **Quiet hours 21:30–07:30** patient-local. Notifications generated inside the window are
  deferred to 07:30, except `pain_spike` (clinician, urgent) which always sends.
- **Caps:** patient max 2 push/day; clinician adherence alerts are batched into one digest.
- **Channels v1:** Push (Web Push) + in-app. Email only for the optional clinician weekly digest.
  No SMS/WhatsApp.
- **No patient names or clinical data in email bodies** — numbers and a link into the app only.
- Every notification carries a deep link (`/today`, `/plan?diff=last`, `/patients/:id`).
- Users can disable each category; `pain_spike` to the clinician is not disableable.

## 5b. Measurement (ROM & functional tests)
Full spec: `ROM_MEASUREMENT.md`. The rules that must not be reinterpreted:
- **Goniometric and functional measures are never interchangeable.** A functional test is
  its own measure row with its own norm source; it never replaces or overwrites a
  goniometric one (`ank_df` ≠ `ank_wblt`).
- **Norm attribution is per measure.** AAOS is cited only for goniometric ROM. Functional
  tests cite their own literature by name (`נורמה (WBLT)`, `נורמה (Thomas)`, `נורמה (Schober)`).
- **Goniometric = 3 attempts** with a clinician-chosen governing value (best by default).
  **Functional = a single measurement.** Do not add attempt series to functional tests.
- **Optional fields never destroy data.** An untouched optional field (WBLT tibial angle,
  squat compensations) leaves the stored value intact; the panel prefills from storage so
  what is displayed is what is saved.
- **Flags are colour-only** (green `#3F6B4A` / red `#9E3B2E`), no banners. A cm measure
  flags on `|value| < risk_below`, on side gap `≥ side_diff`, or on `lower && |value| > target`.
- **Bilateral measures** (`bilat: false` — deep squat, Modified Schober) record no side and
  produce no side-comparison flag.
- Measurements are **append-only**; an edit supersedes the previous row so any phase-criteria
  snapshot stays reproducible.
- Functional tests are **auto-included** in their joint's list; no per-clinic opt-in in v1.
- Patients never self-record measurements in v1 — clinician-only.

## 6. Offline (patient PWA)
- The patient app must open and run **today's session** with no network.
- Cache: today's plan + exercise media for the current phase (service worker, cache-first for
  media, stale-while-revalidate for plan JSON).
- Session logging writes to a local queue (IndexedDB) with a client-generated `session_item_id`
  (UUIDv7) and `logged_at`; the queue flushes on reconnect.
- **Conflict rule:** server is authoritative for plan content, client is authoritative for
  logs. A log for an exercise that no longer exists in the current plan version is still
  accepted and attributed to the version it was logged against.
- Idempotency: server dedupes on `session_item_id`.

## 7. Privacy & audit (must not be deferred)
- All patient clinical data encrypted at rest; TLS in transit.
- Every read of a patient record by a clinician writes an `audit_log` row.
- Patient consent recorded at activation (version + timestamp); export and delete-my-data
  endpoints exist from v1.
- Data retention configurable per clinic; default 7 years for clinical records.
- The app is a documentation and adherence tool — it does not diagnose. A disclaimer appears
  at patient onboarding and on the printed home program.
