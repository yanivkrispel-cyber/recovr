# ROM_MEASUREMENT.md — range-of-motion & functional measurement module

New in this revision. Everything here lives in `Rehab Platform Prototype.dc.html`
(clinician side → patient → **הערכות / Assessments** tab → ROM card + measurement panel).
Clinician-only. There is no patient-facing self-measurement in v1.

---

## 1. Concept

Two kinds of measurement share one panel, one table and one history:

| Kind | Unit | Input | Visual | Norm authority |
|---|---|---|---|---|
| **Goniometric ROM** | degrees | 3 attempts, clinician picks the governing value (best / average / a specific attempt) | 180° arc gauge | AAOS |
| **Functional test** | cm, degrees, or pass/fail | single measurement | horizontal ruler (cm), the same gauge (degrees), pass/fail buttons | the test's own literature (labelled by name, never "AAOS") |

A functional test is flagged in the catalog with `fx: true`. **They are not
interchangeable with goniometry** — a functional test is always its own row, never an
alternative input mode for a goniometric row. This is the single most important rule in
this module: never merge `ank_df` (goniometric dorsiflexion) with `ank_wblt` (WBLT).

---

## 2. Measurement catalog

Source of truth in the prototype: `ROM_CATALOG`, keyed by joint
(`knee`, `hip`, `ankle`, `shoulder`, `elbow`, `wrist`, `cervical`, `lumbar`).
Order shown to the clinician: `ROM_JOINT_ORDER`.
Default joint per protocol: `REGION_JOINT` (`acl_tear → knee`,
`rotator_cuff_sprain → shoulder`, `achilles_tendinopathy → ankle`), overridable by the
clinician via the joint switcher (`romJointSel`).

### Definition fields

