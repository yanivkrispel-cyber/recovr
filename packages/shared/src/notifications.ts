// RULES.md §5 — notifications. Copy, variables and timing per
// `Notification Templates.dc.html`; the six MVP events are catalogued here.
//
// Global rules:
//   - Quiet hours 21:30–07:30 patient-local. A notification generated inside
//     the window is deferred to 07:30 local — except `pain_spike` to the
//     clinician, which always sends immediately.
//   - Caps: a patient receives at most 2 push/day; clinician adherence alerts
//     collapse to one (dedupe key per patient / 7 days).
//   - Channels v1: Web Push + in-app. Email only for the weekly clinician
//     digest, whose body carries counts and a link only — never patient names
//     or clinical values.
//   - Every notification carries a deep link.
//   - Every category is opt-out-able except `pain_spike` to the clinician.
//
// The scheduling half of this (quiet-hours deferral, the daily cap) is
// mirrored in Postgres — `app.notif_defer_at` / `app.notification_enqueue` in
// supabase/migrations/0009_notifications.sql. Keep them in sync.

export type NotificationEventKey =
  | 'daily_reminder'
  | 'adherence_drop'
  | 'plan_updated'
  | 'phase_approved'
  | 'weekly_digest'
  | 'pain_spike'
  | 'new_message';

export type NotificationRecipient = 'patient' | 'clinician';
export type NotificationChannel = 'push' | 'email' | 'in_app';

export interface NotificationEvent {
  recipient: NotificationRecipient;
  channels: NotificationChannel[];
  /** opt-out category key (stored in app.notification_pref) */
  category: string;
  /** false => the recipient cannot turn this off */
  disableable: boolean;
  /** true => bypasses quiet hours and always sends now */
  urgent: boolean;
}

export const NOTIFICATION_EVENTS: Record<NotificationEventKey, NotificationEvent> = {
  daily_reminder: {
    recipient: 'patient',
    channels: ['push'],
    category: 'daily_reminder',
    disableable: true,
    urgent: false,
  },
  adherence_drop: {
    recipient: 'clinician',
    channels: ['push', 'in_app'],
    category: 'adherence',
    disableable: true,
    urgent: false,
  },
  plan_updated: {
    recipient: 'patient',
    channels: ['push'],
    category: 'plan_updates',
    disableable: true,
    urgent: false,
  },
  phase_approved: {
    recipient: 'patient',
    channels: ['push'],
    category: 'plan_updates',
    disableable: true,
    urgent: false,
  },
  weekly_digest: {
    recipient: 'clinician',
    channels: ['email'],
    category: 'weekly_digest',
    disableable: true,
    urgent: false,
  },
  pain_spike: {
    recipient: 'clinician',
    channels: ['push'],
    category: 'pain',
    disableable: false,
    urgent: true,
  },
  // T-19: a chat message. Fires in both directions (patient<->clinician); the
  // SQL layer passes recipient_type explicitly, so `recipient` here is nominal.
  new_message: {
    recipient: 'clinician',
    channels: ['push'],
    category: 'messages',
    disableable: true,
    urgent: false,
  },
};

// --- quiet hours ------------------------------------------------------------

export const QUIET_START_MIN = 21 * 60 + 30; // 21:30
export const QUIET_END_MIN = 7 * 60 + 30; // 07:30
export const PATIENT_PUSH_DAILY_CAP = 2;

/** Is a local wall-clock time (minutes past midnight) inside quiet hours? */
export function inQuietHours(localMinutes: number): boolean {
  // window wraps midnight: [21:30, 24:00) ∪ [00:00, 07:30)
  return localMinutes >= QUIET_START_MIN || localMinutes < QUIET_END_MIN;
}

/**
 * When a notification generated at `now` (in `timeZone`) should actually be
 * sent. Urgent events send at `now`; anything landing in quiet hours is
 * pushed to the next 07:30 local. Mirrors `app.notif_defer_at`.
 */
export function deferredSendAt(now: Date, timeZone: string, urgent: boolean): Date {
  if (urgent) return now;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')!.value);
  const localMin = hh * 60 + mm;

  if (!inQuietHours(localMin)) return now;

  // minutes from now until the next 07:30 local
  let delta = QUIET_END_MIN - localMin;
  if (delta <= 0) delta += 24 * 60;
  return new Date(now.getTime() + delta * 60_000);
}

// --- rendering ------------------------------------------------------------

export type NotifVars = Record<string, string | number | null | undefined>;

function fill(tpl: string, vars: NotifVars): string {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
    .replace(/\s+/g, ' ')
    .trim();
}

