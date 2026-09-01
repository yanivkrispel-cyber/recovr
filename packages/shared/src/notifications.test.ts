import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_EVENTS,
  PATIENT_PUSH_DAILY_CAP,
  deepLink,
  deferredSendAt,
  inQuietHours,
  renderDigestEmail,
  renderNotification,
  type NotificationEventKey,
} from './notifications';

const TZ = 'Asia/Jerusalem';

// helper: an instant that is `hh:mm` local in TZ on a fixed summer date
function localInstant(hh: number, mm: number): Date {
  // Jerusalem is UTC+3 in summer (2026-07-15)
  return new Date(Date.UTC(2026, 6, 15, hh - 3, mm, 0));
}

describe('quiet hours', () => {
  it('window wraps midnight: 21:30–07:30', () => {
    expect(inQuietHours(21 * 60 + 29)).toBe(false);
    expect(inQuietHours(21 * 60 + 30)).toBe(true);
    expect(inQuietHours(23 * 60)).toBe(true);
    expect(inQuietHours(3 * 60)).toBe(true);
    expect(inQuietHours(7 * 60 + 29)).toBe(true);
    expect(inQuietHours(7 * 60 + 30)).toBe(false);
    expect(inQuietHours(12 * 60)).toBe(false);
  });

  it('sends immediately outside quiet hours', () => {
    const now = localInstant(18, 0);
    expect(deferredSendAt(now, TZ, false).getTime()).toBe(now.getTime());
  });

  it('defers a 22:00 notification to the next 07:30 local (+9.5h)', () => {
    const now = localInstant(22, 0);
    const at = deferredSendAt(now, TZ, false);
    expect((at.getTime() - now.getTime()) / 60_000).toBe(9 * 60 + 30);
  });

  it('defers an 03:00 notification to 07:30 the same morning (+4.5h)', () => {
    const now = localInstant(3, 0);
    const at = deferredSendAt(now, TZ, false);
    expect((at.getTime() - now.getTime()) / 60_000).toBe(4 * 60 + 30);
  });

  it('a 07:29 notification defers one minute; 07:30 sends now', () => {
    expect((deferredSendAt(localInstant(7, 29), TZ, false).getTime() - localInstant(7, 29).getTime()) / 60_000).toBe(1);
    const t730 = localInstant(7, 30);
    expect(deferredSendAt(t730, TZ, false).getTime()).toBe(t730.getTime());
  });

  it('urgent (pain_spike) bypasses quiet hours', () => {
    const now = localInstant(2, 0);
    expect(deferredSendAt(now, TZ, true).getTime()).toBe(now.getTime());
  });
});

describe('event catalogue matches RULES §5', () => {
  it('pain_spike to the clinician is urgent and not disableable', () => {
    expect(NOTIFICATION_EVENTS.pain_spike.urgent).toBe(true);
    expect(NOTIFICATION_EVENTS.pain_spike.disableable).toBe(false);
    expect(NOTIFICATION_EVENTS.pain_spike.recipient).toBe('clinician');
  });

  it('every other event is disableable and not urgent', () => {
    for (const [key, ev] of Object.entries(NOTIFICATION_EVENTS)) {
      if (key === 'pain_spike') continue;
      expect(ev.disableable, key).toBe(true);
      expect(ev.urgent, key).toBe(false);
    }
  });

  it('email is only used for the weekly digest', () => {
    for (const [key, ev] of Object.entries(NOTIFICATION_EVENTS)) {
      expect(ev.channels.includes('email'), key).toBe(key === 'weekly_digest');
    }
  });

  it('patient push daily cap is 2', () => {
    expect(PATIENT_PUSH_DAILY_CAP).toBe(2);
  });
});

describe('rendering', () => {
  it('fills variables and drops unknown placeholders', () => {
    const r = renderNotification('phase_approved', { phase_number: 4, phase_name: 'חזרה לספורט' });
    expect(r.title).toBe('עברת לשלב 4 — חזרה לספורט');
    expect(r.body).not.toMatch(/\{/);
  });

  it('renders a new_message push from a preview', () => {
    const r = renderNotification('new_message', { from_name: 'ד״ר יעל', preview: 'איך ההרגשה?' });
    expect(r.title).toBe('הודעה חדשה מד״ר יעל');
    expect(r.body).toBe('איך ההרגשה?');
  });

  it('pain_spike renders with an optional empty note', () => {
    const r = renderNotification('pain_spike', {
      patient_name: 'מאיה שלו',
      pain_score: 7,
      exercise_name: 'התקדמות בקפיצות',
      phase_number: 4,
      patient_note: null,
    });
    expect(r.title).toBe('מאיה שלו דיווח/ה כאב 7/10');
    expect(r.body).toContain('שלב 4');
    expect(r.body).not.toMatch(/\{|\bnull\b/);
  });
});

describe('deep links', () => {
  it.each<[NotificationEventKey, Record<string, string | number>, string]>([
    ['daily_reminder', {}, '/today'],
    ['phase_approved', {}, '/today'],
    ['plan_updated', {}, '/plan?diff=last'],
    ['adherence_drop', { patient_id: 'p1' }, '/patients/p1'],
    ['pain_spike', { patient_id: 'p1' }, '/patients/p1'],
    ['weekly_digest', {}, '/dashboard'],
    ['new_message', { patient_id: 'p1' }, '/patients/p1'],
    ['new_message', {}, '/messages'],
  ])('%s -> %s', (event, vars, expected) => {
    expect(deepLink(event, vars)).toBe(expected);
  });
});

describe('weekly digest email — no PII', () => {
  const out = renderDigestEmail({
    patient_count: 12,
    attention_count: 3,
    avg_adherence: 82,
    ready_count: 2,
    overdue_count: 4,
    app_url: 'https://app.example/app/dashboard',
  });

  it('subject and body carry only counts and a link', () => {
    expect(out.subject).toBe('סיכום שבועי · 12 מטופלים · 3 דורשים תשומת לב');
    expect(out.text).toContain('היענות ממוצעת: 82%');
    expect(out.text).toContain('https://app.example/app/dashboard');
  });

  it('never interpolates a name-shaped field', () => {
    // the renderer has no patient_name / clinician_name inputs at all
    expect(out.html).not.toMatch(/patient_name|clinician_name|\{/);
    expect(out.text).not.toMatch(/patient_name|clinician_name|\{/);
  });
});