| Field | Meaning |
|---|---|
| `id` | stable key, e.g. `ank_wblt` — use as `measure_code` in the DB |
| `he` / `en` | Hebrew label (primary) / English clinical name |
| `unit` | omitted = degrees · `'cm'` = centimetres · `'pf'` = pass/fail |
| `norm` | population norm |
| `target` | phase-progression target |
| `scale` | gauge/ruler upper bound (defaults to `max(20, ceil(norm·1.15 / 10)·10)`) |
| `deficit` | `true` → 0 is perfect, higher = worse (extension lag, Thomas) |
| `lower` | `true` → lower cm value is better (heel-to-buttock) |
| `fx` | `true` → functional test: single measurement, non-AAOS norm |
| `bilat: false` | not a two-sided test → hides the side switch and the healthy-side column |
| `sideDiff` | side-to-side gap (in the row's unit) at or above which the row flags red |
| `riskBelow` | absolute value below which the row flags red |
| `degOpt` | `true` → shows the optional secondary degrees field (inclinometer) |
| `normSource` | short label used in the UI: `נורמה (WBLT)`, `נורמה (Thomas)`, `נורמה (Schober)` |
| `tip` | Hebrew execution protocol, shown as an `ⓘ` tooltip in the row and panel header |

### Functional tests in this revision

**`ank_wblt` — דורסיפלקסיה בעמידה · Weight-Bearing Lunge Test** (ankle)
`unit: 'cm'`, `norm: 11`, `target: 10`, `scale: 15`, `riskBelow: 9`, `sideDiff: 1.5`,
`degOpt: true`, `normSource: 'WBLT'`.
Primary record is toe/heel-to-wall distance in cm; tibial inclination in degrees is an
optional secondary field, typed by the clinician from an inclinometer or app. The two are
**not** derived from one another — do not compute one from the other.
Protocol tooltip: toe on the tape, knee touching the wall, heel stays down, maximal distance.

**`knee_h2b` — עקב-לישבן · Heel-to-buttock distance** (knee)
`unit: 'cm'`, `norm: 0`, `target: 2`, `scale: 12`, `lower: true`, `sideDiff: 2`.
Prone, maximal knee flexion; 0 cm = full range. Lower is better, so the ruler fill and the
table's progress bar invert.

**`knee_squat` — סקוואט עמוק · Deep squat** (knee)
`unit: 'pf'`, `bilat: false`. Pass/fail plus a compensation multi-select:
`heels` (עקבים מתרוממים), `knees` (ברכיים פנימה), `trunk` (גו נוטה קדימה).
Bilateral, so no side switch, no side-gap flag.

**`hip_thomas` — תומאס · Thomas test** (hip)
degrees, `deficit: true`, `scale: 30`, `normSource: 'Thomas'`. Records the hip
extension deficit angle; 0° = normal. Stays on the arc gauge.

**`lum_schober` — שוברס מותאם · Modified Schober** (lumbar)
`unit: 'cm'`, `norm: 6`, `target: 5`, `scale: 9`, `bilat: false`, `normSource: 'Schober'`.
Single-sided spinal measure: side switch and healthy-side column are hidden.

Functional tests are **auto-included** in their joint's list — they are not opt-in and
require no configuration by the clinician.

---

## 3. The measurement panel

Opened by clicking a row (`openRom(motionId)`); closed by `closeRom`.
Sections top to bottom:

1. **Header** — Hebrew title + `ⓘ` protocol tooltip, English clinical name.
2. **Side switch** — `הצד הפגוע` / `הצד הבריא` (`romSide: 'involved' | 'healthy'`).
   Hidden when `bilat === false`.
3. **Visualization** — exactly one of:
   - **Arc gauge** (degrees): 180° arc, `0–scale`, green target band, AAOS norm tick,
     dashed navy contralateral marker, muted previous-measurement marker, dark needle.
   - **Horizontal ruler** (cm): 236px track, 1-unit ticks with labels every 3, green
     target band, green norm line, dashed navy contralateral line, muted previous line,
     fill coloured by flag state.
   - **Pass/fail buttons** + compensation chips (`unit: 'pf'`).
4. **Governing value** — large serif number, coloured green when clean, red when flagged,
   with the source line beneath (`ממוצע שלושת הניסיונות` / `מדידה בודדת · <English name>` /
   `סמן עובר או לא עובר`). For cm rows a side-gap line follows (`פער צדדים 3.5 ס"מ`).
5. **Input** — one of:
   - **Three attempts** + governing-value picker (goniometric rows only).
   - **Numeric keypad** (single measurement, `fx` rows): 3×4 grid, digits + `.` + `⌫`,
     value shown in a large serif field above. Max 4 significant digits, one decimal point.
     Plus the optional tibia-angle text input when `degOpt`.
6. **Context** — pain 0–10, end feel (רך / קשה), swelling (אין / קל / בינוני / ניכר), free note.
7. **Reference panel** — healthy side, norm (labelled by `normSource`), tibia angle when
   `degOpt`, baseline, phase target.
8. **History** — every stored measurement, each editable (`editRomEntry`) and deletable
   (`deleteRomEntry`).

### Assessment-visit mode
`startRomVisit` / `saveRomVisit` / `cancelRomVisit`. While active, each saved measurement
tags its row `· נמדד במפגש` and increments the counter (`N מדידות במפגש`). Saving the visit
groups the measurements into one clinical event; cancelling discards the grouping, not the
measurements.

---

## 4. Flags & colour rules

Colour only — no warning banners. Green `#3F6B4A`, red `#9E3B2E`, neutral `#221C14`.

A cm row is **flagged red** when any of:
- `riskBelow` is set and `|value| < riskBelow` — WBLT under 9 cm.
- the side gap `|involved − healthy| ≥ sideDiff` — WBLT ≥ 1.5 cm, heel-to-buttock ≥ 2 cm.
- `lower` is set and `|value| > target`.

Degrees rows keep the existing symmetry/target logic. Pass/fail rows are green on pass,
red on fail.

Row summary strings (table, right-hand column):
- cm: `7 ס"מ · נורמה 11 ס"מ · 34° · מתחת לסף` (the degrees segment only when recorded)
- pass/fail: `עובר · פיצוי: עקבים מתרוממים` or `עובר · ללא פיצויים`
- deficit + `fx`: `תקין` (never "בנורמה (AAOS)")
- goniometric: unchanged — `82% מנורמת AAOS · פער 4°`

Side-comparison column: cm rows show `פער 3.5 ס"מ`, coloured by `sideDiff`; `bilat: false`
rows show `דו-צדדי`.

---

## 5. Data notes for implementation

Per patient + measure, the stored row is:

```
{ series: number[],      // involved side, chronological
  healthy: number|null,  // contralateral reference
  deg: number|null,      // optional secondary degrees (degOpt rows)
  comps: { heels?: bool, knees?: bool, trunk?: bool } }  // pass/fail rows
```

Two rules the prototype had to fix, and the backend must respect:

1. **An empty optional field must never overwrite a stored value.** `deg` is written only
   when the field actually holds a number; an untouched field leaves the previous value
   intact. Same for `comps`.
2. **Opening the panel prefills** `deg` and `comps` from the stored row, so what the
   clinician sees is what will be saved.

Suggested schema (extends `DATA_MODEL.md` → *Activity & measurement*):

- **measure_definition** — id, clinic_id (null = system), code (`ank_wblt`), joint,
  name_he, name_en, unit (`deg`|`cm`|`pass_fail`), norm, target, scale, flags jsonb
  (`deficit`, `lower`, `fx`, `bilat`, `side_diff`, `risk_below`, `deg_opt`),
  norm_source, protocol_tip
- **measurement** — id, patient_id, measure_code, side (`involved`|`healthy`|`bilateral`),
  value numeric, value_secondary numeric null (the tibia angle), pass boolean null,
  compensations text[], attempts numeric[] null, governing_source
  (`best`|`avg`|`attempt_n`|`single`), pain smallint, end_feel (`soft`|`hard`),
  swelling smallint, note, visit_id null, measured_by, measured_at
- **assessment_visit** — id, patient_id, started_at, saved_at, clinician_id, note

`measurement` rows are append-only and soft-deleted; an edit writes a new row and
supersedes the old one (`superseded_by`), so the phase-criteria snapshot stays reproducible.

API (extends `API_CONTRACT.md` → *Clinician*):

| Method | Path | Notes |
|---|---|---|
| GET | `/patients/:id/measurements?joint=ankle` | rows + definitions + previous values |
| POST | `/patients/:id/measurements` | one measurement; `Idempotency-Key` honored |
| PATCH | `/measurements/:id` | edit; server supersedes rather than mutates |
| DELETE | `/measurements/:id` | soft delete |
| POST | `/patients/:id/assessment-visits` · PATCH `/assessment-visits/:id/save` | visit grouping |
| GET | `/measure-definitions` | catalog, clinic-scoped over system defaults |

Validation: `cm` 0–60 with one decimal · degrees −30–200 · pass/fail requires the boolean ·
side must be `bilateral` exactly when the definition has `bilat: false`.

---

## 6. Acceptance criteria

- Maya Shalev → ankle shows **דורסיפלקסיה** (goniometric, 3 attempts, gauge) and
  **דורסיפלקסיה בעמידה · WBLT** (cm, keypad, ruler) as two separate rows.
- WBLT at 7 cm with a healthy side of 10.5 cm: value red, `פער צדדים 3.5 ס"מ` red.
  At 9.5 cm: value green, gap 1 cm green.
- Saving a new WBLT value without touching the degrees field **preserves** the stored
  tibia angle; the reference panel still shows it.
- Deep squat: no side switch; compensations persist and appear in the row summary.
- Modified Schober: no side switch, no healthy-side value.
- Thomas: arc gauge, 0–30° scale, `נורמה (Thomas)` label; the string "AAOS" appears
  nowhere on a functional test.
