# API_CONTRACT.md

REST/JSON. Base `/api/v1`. Auth: short-lived access JWT + rotating refresh cookie.
Roles: `clinician`, `admin`, `patient`. Every endpoint is clinic-scoped server-side —
never trust a clinic_id from the client.

Conventions: `snake_case` fields · ISO-8601 UTC timestamps · dates as `YYYY-MM-DD` in the
patient's timezone · cursor pagination (`?cursor=&limit=`) · `Idempotency-Key` honored on all POSTs.

## Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{email, password}` → `{access_token, expires_in}` + refresh cookie |
| POST | `/auth/refresh` | rotates refresh token |
| POST | `/auth/logout` | revokes |
| POST | `/auth/forgot` / `/auth/reset` | email link, single-use, 30 min |
| POST | `/patients/invite/:token/accept` | `{password}` → activates patient, records consent |

## Clinician
| Method | Path | Returns |
|---|---|---|
| GET | `/dashboard` | `{kpis:{active_patients,avg_adherence,attention_count,ready_count}, patients:[PatientRow], alerts:[Alert]}` |
| GET | `/patients?filter=all\|attention\|ready\|inactive\|discharged&q=&cursor=` | `[PatientRow]` |
| POST | `/patients` | create + assign protocol + optional exercise exclusions → sends invite |
| GET | `/patients/:id` | full overview: patient, plan summary, criteria, alerts, today, recent activity |
| PATCH | `/patients/:id` | demographics, primary clinician — not yet implemented |
| POST | `/patients/:id/discharge` | archive: `status='discharged'`. Non-destructive — data untouched, patient drops out of `filter=all` until reactivated. Idempotent. |
| POST | `/patients/:id/reactivate` | undo a discharge: `status='active'` |
| GET | `/patients/:id/plan?version=N` | current or specific `plan_version` |
| POST | `/patients/:id/plan/versions` | `{changes:[...], note}` → creates a new version atomically |
| POST | `/patients/:id/phase-transitions` | `{to_phase_n, override_reason?}` → approve/regress |
| GET | `/patients/:id/sessions?from=&to=` | session history + items |
| GET | `/patients/:id/adherence?window=7\|30` | `{pct, days_done, days_planned, series:[{date,completed}]}` |
| POST | `/patients/:id/measurements` | `{type,key,value,unit,side,measured_at}` |
| GET/POST | `/patients/:id/messages` | thread |
| GET | `/patients/:id/home-program.pdf` | server-rendered PDF of the printed program |
| GET | `/alerts?state=open` · POST `/alerts/:id/review` | alert inbox |
| GET | `/protocols` · `/protocols/:slug` | library + phases + criteria |
| POST | `/protocols/:id/exercises` | attach an approved exercise to a phase `{exercise_id, phase_n}` → `{ok, protocol_id, copied, scope, already_attached?}`. System protocol: curators change it for all clinics; others get a clinic copy (T-32) |
| GET | `/exercises?q=&category=&region_id=&protocol=&phase=&equipment=&favorites=1&media=1&limit=&offset=` | library search (used by the exercise picker) → `{items:[Exercise], total}`. `region_id` is a `body_region` id (T-28), not free text. `limit` defaults to 60, capped at 200. Items carry picker card fields (T-29): `equipment`, `is_favorite`, `thumb_url`/`gif_url` (signed, API-origin-relative), `media_verified`. |
| GET | `/exercises/recommend?protocol_id=&region_id=&phase=&anchor_ids=&exclude_ids=&limit=` | picker recommendations (T-29) → `{context:{protocol_id, body_region, phase_n, region_protocol_total, anchor_categories}, items:[Exercise + score, rank, reasons[], prescription, frequency]}`. Region falls back to the protocol's. Signals: protocol library + this clinic's picker history only. |
| GET | `/exercises/recent` | exercises this clinician added through the picker, newest first (T-29) |
| PUT/DELETE | `/exercises/:id/favorite` | star / unstar for the current clinician (T-29) |
| POST | `/exercises/picker-events` | best-effort picker log `{picker_session_id, entry, protocol_id?, body_region_id?, phase_n?, events:[{exercise_id, event: shown\|added, source?, rank?, score?}]}` (T-29) |
| POST | `/exercises` | clinic-custom exercise (legacy form; the library workspace uses `POST /exercises/catalog`) |
| GET | `/exercises/catalog?q=&body_region_id=&category=&status=&equipment=&start_position=&source=&media=&missing=&protocol=&sort=&limit=&offset=` | library workspace search (T-30) → `{items:[CatalogItem], total, facets:{body_region, category, status, equipment, start_position, source, media, missing}, viewer:{is_curator}}`. Typo-tolerant Hebrew/English/alias search; a facet's counts apply every *other* active filter; archived excluded unless `status=archived`. `source` = `system`\|`clinic`\|`override`; `missing` = a completeness key; `sort` = `relevance`\|`name`\|`updated`\|`completeness`. |
| GET | `/exercises/catalog/:id` | editor payload: effective fields, status, revision/override_revision, overridden_fields, master content values, completeness + missing, permissions, usage (protocols, active plan count), media (T-30) |
| POST | `/exercises/catalog` | create `{patch, scope?: clinic\|master}` — `master` for curators only; starts as `draft` (T-30) |
| PATCH | `/exercises/:id` | save `{patch, expected_revision?}` → `{revision, override_revision?, completeness, missing, changed}`. Target follows the row and caller: clinic exercise → the row; system exercise + curator → master; otherwise the clinic override (content fields only, else 403 `master_field`). 409 `conflict` on a stale revision (T-30) |
| POST | `/exercises/bulk` | `{ids (≤500), patch}` → `{updated, skipped:[{id, reason}]}` (T-30) |
| POST | `/exercises/status` | `{ids (≤500), status}` → `{updated, skipped}`; approval needs a body region; master rows curators only (T-30) |
| DELETE | `/exercises/:id/override?fields=a,b` | back to the catalog version for those (or all) fields (T-30) |
| GET | `/exercises/:id/history` · POST `/exercises/revisions/:id/restore` | change history; restore re-applies a revision's `from` values as a new change (T-30) |
| GET | `/exercises/similar?name=&name_en=&exclude_id=` | duplicate check while creating/renaming (T-30) |
| POST | `/exercises/:id/media/upload-url` | `{files:[{mime_type, size_bytes}] (≤20)}` → `{scope, targets:[{path, token, thumb_path, thumb_token}]}` signed Storage upload targets. Types/caps: JPG/PNG/WebP 5MB, GIF 15MB, MP4/WebM 50MB (T-31) |
| POST | `/exercises/:id/media` | register media `{kind, path \| youtube_id, thumb_path?, source_file?, width?, height?, duration_ms?, mime_type?, size_bytes?, rights?, attribution?, start_sec?, end_sec?, primary?, verify?}` — the object must already exist under the caller's scope prefix; `verify` needs known rights (T-31) |
| PUT | `/exercises/:id/media/order` | `{ids}` — the full media list of the caller's scope, first = primary (T-31) |
| PATCH / DELETE | `/exercises/media/:mediaId` | update `{patch: rights\|attribution\|start_sec\|end_sec\|review_note}` (rights → unknown withdraws verification) · remove (deletes uploaded objects; dataset objects are never deleted) (T-31) |
| POST | `/exercises/media/verify` | `{ids (≤500), verified, rights?, note?}` → `{updated, skipped:[{id, reason: rights_unknown\|forbidden\|not_found}]}` (T-31) |
| GET | `/exercises/media/queue?status=pending\|verified\|rights_unknown\|all&source=dataset\|upload\|youtube&exercise_status=&limit=&offset=` | media the caller manages (curator: master + own clinic) → `{total, counts, items}` (T-31) |
| POST | `/exercises/media/match` | `{names (≤100, normalized file names)}` → best 3 exercise candidates per name with a score, for bulk import (T-31) |
| DELETE | `/exercises/:id` | soft-delete a clinic exercise; 422 `in_use` when a protocol or current plan still uses it (archive instead) |
| GET/POST/DELETE | `/plan-templates` | saved phase templates |
| GET | `/measure-definitions` | measurement catalog, clinic overrides over system defaults |
| GET | `/patients/:id/measurements?joint=ankle` | rows + definitions + previous values |
| POST | `/patients/:id/measurements` | record one measurement (see `ROM_MEASUREMENT.md` §5) |
| PATCH | `/measurements/:id` | edit — server supersedes the row, never mutates it |
| DELETE | `/measurements/:id` | soft delete |
| POST | `/patients/:id/assessment-visits` | open a visit for grouped measurements |
| PATCH | `/assessment-visits/:id/save` | close and save the visit |
| GET/PATCH | `/settings` | alert toggles, adherence threshold, units, weekly digest |

