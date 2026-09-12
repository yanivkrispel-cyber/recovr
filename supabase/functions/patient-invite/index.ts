// Edge Function: POST /patients (invite part — full create+assign-protocol
// flow per API_CONTRACT.md is M1 T-07 territory; this covers only what
// T-03 needs: create the patient stub and send an invite).
//
// On success it emails the activation link to the address the clinician
// entered. The email carries only the clinician's name and the tokenised
// link — no patient name, no clinical values (CLAUDE.md rule #9). SMTP is
// best-effort: if it fails the call still returns 201 with invite_url so the
// clinician can copy the link manually.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { sendViaGmail } from '../_shared/gmail-smtp.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'http://localhost:5173';
// Where the patient PWA is served. Prod: same host as APP_BASE_URL (paths
// /app and /m). Local dev: the patient vite server on its own port.
const PATIENT_BASE_URL = Deno.env.get('PATIENT_BASE_URL') ?? APP_BASE_URL;
// Prod: Gmail SMTP relay (GMAIL_SMTP_USER/PASSWORD — see _shared/gmail-smtp.ts).
// Local dev: falls back to the raw SMTP relay (Inbucket) below when unset.
const GMAIL_CONFIGURED = !!(Deno.env.get('GMAIL_SMTP_USER') && Deno.env.get('GMAIL_SMTP_PASSWORD'));
const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '2500');
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? 'ReCOVR <invite@recoveryos.local>';

interface Input {
  name: string;
  email: string;
  // When protocol_id is present, create the patient with a plan assigned
  // (T-07 "Add patient" wizard). Without it, the minimal invite-only path.
  protocol_id?: string;
  start_phase_n?: number;
  excluded_exercise_ids?: string[];
  // The "Other" injury path: a free-text condition plus hand-picked exercises,
  // no protocol. Used only when protocol_id is absent.
  condition?: string;
  custom_exercise_ids?: string[];
}

function addrOnly(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from.trim();
}

function b64utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

// base64 the UTF-8 bytes, wrapped at 76 chars (RFC 2045) — sending raw 8-bit
// Hebrew over SMTP leaves the charset ambiguous and mail parsers fall back to
// Latin-1 (mojibake).
function b64Body(s: string): string {
  return (b64utf8(s).match(/.{1,76}/g) ?? []).join('\r\n');
}

function inviteEmailHtml(clinicianName: string, inviteUrl: string): string {
  return (
    `<div dir="rtl" style="font-family:system-ui,Arial;max-width:520px;margin:0 auto;font-size:15px;color:#221c14">` +
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;letter-spacing:0.5px;margin:0 0 18px">` +
    `<span style="color:#C9A24B">Re</span><span style="color:#1B2140">COVR</span>` +
    `<span style="color:#1B2140;font-size:14px;font-weight:400"> &nbsp;by krispel</span></p>` +
    `<h2 style="font-size:18px">הפעלת החשבון שלך</h2>` +
    `<p>${clinicianName} הזמין/ה אותך לעקוב אחרי תוכנית השיקום שלך ב-ReCOVR.</p>` +
    `<p><a href="${inviteUrl}" style="display:inline-block;background:#1B2140;color:#fff;` +
    `padding:11px 20px;border-radius:8px;text-decoration:none">הפעלת החשבון</a></p>` +
    `<p style="font-size:13px;color:#6b6459">או פתח/י את הקישור: <br>${inviteUrl}</p>` +
    `<p style="font-size:12px;color:#9b9b9b">הקישור תקף ל-7 ימים. אם לא ציפית להזמנה זו, אפשר להתעלם ממנה.</p>` +
    `</div>`
  );
}

// Prod path: Gmail's SMTP relay (authenticated, TLS) — see _shared/gmail-smtp.ts.
async function sendInviteEmailViaGmail(to: string, clinicianName: string, inviteUrl: string): Promise<void> {
  const subject = 'הזמנה להפעלת חשבון ReCOVR';
  const html = inviteEmailHtml(clinicianName, inviteUrl);
  await sendViaGmail(to, subject, html);
}

