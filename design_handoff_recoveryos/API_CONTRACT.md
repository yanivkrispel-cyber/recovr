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
| GET | `/exercises?q=&category=&region_id=&protocol=&phase=&equipment=&favorites=1&media=1&limit=&offset=` | library search (used by the exercise picker) → `{items:[Exercise], total}`. `region_id` is a `body_region` id (T-28), not free text. `limit` defaults to 60, capped at 200. Items carry picker card fields (T-29): `equipment`, `is_favorite`, `thumb_url`/`gif_url` (signed, API-origin-relative), `media_verified`. |
| GET | `/exercises/recommend?protocol_id=&region_id=&phase=&anchor_ids=&exclude_ids=&limit=` | picker recommendations (T-29) → `{context:{protocol_id, body_region, phase_n, region_protocol_total, anchor_categories}, items:[Exercise + score, rank, reasons[], prescription, frequency]}`. Region falls back to the protocol's. Signals: protocol library + this clinic's picker history only. |
| GET | `/exercises/recent` | exercises this clinician added through the picker, newest first (T-29) |
| PUT/DELETE | `/exercises/:id/favorite` | star / unstar for the current clinician (T-29) |
| POST | `/exercises/picker-events` | best-effort picker log `{picker_session_id, entry, protocol_id?, body_region_id?, phase_n?, events:[{exercise_id, event: shown\|added, source?, rank?, score?}]}` (T-29) |
| POST | `/exercises` | clinic-custom exercise |
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
