# DESIGN_TOKENS.md

Values are lifted from the prototype. Treat as canonical.

## Color
| Token | Hex | Use |
|---|---|---|
| `navy` | #1B2140 | Headers, primary buttons, dark surfaces, text on light for emphasis |
| `navy-muted` | #7E8AAE | Secondary text on navy |
| `gold` | #C9A24B | Accent, active state, logo mark, phase markers |
| `gold-deep` | #8C6423 | Links, secondary badges |
| `gold-deep-hover` | #6E4D18 | Link hover |
| `sand` | #E9DCC4 | App background (clinician) |
| `cream` | #F6EFE3 | Text on navy, light chips |
| `paper` | #FBF8F1 | Card / row alternate background |
| `white` | #FFFFFF | Cards, sheets |
| `line` | #DBD2BF | Card borders |
| `line-soft` | #EFE9DC | Table row dividers |
| `line-input` | #C9C2B0 | Input borders, checkboxes |
| `ink` | #2A2A2A | Body text |
| `ink-soft` | #3D3A32 | Secondary body |
| `muted` | #6E6A5E | Tertiary text |
| `muted-2` | #8A8272 | Labels, meta |
| `placeholder` | #9C9280 | Placeholder text |
| `warn-bg` | #FBF3E2 | Warning/attention surface |
| `warn-line` | #D9C39A | Warning border |
| `danger` | #B4562A | Pain spike, critical dot, urgent pill |

Status: on-track = navy/gold neutral treatment; attention = `warn-bg` + `danger` dot;
ready-for-advance = gold pill. **No red/green traffic-light palette** — it reads as medical alarm.

## Typography
- **Display / headings:** Frank Ruhl Libre, 700–800. Sizes 14 / 16 / 20 / 22px in documents,
  up to 28px in app headers.
- **UI / body:** Heebo 300–800. Body 12–13px (clinician dense tables 11–11.5px),
  patient app body 15–16px minimum.
- **Latin subtitle accent:** Cormorant Garamond italic 13px, gold at 72–80% opacity. Decorative only.
- **Labels:** 9–10px, weight 600–700, letter-spacing 0.10–0.14em, uppercase for Latin,
  normal case for Hebrew.
- Line-height: 1.45–1.55 for body, 1.2 for headings. `text-wrap: pretty` on body,
  `balance` on headings.

## Spacing & shape
- Scale: 3 / 4 / 6 / 8 / 10 / 12 / 14 / 18 / 20 / 24 / 28 / 40px.
- Page padding: 28px (clinician), 20px (patient), 40px (print sheet).
- Radii: 4 (checkbox) · 8 (button, small control) · 10–12 (card) · 14 (panel, push card) · 999 (pill).
- Borders: 1px solid `line`; 1.4px for checkbox/input outlines; 1.6px SVG stroke.
- Shadow (only on floating surfaces): `0 2px 10px rgba(27,33,64,.09)`;
  modals `0 18px 48px rgba(27,33,64,.22)`.

## States
- Hover: darken surface 4%, or gold-deep for links.
- Active/selected: navy fill + cream text, or gold left/right marker (RTL-aware).
- Focus: 2px `gold` outline, 2px offset — must be visible on both light and navy.
- Disabled: 45% opacity, no pointer events.
- Loading: skeleton blocks with `shimmer` keyframe, opacity .55 → 1 → .55 over 1.6s.
- Toast: navy surface, cream text, bottom-center (clinician) / above tab bar (patient), 2.6s.

## Motion
150ms ease-out for hover/state, 220ms ease for panels and drawers, 320ms for phase transitions.
Respect `prefers-reduced-motion`.

## RTL
Direction is `rtl` at document level. Use logical properties (`margin-inline-start`,
`padding-inline`) — never left/right. Numbers, percentages and English exercise names stay LTR
inside `bdi`/`dir="ltr"` spans. Icons that imply direction (chevrons, progress) mirror.