const TEMPLATES: Record<NotificationEventKey, { title: string; body: string }> = {
  daily_reminder: {
    title: 'האימון של היום מחכה לך',
    body: '{exercise_count} תרגילים · כ-{duration_min} דקות. יום {day_number} בשיקום.',
  },
  adherence_drop: {
    title: '{patient_name} — היענות {adherence_pct}% בשבוע האחרון',
    body: '{days_done} מתוך {days_planned} ימי אימון בוצעו.',
  },
  plan_updated: {
    title: '{clinician_name} עדכן/ה את התוכנית שלך',
    body: 'נוספו {added_count} · שונו {changed_count} · הוסרו {removed_count}. ההוראות המעודכנות באפליקציה.',
  },
  phase_approved: {
    title: 'עברת לשלב {phase_number} — {phase_name}',
    body: 'הקריטריונים הושגו והמטפל אישר. התוכנית החדשה זמינה מהאימון הבא.',
  },
  weekly_digest: {
    title: 'סיכום שבועי · {patient_count} מטופלים · {attention_count} דורשים תשומת לב',
    body: 'היענות ממוצעת {avg_adherence}% · {ready_count} מוכנים למעבר שלב · {overdue_count} הערכות באיחור.',
  },
  pain_spike: {
    title: '{patient_name} דיווח/ה כאב {pain_score}/10',
    body: 'בתרגיל "{exercise_name}", שלב {phase_number}. {patient_note}',
  },
  new_message: {
    title: 'הודעה חדשה מ{from_name}',
    body: '{preview}',
  },
};

export function renderNotification(
  event: NotificationEventKey,
  vars: NotifVars,
): { title: string; body: string } {
  const tpl = TEMPLATES[event];
  return { title: fill(tpl.title, vars), body: fill(tpl.body, vars) };
}

// --- deep links ----------------------------------------------------------

/** Deep link path for an event. Patient links resolve inside `/m`, clinician
 *  links inside `/app`. */
export function deepLink(event: NotificationEventKey, vars: NotifVars): string {
  switch (event) {
    case 'daily_reminder':
    case 'phase_approved':
      return '/today';
    case 'plan_updated':
      return '/plan?diff=last';
    case 'adherence_drop':
    case 'pain_spike':
      return vars.patient_id ? `/patients/${vars.patient_id}` : '/patients';
    case 'weekly_digest':
      return '/dashboard';
    case 'new_message':
      // clinician recipient gets the patient's thread; patient recipient the tab
      return vars.patient_id ? `/patients/${vars.patient_id}` : '/messages';
  }
}

// --- weekly digest email (counts + link only, never PII) ------------------

export interface DigestVars {
  patient_count: number;
  attention_count: number;
  avg_adherence: number;
  ready_count: number;
  overdue_count: number;
  app_url: string;
}

export function renderDigestEmail(v: DigestVars): {
  subject: string;
  preheader: string;
  text: string;
  html: string;
} {
  const subject = `סיכום שבועי · ${v.patient_count} מטופלים · ${v.attention_count} דורשים תשומת לב`;
  const preheader = `${v.ready_count} מוכנים למעבר שלב, ${v.attention_count} דורשים תשומת לב`;
  const rows: [string, string | number][] = [
    ['היענות ממוצעת', `${v.avg_adherence}%`],
    ['מוכנים לאישור מעבר שלב', v.ready_count],
    ['מתחת לסף היענות', v.attention_count],
    ['הערכות שמועדן עבר', v.overdue_count],
  ];
  const text = [
    subject,
    '',
    ...rows.map(([k, val]) => `${k}: ${val}`),
    '',
    `פתח/י את המערכת: ${v.app_url}`,
    '',
    'המייל אינו כולל שמות מטופלים או נתונים קליניים.',
  ].join('\n');
  const html = `<div dir="rtl" style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto">
  <h2 style="font-size:16px;margin:0 0 4px">${subject}</h2>
  <p style="color:#6b6b6b;font-size:12px;margin:0 0 16px">${preheader}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows
      .map(
        ([k, val]) =>
          `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${k}</td>` +
          `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:left;font-weight:700">${val}</td></tr>`,
      )
      .join('')}
  </table>
  <p style="margin:16px 0"><a href="${v.app_url}">פתח/י את המערכת</a></p>
  <p style="color:#9b9b9b;font-size:11px">המייל אינו כולל שמות מטופלים או נתונים קליניים.</p>
</div>`;
  return { subject, preheader, text, html };
}