## Patient
| Method | Path | Returns |
|---|---|---|
| GET | `/me/today` | `{session_id, date, phase, items:[PlanExercise + done], progress}` |
| POST | `/me/sessions/:id/items` | `{items:[SessionItem]}` — **batch, idempotent** (offline queue flush) |
| POST | `/me/sessions/:id/complete` | `{max_pain, avg_difficulty, note}` |
| POST | `/me/sessions/:id/skip` | `{reason}` |
| GET | `/me/plan` | current phase, exercises, instructions, media |
| GET | `/me/progress?window=30` | adherence series, pain trend, phase timeline, milestones |
| GET | `/me/education?phase=` | phase education content |
| GET/POST | `/me/messages` | thread with clinician |
| POST | `/me/push-subscription` | Web Push registration |
| GET | `/me/export` · POST `/me/delete-request` | privacy endpoints |

## Errors
`{"error":{"code":"plan_version_conflict","message":"...","details":{...}}}`
Codes to implement: `unauthorized`, `forbidden`, `not_found`, `validation_failed`,
`plan_version_conflict` (409 — plan changed under an open editor),
`session_item_duplicate` (200, treated as success), `quiet_hours_deferred`, `rate_limited`,
`measure_side_invalid` (a `bilat: false` measure sent with a side, or vice versa).

## Realtime
Server-Sent Events at `/stream` for: new alert, new message, patient completed today's session.
Polling fallback at 60s.
