# DATA_MODEL.md

Relational (Postgres assumed). `id` = UUIDv7. All tables carry `created_at`, `updated_at`.
Clinical rows are **soft-deleted** (`deleted_at`) — never hard delete.

## Identity & tenancy
- **clinic** — id, name, timezone, locale (default `he-IL`), retention_years, settings jsonb
- **user** — id, clinic_id, role (`clinician` | `admin`), name, email (unique), phone,
  password_hash, mfa_secret, last_login_at, status
- **patient** — id, clinic_id, primary_clinician_id → user, name, name_en, birth_date, sex,
  phone, email, sport, position, status (`invited` | `active` | `paused` | `discharged`),
  consent_version, consent_at, locale, timezone, activated_at, discharged_at
- **patient_auth** — id, patient_id, invite_token, invite_expires_at, password_hash, status
- **device_token** — id, owner_type (`user`|`patient`), owner_id, endpoint, keys jsonb, platform, last_seen_at

## Body region taxonomy (T-28)
- **body_region** — id, slug (unique), name, name_en, sort_order. Global reference data
  (no clinic_id), 9 canonical clinical regions (shoulder, elbow, wrist_hand, spine, hip_thigh,
  knee, lower_leg, ankle_foot, other). Replaces what used to be free-text `region`/`region_en`
  directly on `protocol` and `exercise` — those were unconstrained text with no shared
  vocabulary (27 protocols had 20 distinct region strings for ~9 clinical regions), so a
  region filter on the exercise library could silently miss related protocols. See
  migrations 0028-0030.

## Protocol library (clinic-scoped, seedable)
- **protocol** — id, clinic_id (null = system), slug, name, name_en, body_region_id → body_region,
  region_detail, region_detail_en (optional free-text qualifier, e.g. "Medial", "Tibial
  Tuberosity" — kept verbatim from the old region/region_en text, no longer the only region
  signal), source (`system`|`clinic`), version, is_active
- **protocol_phase** — id, protocol_id, n, name, name_en, duration_days, goals jsonb
  (`[{he,en}]`), order
- **protocol_phase_exercise** — id, protocol_phase_id, exercise_id, prescription
  (sets, reps, load, tempo, hold_sec, side), frequency, order, notes
- **protocol_phase_criterion** — id, protocol_phase_id, type (`time`|`pain`|`rom`|`strength`|
  `assessment`|`manual`), label, label_en, operator (`gte`|`lte`|`eq`), value, unit, order

## Exercise library
- **exercise** — id, clinic_id (null = system), name, name_en, category
  (`Mobility`|`Strength`|`Balance`|`Control`|`Cardio`), body_region_id → body_region (nullable;
  set directly only for clinic-custom exercises — a system/dataset exercise's clinical region
  comes from the protocols it's used in, see search_exercises), muscle_group (raw
  `exercises-dataset-main` body_part value — a bodybuilding muscle-group taxonomy, a different
  concept from body_region, not used for clinical filtering), muscles text[], equipment text[],
  description, instructions, common_mistakes, safety_notes, default_prescription jsonb,
  is_bilateral, source, external_ref (key from `exercises-dataset-main`), is_active.
  Catalog governance (T-30): status (`draft`|`in_review`|`approved`|`archived`; only `approved`
  is offered by the picker — existing protocol/plan references are never affected),
  reviewed_by, reviewed_at, aliases text[] (search), key_cues text[], start_position
  (`standing`|`sitting`|`supine`|`prone`|`side_lying`|`quadruped`|`kneeling`|`other`),
  difficulty 1–3, contraindications, revision (optimistic concurrency), curated_at (set on
  master-catalog edits; dataset re-ingest never overwrites a curated or revised row).
- **catalog_curator** (T-30) — user_id PK, granted_at, note. Platform-level grant (not a clinic
  role): curators edit system (master) exercises directly, for every clinic.
- **exercise_override** (T-30) — clinic_id, exercise_id, fields jsonb, revision, updated_by,
  updated_at; PK (clinic_id, exercise_id). A clinic's own version of a system exercise's
  patient-facing content (description, instructions, key_cues, common_mistakes, safety_notes,
  contraindications); keys equal to the master value are dropped. Merged by
  `app.exercise_effective(clinic_id)` — the clinician editor, picker detail and the patient
  app all read through it.
- **exercise_revision** (T-30) — id, exercise_id, clinic_id (null = master change), scope
  (`master`|`clinic`|`override`), action (`create`|`update`|`status`|`revert`|`restore`|
  `duplicate`), changes jsonb `{field: {from, to}}`, changed_by, changed_at. Append-only;
  restore writes a new revision. Master changes by another clinic's curator show as
  "catalog team", never by name.
