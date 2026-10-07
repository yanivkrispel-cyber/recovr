// The booking components run in two places: the public booking page (light,
// the clinic's paper/navy look — visitors aren't patients yet) and inside
// the patient app (its dark navy theme). Tokens only.

export interface BookingTheme {
  page: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  accentInk: string;
  cta: string;
  ctaInk: string;
  link: string;
  notice: string;
  danger: string;
  success: string;
}

export const LIGHT: BookingTheme = {
  page: 'var(--paper)',
  card: 'var(--white)',
  text: 'var(--ink)',
  muted: 'var(--muted)',
  faint: 'var(--muted-2)',
  border: 'var(--line)',
  accent: 'var(--navy)',
  accentInk: 'var(--cream)',
  cta: 'var(--gold-deep)',
  ctaInk: 'var(--white)',
  link: 'var(--gold-deep)',
  notice: 'var(--warn-bg)',
  danger: 'var(--danger)',
  success: 'var(--flag-green)',
};

export const DARK: BookingTheme = {
  page: 'var(--patient-bg)',
  card: 'var(--patient-card)',
  text: 'var(--patient-text)',
  muted: 'var(--patient-muted)',
  faint: 'var(--patient-dim)',
  border: 'var(--patient-border)',
  accent: 'var(--patient-gold)',
  accentInk: 'var(--patient-gold-ink)',
  cta: 'var(--patient-gold)',
  ctaInk: 'var(--patient-gold-ink)',
  link: 'var(--patient-gold)',
  notice: 'var(--patient-card-light)',
  danger: 'var(--patient-danger)',
  success: 'var(--patient-success)',
};
