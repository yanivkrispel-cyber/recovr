// ReCOVR Design Tokens
// Single source of all style values — no ad-hoc hex in components.
// Generated from DESIGN_TOKENS.md

export const tokens = {
  color: {
    navy: '#1B2140',
    navyMuted: '#7E8AAE',
    gold: '#C9A24B',
    goldDeep: '#8C6423',
    goldDeepHover: '#6E4D18',
    sand: '#E9DCC4',
    cream: '#F6EFE3',
    paper: '#FBF8F1',
    white: '#FFFFFF',
    line: '#DBD2BF',
    lineSoft: '#EFE9DC',
    lineInput: '#C9C2B0',
    ink: '#2A2A2A',
    inkSoft: '#3D3A32',
    muted: '#6E6A5E',
    muted2: '#8A8272',
    placeholder: '#9C9280',
    warnBg: '#FBF3E2',
    warnLine: '#D9C39A',
    danger: '#B4562A',
  },
  // Status colors (no red/green traffic-light palette)
  status: {
    onTrack: { bg: 'var(--sand)', accent: 'var(--gold)' },
    attention: { bg: 'var(--warnBg)', accent: 'var(--danger)' },
    ready: { accent: 'var(--gold)' },
    // Flag colors per ROM_MEASUREMENT.md §4
    flag: {
      green: '#3F6B4A',
      red: '#9E3B2E',
      neutral: '#221C14',
    },
  },
  typography: {
    display: {
      fontFamily: '"Frank Ruhl Libre", serif',
      weights: [700, 800],
      sizes: [14, 16, 20, 22, 28],
    },
    ui: {
      fontFamily: '"Heebo", sans-serif',
      weights: [300, 400, 500, 600, 700, 800],
      bodySize: { clinician: '12-13px', patient: '15-16px' },
    },
    accent: {
      fontFamily: '"Cormorant Garamond", serif',
      style: 'italic',
      size: 13,
      color: 'rgba(201, 162, 75, 0.72-0.80)',
    },
    label: {
      size: '9-10px',
      weight: '600-700',
      tracking: '0.10-0.14em',
    },
  },
  spacing: {
    scale: [3, 4, 6, 8, 10, 12, 14, 18, 20, 24, 28, 40],
    page: { clinician: 28, patient: 20, print: 40 },
    card: { padding: 20, gap: 12 },
  },
  radius: {
    checkbox: 4,
    button: 8,
    card: '10-12px',
    panel: 14,
    pill: 999,
  },
  border: {
    width: 1,
    input: 1.4,
    svg: 1.6,
  },
  shadow: {
    floating: '0 2px 10px rgba(27,33,64,.09)',
    modal: '0 18px 48px rgba(27,33,64,.22)',
  },
  motion: {
    hover: '150ms ease-out',
    panel: '220ms ease',
    phase: '320ms ease',
    reducedMotion: '@media (prefers-reduced-motion: reduce)',
  },
} as const;

export type Tokens = typeof tokens;