- **exercise_media** — id, exercise_id, kind (`image`|`gif`|`video`), url, thumb_url, width,
  height, duration_ms, order, source_file (original filename from the dataset), verified_by,
  verified_at.
  Media manager (T-31): kind adds `clip` (uploaded MP4/WebM; `video` stays a YouTube id),
  clinic_id (null = master media managed by catalog curators; set = one clinic's private media,
  shown before master media to that clinic and its patients only — every read goes through
  `app.exercise_media_visible(clinic_id)`), rights (`unknown`|`own`|`licensed`|`open`|`embed`),
  attribution, start_sec / end_sec (trim window), mime_type, size_bytes, uploaded_by,
  review_note. `order` 0 is the primary visual. New verification requires rights ≠ `unknown`;
  one YouTube video per exercise per scope. Uploads live under `uploads/master/<exercise>/` or
  `uploads/clinic/<clinic>/<exercise>/` in the private `exercise-media` bucket.
  > `verified_by` matters: media must be confirmed as depicting the exercise before it can
  > appear in a patient-facing document (see RULES §7 and TASKS T-14).
- **exercise_favorite** (T-29) — user_id, exercise_id, clinic_id, created_at; PK (user_id, exercise_id)
- **exercise_pick_event** (T-29) — id, clinic_id, user_id, picker_session_id, entry
  (`protocol`|`plan`), protocol_id, body_region_id, phase_n, exercise_id, event
  (`shown`|`added`), source (`recommended`|`search`|`favorite`|`recent`), rank, score, created_at.
  Picker log: feeds "recent" and the clinic-history recommendation signal. No patient ids —
  learning stays within the clinic and never reads patient records.

## Patient plan
- **plan** — id, patient_id, protocol_id, started_at, current_phase_n, status
- **plan_version** — id, plan_id, version, created_by, created_at, note, is_current
- **plan_phase** — id, plan_version_id, n, name, duration_days, started_at, completed_at
- **plan_exercise** — id, plan_phase_id, exercise_id, sets, reps, load, load_unit, tempo,
  hold_sec, rest_sec, side, frequency (`3x/week` normalized: days_per_week int + schedule jsonb),
  order, clinician_note, removed_reason, source (`protocol`|`added`|`modified`)
- **plan_criterion** — id, plan_phase_id, type, label, operator, value, unit, order, is_met (cached),
  met_at
- **plan_template** — id, clinic_id, created_by, name, payload jsonb (a phase's exercise set)

## Activity & measurement
- **session** — id, patient_id, plan_version_id, date (patient-local), status
  (`planned`|`partial`|`completed`|`skipped`), skipped_reason, completed_at,
  items_planned, items_done, completion_ratio, max_pain, avg_difficulty, note
- **session_item** — id (client-generated), session_id, plan_exercise_id, sets_done, reps_done,
  load_used, pain_score (0–10), difficulty (`easy`|`medium`|`hard`), skipped, skip_reason,
  note, logged_at, synced_at
- **measurement** — id, patient_id, type (`pain`|`rom`|`strength`|`girth`|`functional_test`),
  key, value numeric, unit, side, measured_at, measured_by (`clinician`|`patient`), source_note
- **adherence_daily** — patient_id, date, planned bool, completed bool, completion_ratio
  (materialized; drives the 7-day window in RULES §1)
- **phase_transition** — id, plan_id, from_phase_n, to_phase_n, direction, approved_by,
  approved_at, criteria_snapshot jsonb, override_reason  *(immutable)*

### Range of motion & functional tests
Full field-by-field spec in `ROM_MEASUREMENT.md` §5.
- **measure_definition** — id, clinic_id (null = system), code (`ank_wblt`), joint, name_he,
  name_en, unit (`deg`|`cm`|`pass_fail`), norm, target, scale, flags jsonb (`deficit`,
  `lower`, `fx`, `bilat`, `side_diff`, `risk_below`, `deg_opt`), norm_source, protocol_tip
- **measurement** — id, patient_id, measure_code, side (`involved`|`healthy`|`bilateral`),
  value, value_secondary (optional degrees, e.g. WBLT tibial angle), pass, compensations
  text[], attempts numeric[], governing_source (`best`|`avg`|`attempt_n`|`single`), pain,
  end_feel (`soft`|`hard`), swelling, note, visit_id, measured_by, measured_at,
  superseded_by  *(append-only; an edit supersedes, never mutates)*
- **assessment_visit** — id, patient_id, clinician_id, started_at, saved_at, note

  > A functional test is always its own `measure_definition` row — never an input mode of a
  > goniometric one. `ank_df` and `ank_wblt` are distinct measures and must stay distinct.

## Communication
- **alert** — id, patient_id, clinic_id, type, severity, payload jsonb, state
  (`open`|`reviewed`|`auto_closed`), reviewed_by, reviewed_at, dedupe_key, created_at
- **notification** — id, recipient_type, recipient_id, event_key, channel (`push`|`email`|`in_app`),
  payload jsonb, scheduled_for, sent_at, opened_at, status, dedupe_key
- **message** — id, patient_id, sender_type (`clinician`|`patient`), sender_id, body,
  sent_at, read_at
- **audit_log** — id, actor_type, actor_id, action, entity_type, entity_id, ip, user_agent, at

## Key indexes
`measurement(patient_id, measure_code, measured_at desc)` · `measurement(visit_id)`
`session(patient_id, date)` · `session_item(session_id)` · `adherence_daily(patient_id, date)`
· `alert(clinic_id, state, created_at)` · `notification(dedupe_key)` unique where status='pending'
· `plan_version(plan_id, is_current)` partial unique.
