// Formatters — all dates and times handled in patient-local timezone.

export function formatHebrewDate(date: Date | string, locale = 'he-IL'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatHebrewDateTime(date: Date | string, timezone: string, locale = 'he-IL'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(d);
}

export function toPatientLocalDate(utc: Date | string, timezone: string): string {
  const d = typeof utc === 'string' ? new Date(utc) : utc;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function formatPercent(value: number, round = true): string {
  // Half-up rounding per RULES §1
  const v = round ? Math.round(value) : value;
  return `${v}%`;
}

export function formatNumber(value: number, maxDigits = 1): string {
  return new Intl.NumberFormat('he-IL', {
    maximumFractionDigits: maxDigits,
  }).format(value);
}

export function relativeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'עכשיו';
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `לפני ${days} ימים`;
  return formatHebrewDate(date);
}