// Local-dev-only path: minimal plain SMTP over raw TCP against the Inbucket
// relay — no AUTH / STARTTLS, will not work against a real mail provider.
async function sendInviteEmailViaSmtp(to: string, clinicianName: string, inviteUrl: string): Promise<void> {
  if (!SMTP_HOST) throw new Error('SMTP not configured');

  const conn = await Deno.connect({ hostname: SMTP_HOST, port: SMTP_PORT });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(2048);

  const read = async (): Promise<string> => {
    const n = await conn.read(buf);
    return dec.decode(buf.subarray(0, n ?? 0));
  };
  const cmd = async (line: string, expect: RegExp): Promise<void> => {
    await conn.write(enc.encode(line + '\r\n'));
    const reply = await read();
    if (!expect.test(reply)) throw new Error(`SMTP: expected ${expect}, got ${reply.trim()}`);
  };

  try {
    const greeting = await read();
    if (!/^220/.test(greeting)) throw new Error(`SMTP greeting: ${greeting.trim()}`);

    const from = addrOnly(SMTP_FROM);
    await cmd('EHLO recoveryos', /^250/);
    await cmd(`MAIL FROM:<${from}>`, /^250/);
    await cmd(`RCPT TO:<${to}>`, /^25[05]/);
    await cmd('DATA', /^354/);

    const subject = 'הזמנה להפעלת חשבון ReCOVR';
    const html = inviteEmailHtml(clinicianName, inviteUrl);
    const message =
      `From: ${SMTP_FROM}\r\n` +
      `To: <${to}>\r\n` +
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${b64Body(html)}\r\n.`;
    await cmd(message, /^250/);
    await conn.write(enc.encode('QUIT\r\n'));
  } finally {
    conn.close();
  }
}

async function sendInviteEmail(to: string, clinicianName: string, inviteUrl: string): Promise<void> {
  if (GMAIL_CONFIGURED) return sendInviteEmailViaGmail(to, clinicianName, inviteUrl);
  return sendInviteEmailViaSmtp(to, clinicianName, inviteUrl);
}

Deno.serve(withCors(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('Authorization')!;
  const token = authHeader.replace('Bearer ', '');

  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const { data: roleRow } = await userClient
    .schema('app')
    .from('user')
    .select('role, name')
    .eq('id', user.id)
    .single();
  if (!roleRow || !['clinician', 'admin'].includes(roleRow.role)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const body: Input = await req.json();
  if (!body.name || !body.email) {
    return new Response(JSON.stringify({ error: 'validation_failed' }), { status: 422 });
  }

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: result, error } = body.protocol_id
    ? await service.schema('app').rpc('create_patient_with_plan', {
        p_clinician_id: user.id,
        p_name: body.name,
        p_email: body.email,
        p_protocol_id: body.protocol_id,
        p_start_phase_n: body.start_phase_n ?? 1,
        p_excluded_exercise_ids: body.excluded_exercise_ids ?? [],
      })
    : body.condition
      ? await service.schema('app').rpc('create_patient_with_custom_plan', {
          p_clinician_id: user.id,
          p_name: body.name,
          p_email: body.email,
          p_condition: body.condition,
          p_exercise_ids: body.custom_exercise_ids ?? [],
        })
      : await service.schema('app').rpc('invite_patient', {
          p_clinician_id: user.id,
          p_name: body.name,
          p_email: body.email,
        });

  if (error) {
    return new Response(JSON.stringify({ error: 'internal_error', details: error.message }), { status: 500 });
  }
  if (result?.error) {
    const status = result.error === 'forbidden'
      ? 403
      : result.error === 'validation_failed'
        ? 422
        : 404;
    return new Response(JSON.stringify({ error: result.error }), { status });
  }

  const inviteUrl = `${PATIENT_BASE_URL}/m/invite/${result.invite_token}`;

  let emailed = false;
  try {
    await sendInviteEmail(body.email, roleRow.name ?? 'המטפל/ת שלך', inviteUrl);
    emailed = true;
  } catch (e) {
    console.error('[patient-invite] email send failed:', e instanceof Error ? e.message : e);
  }

  return new Response(JSON.stringify({ ...result, invite_url: inviteUrl, emailed }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}));
