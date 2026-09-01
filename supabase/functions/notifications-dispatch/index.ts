// Edge Function: notifications dispatcher.
//   POST /notifications-dispatch   -> drain app.notifications_due(), send, mark
//
// Invoked by pg_cron (via pg_net) or a scheduled trigger. Service-role only —
// there is no per-user auth here; it must not be exposed with verify_jwt off to
// the public without a shared secret (DISPATCH_SECRET).
//
// Web Push copy/deep-link logic is a compact copy of
// packages/shared/src/notifications.ts (kept self-contained like the other
// edge functions). Keep the two in sync.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:ops@recoveryos.local';
const DISPATCH_SECRET = Deno.env.get('DISPATCH_SECRET') ?? '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'http://localhost:5173';
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '2500');
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? 'RecoveryOS <digest@recoveryos.local>';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

type NotifVars = Record<string, unknown>;

const TEMPLATES: Record<string, { title: string; body: string }> = {
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
  pain_spike: {
    title: '{patient_name} דיווח/ה כאב {pain_score}/10',
    body: 'בתרגיל "{exercise_name}", שלב {phase_number}. {patient_note}',
  },
  new_message: {
    title: 'הודעה חדשה מ{from_name}',
    body: '{preview}',
  },
};

function fill(tpl: string, vars: NotifVars): string {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
    .replace(/\s+/g, ' ')
    .trim();
}

function deepLink(event: string, vars: NotifVars): string {
  switch (event) {
    case 'daily_reminder':
    case 'phase_approved':
      return '/m/';
    case 'plan_updated':
      return '/m/?diff=last';
    case 'adherence_drop':
    case 'pain_spike':
      return vars.patient_id ? `/app/patients/${vars.patient_id}` : '/app/';
    case 'new_message':
      // patient->clinician carries patient_id; clinician->patient does not
      return vars.patient_id ? `/app/patients/${vars.patient_id}` : '/m/';
    default:
      return '/app/';
  }
}

function digestEmail(v: NotifVars): { subject: string; text: string; html: string } {
  const n = (k: string) => Number(v[k] ?? 0);
  const subject = `סיכום שבועי · ${n('patient_count')} מטופלים · ${n('attention_count')} דורשים תשומת לב`;
  const rows: [string, number | string][] = [
    ['היענות ממוצעת', `${n('avg_adherence')}%`],
    ['מוכנים לאישור מעבר שלב', n('ready_count')],
    ['מתחת לסף היענות', n('attention_count')],
    ['הערכות שמועדן עבר', n('overdue_count')],
  ];
  const url = String(v.app_url ?? APP_BASE_URL);
  const text =
    `${subject}\n\n` +
    rows.map(([k, val]) => `${k}: ${val}`).join('\n') +
    `\n\nפתח/י את המערכת: ${url}\n\nהמייל אינו כולל שמות מטופלים או נתונים קליניים.`;
  const html =
    `<div dir="rtl" style="font-family:system-ui,Arial;max-width:520px;margin:0 auto">` +
    `<h2 style="font-size:16px">${subject}</h2><table style="width:100%;border-collapse:collapse;font-size:14px">` +
    rows
      .map(
        ([k, val]) =>
          `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${k}</td>` +
          `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:left;font-weight:700">${val}</td></tr>`,
      )
      .join('') +
    `</table><p><a href="${url}">פתח/י את המערכת</a></p>` +
    `<p style="color:#9b9b9b;font-size:11px">המייל אינו כולל שמות מטופלים או נתונים קליניים.</p></div>`;
  return { subject, text, html };
}

async function sendEmail(to: string, subject: string, text: string, html: string): Promise<void> {
  if (!SMTP_HOST) throw new Error('SMTP not configured');
  // Minimal SMTP over a raw TCP connection (plain, local dev relay only).
  const conn = await Deno.connect({ hostname: SMTP_HOST, port: SMTP_PORT });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(1024);
  const step = async (line?: string) => {
    if (line) await conn.write(enc.encode(line + '\r\n'));
    const n = await conn.read(buf);
    return dec.decode(buf.subarray(0, n ?? 0));
  };
  await step();
  await step(`EHLO recoveryos`);
  await step(`MAIL FROM:<digest@recoveryos.local>`);
  await step(`RCPT TO:<${to}>`);
  await step(`DATA`);
  const body =
    `From: ${SMTP_FROM}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n.`;
  await step(body);
  await step(`QUIT`);
  conn.close();
}

Deno.serve(async (req) => {
  if (DISPATCH_SECRET && req.headers.get('x-dispatch-secret') !== DISPATCH_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: due, error } = await svc.schema('app').rpc('notifications_due', { p_limit: 200 });
  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  for (const row of (due ?? []) as Array<{
    schema: string;
    id: string;
    recipient_type: string;
    recipient_id: string;
    event_key: string;
    channel: string;
    payload: NotifVars;
  }>) {
    try {
      if (row.channel === 'email') {
        const { data: user } = await svc.schema('app').from('user').select('email').eq('id', row.recipient_id).single();
        if (!user?.email) throw new Error('no email for recipient');
        const { subject, text, html } = digestEmail(row.payload);
        await sendEmail(user.email, subject, text, html);
      } else {
        // push
        const { data: tokens } = await svc
          .schema('app')
          .from('device_token')
          .select('endpoint, keys')
          .eq('owner_type', row.recipient_type)
          .eq('owner_id', row.recipient_id);
        if (!tokens?.length) throw new Error('no device tokens');
        if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('VAPID keys not configured');

        const tpl = TEMPLATES[row.event_key];
        const notif = {
          title: fill(tpl.title, row.payload),
          body: fill(tpl.body, row.payload),
          url: deepLink(row.event_key, row.payload),
          tag: row.event_key,
        };
        for (const tk of tokens as Array<{ endpoint: string; keys: { p256dh: string; auth: string } }>) {
          await webpush.sendNotification(
            { endpoint: tk.endpoint, keys: tk.keys },
            JSON.stringify(notif),
          );
        }
      }
      await svc.schema('app').rpc('notification_mark', { p_schema: row.schema, p_id: row.id, p_status: 'sent' });
      sent++;
    } catch (e) {
      await svc.schema('app').rpc('notification_mark', {
        p_schema: row.schema,
        p_id: row.id,
        p_status: 'failed',
        p_error: String(e instanceof Error ? e.message : e).slice(0, 300),
      });
      failed++;
    }
  }

  return new Response(JSON.stringify({ sent, failed }), { headers: { 'Content-Type': 'application/json' } });
});
