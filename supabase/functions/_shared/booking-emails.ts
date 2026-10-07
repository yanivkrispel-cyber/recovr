// Booking e-mails (Hebrew, RTL). They go to the person the appointment is
// for, and — like every e-mail here (CLAUDE.md rule 9) — carry no name and
// nothing clinical: the time, the appointment type, the clinic's contact
// details and links. The context comes from app.appointment_email_context.
//
// deno-lint-ignore-file no-explicit-any

import { sendEmail } from './email.ts';
import { bookingPageUrl, buildIcs, EMAIL_LOGO_URL, manageToken, manageUrl } from './booking.ts';

export type BookingEmailKind = 'received' | 'confirmed' | 'declined' | 'moved' | 'cancelled' | 'reminder';

interface EmailContext {
  appointment_id: string;
  clinic_id: string;
  to: string | null;
  status: string;
  starts_at: string;
  ends_at: string;
  updated_at: string;
  type_name: string;
  free_cancel_hours: number;
  clinic: { name: string; address: string | null; phone: string | null; timezone: string; booking_slug: string | null };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function day(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}

function time(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

const NAVY = '#1B2140';
const INK = '#221c14';
const MUTED = '#6b6459';

function button(href: string, label: string): string {
  return (
    `<p style="margin:22px 0"><a href="${esc(href)}" style="display:inline-block;background:${NAVY};color:#fff;` +
    `padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`
  );
}

function detailRows(c: EmailContext): [string, string][] {
  const tz = c.clinic.timezone;
  const rows: [string, string][] = [
    ['מתי', `${day(c.starts_at, tz)} · ${time(c.starts_at, tz)}–${time(c.ends_at, tz)}`],
    ['סוג', c.type_name],
    ['איפה', [c.clinic.name, c.clinic.address].filter(Boolean).join(', ')],
  ];
  if (c.clinic.phone) rows.push(['טלפון', c.clinic.phone]);
  return rows;
}

function layout(c: EmailContext, heading: string, intro: string, opts: { details?: boolean; cta?: [string, string]; notes?: string[] }) {
  const rows = opts.details === false ? [] : detailRows(c);
  const html =
    `<div dir="rtl" style="font-family:system-ui,Arial;max-width:520px;margin:0 auto;font-size:15px;color:${INK};line-height:1.55">` +
    `<p style="margin:0 0 22px"><img src="${EMAIL_LOGO_URL}" alt="ReCOVR" width="160" style="display:block;height:auto;border:0"></p>` +
    `<h2 style="font-size:19px;margin:0 0 10px">${esc(heading)}</h2>` +
    `<p style="margin:0 0 16px">${esc(intro)}</p>` +
    (rows.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:15px;background:#FBF8F1;border:1px solid #DBD2BF;border-radius:10px">` +
        rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:10px 14px;color:${MUTED};white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
              `<td style="padding:10px 14px;font-weight:600">${esc(v)}</td></tr>`,
          )
          .join('') +
        `</table>`
      : '') +
    (opts.cta ? button(opts.cta[0], opts.cta[1]) : '') +
    (opts.notes ?? []).map((n) => `<p style="font-size:13px;color:${MUTED};margin:8px 0">${esc(n)}</p>`).join('') +
    `<p style="font-size:12px;color:#9b9b9b;margin-top:24px">המייל נשלח בעקבות קביעת תור ב-${esc(c.clinic.name)} ואינו כולל מידע רפואי.</p>` +
    `</div>`;

  const text = [
    heading,
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(opts.cta ? ['', `${opts.cta[1]}: ${opts.cta[0]}`] : []),
    ...(opts.notes?.length ? ['', ...opts.notes] : []),
  ].join('\n');

  return { html, text };
}

function invite(c: EmailContext, status: 'confirmed' | 'cancelled', link: string | null): string {
  return buildIcs({
    uid: c.appointment_id,
    start: new Date(c.starts_at),
    end: new Date(c.ends_at),
    summary: `${c.type_name} · ${c.clinic.name}`,
    location: c.clinic.address,
    description: link ? `לשינוי או ביטול: ${link}` : null,
    sequence: Math.floor(new Date(c.updated_at).getTime() / 1000),
    status,
  });
}

export function codeEmail(code: string, clinicName: string): { subject: string; html: string; text: string } {
  const subject = `קוד האימות שלך: ${code}`;
  const html =
    `<div dir="rtl" style="font-family:system-ui,Arial;max-width:520px;margin:0 auto;font-size:15px;color:${INK}">` +
    `<p style="margin:0 0 22px"><img src="${EMAIL_LOGO_URL}" alt="ReCOVR" width="160" style="display:block;height:auto;border:0"></p>` +
    `<h2 style="font-size:19px;margin:0 0 10px">קוד אימות לקביעת התור</h2>` +
    `<p>הקלידו את הקוד בדף קביעת התור של ${esc(clinicName)}:</p>` +
    `<p style="font-size:32px;font-weight:700;letter-spacing:8px;direction:ltr;text-align:right;margin:18px 0">${code}</p>` +
    `<p style="font-size:13px;color:${MUTED}">הקוד בתוקף ל-15 דקות. אם לא ביקשת לקבוע תור, אפשר להתעלם מהמייל.</p>` +
    `</div>`;
  const text = `קוד האימות לקביעת התור ב-${clinicName}: ${code}\nהקוד בתוקף ל-15 דקות. אם לא ביקשת לקבוע תור, אפשר להתעלם מהמייל.`;
  return { subject, html, text };
}

export async function sendCodeEmail(to: string, code: string, clinicName: string): Promise<void> {
  await sendEmail({ to, ...codeEmail(code, clinicName) });
}

/**
 * Sends the e-mail for `kind` about one appointment. Returns false when there
 * is nobody to send to (no address on file) or sending failed — the booking
 * change itself has already been saved either way.
 */
export async function sendBookingEmail(
  service: any,
  clinicId: string,
  appointmentId: string,
  kind: BookingEmailKind,
): Promise<boolean> {
  const { data: c, error } = await service.schema('app').rpc('appointment_email_context', {
    p_clinic_id: clinicId,
    p_appointment_id: appointmentId,
  });
  if (error || !c?.to) return false;
  const ctx = c as EmailContext;

  const link = manageUrl(await manageToken(clinicId, appointmentId));
  const bookAgain = ctx.clinic.booking_slug ? bookingPageUrl(ctx.clinic.booking_slug) : null;
  const cancelNote = ctx.free_cancel_hours > 0
    ? `אפשר לשנות מועד או לבטל דרך הקישור עד ${ctx.free_cancel_hours} שעות לפני התור.`
    : 'לשינוי מועד או ביטול אפשר להשתמש בקישור.';
  // Still inside the self-service window? (A late reminder may not be.)
  const changeable = new Date(ctx.starts_at).getTime() - Date.now() > ctx.free_cancel_hours * 3_600_000;

  let subject: string;
  let body: { html: string; text: string };
  let attachment: string | null = null;

  switch (kind) {
    case 'received':
      subject = `קיבלנו את בקשתך לתור · ${day(ctx.starts_at, ctx.clinic.timezone)}`;
      body = layout(ctx, 'הבקשה התקבלה', 'קיבלנו את בקשתך לתור. נשלח מייל ברגע שהתור יאושר.', {
        cta: [link, 'צפייה בבקשה או ביטולה'],
      });
      break;
    case 'confirmed':
      subject = `התור שלך נקבע · ${day(ctx.starts_at, ctx.clinic.timezone)} ${time(ctx.starts_at, ctx.clinic.timezone)}`;
      body = layout(ctx, 'התור נקבע', 'מחכים לך. הוספנו קובץ יומן כדי שהתור יופיע ביומן שלך.', {
        cta: [link, 'צפייה בתור, שינוי מועד או ביטול'],
        notes: [cancelNote],
      });
      attachment = invite(ctx, 'confirmed', link);
      break;
    case 'reminder':
      subject = `תזכורת: התור שלך ${day(ctx.starts_at, ctx.clinic.timezone)} ${time(ctx.starts_at, ctx.clinic.timezone)}`;
      body = layout(ctx, 'תזכורת לתור', 'רצינו להזכיר שמחכים לך:', {
        cta: [link, changeable ? 'צפייה בתור, שינוי מועד או ביטול' : 'צפייה בתור'],
        notes: changeable
          ? [cancelNote]
          : [ctx.clinic.phone ? `לשינוי או ביטול בשלב הזה צריך לפנות למרפאה: ${ctx.clinic.phone}` : 'לשינוי או ביטול בשלב הזה צריך לפנות למרפאה.'],
      });
      break;
    case 'moved':
      subject = `מועד התור שלך השתנה · ${day(ctx.starts_at, ctx.clinic.timezone)} ${time(ctx.starts_at, ctx.clinic.timezone)}`;
      body = layout(ctx, 'מועד התור עודכן', 'המועד החדש של התור שלך:', {
        cta: [link, 'צפייה בתור או ביטולו'],
        notes: ['קובץ היומן המצורף מעדכן את המועד ביומן שלך.'],
      });
      attachment = invite(ctx, 'confirmed', link);
      break;
    case 'declined':
      subject = 'לא נוכל לקיים את התור שביקשת';
      body = layout(ctx, 'הבקשה לא אושרה', 'לצערנו לא נוכל לקיים את התור במועד שביקשת.', {
        cta: bookAgain ? [bookAgain, 'בחירת מועד אחר'] : undefined,
        notes: ctx.clinic.phone ? [`לבירורים: ${ctx.clinic.phone}`] : [],
      });
      break;
    case 'cancelled':
      subject = `התור שלך בוטל · ${day(ctx.starts_at, ctx.clinic.timezone)}`;
      body = layout(ctx, 'התור בוטל', 'התור הבא בוטל:', {
        cta: bookAgain ? [bookAgain, 'קביעת תור חדש'] : undefined,
        notes: ctx.clinic.phone ? [`לבירורים: ${ctx.clinic.phone}`] : [],
      });
      attachment = invite(ctx, 'cancelled', null);
      break;
  }

  try {
    await sendEmail({
      to: ctx.to!,
      subject,
      html: body.html,
      text: body.text,
      attachments: attachment ? [{ filename: 'appointment.ics', contentType: 'text/calendar; method=' + (kind === 'cancelled' ? 'CANCEL' : 'PUBLISH'), content: attachment }] : undefined,
    });
    return true;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'booking e-mail failed', kind, details: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}
