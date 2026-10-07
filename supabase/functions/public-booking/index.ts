// Edge Function: the public booking page (T-35) — no sign-in.
//
//   GET  /public-booking/:slug                      clinic, bookable types, regions
//   GET  /public-booking/:slug/slots?type_id&from&to free start times (local dates)
//   POST /public-booking/:slug/request              details → e-mail code
//   POST /public-booking/:slug/confirm              { request_id, code, starts_at? }
//   POST /public-booking/:slug/resend               { request_id } → new code
//   GET  /public-booking/manage/:token              the appointment behind a manage link
//   POST /public-booking/manage/:token/cancel       cancel within policy
//   GET  /public-booking/ics/:token                 calendar file for the appointment
//
// Anything that sends e-mail or tests a code is rate-limited per hashed IP
// (and per address / clinic where it matters); the database caps code
// attempts and resends per request. Nothing here needs or reads a session.
//
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { hashKey, ipKey, rateLimit } from '../_shared/rate-limit.ts';
import { emailConfigured } from '../_shared/email.ts';
import { buildIcs, codeHash, generateCode, icsStatus, isUuid, json, manageToken, manageUrl, parseManageToken, statusFor } from '../_shared/booking.ts';
import { sendBookingEmail, sendCodeEmail } from '../_shared/booking-emails.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CONSENT_VERSION = 'booking-v1';
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  const out = (t.startsWith('+') ? '+' : '') + t.replace(/\D/g, '');
  return /^\+?[0-9]{9,15}$/.test(out) ? out : null;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function fail(code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, ...extra }, statusFor(code));
}

Deno.serve(withCors(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const rest = parts.slice(parts.indexOf('public-booking') + 1);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const ip = await ipKey(req);
  const rpc = (fn: string, args: Record<string, unknown>) => svc.schema('app').rpc(fn, args);

  // --- manage links --------------------------------------------------------
  if (rest[0] === 'manage' || rest[0] === 'ics') {
    const limited = await rateLimit(svc, `booking-manage:ip:${ip}`, 60, 600);
    if (limited) return limited;
    const ids = await parseManageToken(rest[1] ?? '');
    if (!ids) return fail('not_found');

    if (req.method === 'GET' && rest.length === 2) {
      const { data, error } = await rpc('public_appointment', { p_clinic_id: ids.clinicId, p_appointment_id: ids.appointmentId });
      if (error) return json({ error: 'internal_error', details: error.message }, 500);
      if (data?.error) return fail(data.error);

      if (rest[0] === 'ics') {
        const a = data.appointment;
        const ics = buildIcs({
          uid: a.id,
          start: new Date(a.starts_at),
          end: new Date(a.ends_at),
          summary: `${a.type.name} · ${data.clinic.name}`,
          location: data.clinic.address,
          description: `לשינוי או ביטול: ${manageUrl(rest[1])}`,
          sequence: 0,
          status: icsStatus(a.status),
        });
        return new Response(ics, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': 'attachment; filename="appointment.ics"',
          },
        });
      }
      return json(data);
    }

    if (req.method === 'POST' && rest[0] === 'manage' && rest[2] === 'cancel') {
      const limitedCancel = await rateLimit(svc, `booking-cancel:ip:${ip}`, 10, 3600);
      if (limitedCancel) return limitedCancel;
      const { data, error } = await rpc('public_appointment_cancel', { p_clinic_id: ids.clinicId, p_appointment_id: ids.appointmentId });
      if (error) return json({ error: 'internal_error', details: error.message }, 500);
      if (data?.error) return fail(data.error, data.free_cancel_hours != null ? { free_cancel_hours: data.free_cancel_hours } : {});
      return json(data);
    }
    return fail('not_found');
  }

  // --- the booking page ------------------------------------------------------
  const slug = (rest[0] ?? '').toLowerCase();
  if (!SLUG.test(slug)) return fail('not_found');

  if (req.method === 'GET' && rest.length === 1) {
    const limited = await rateLimit(svc, `booking-read:ip:${ip}`, 120, 600);
    if (limited) return limited;
    const { data, error } = await rpc('public_booking_profile', { p_slug: slug });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return fail(data.error);
    return json({ ...data, consent_version: CONSENT_VERSION });
  }

  if (req.method === 'GET' && rest[1] === 'slots') {
    const limited = await rateLimit(svc, `booking-read:ip:${ip}`, 120, 600);
    if (limited) return limited;
    const typeId = url.searchParams.get('type_id');
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isUuid(typeId) || !DATE.test(from) || !DATE.test(to)) return fail('validation_failed');
    const { data, error } = await rpc('public_booking_slots', { p_slug: slug, p_type_id: typeId, p_from: from, p_to: to });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return fail(data.error);
    return json(data);
  }

  if (req.method !== 'POST') return fail('not_found');
  const body = await readJson(req);
  if (!body) return fail('validation_failed');

  if (rest[1] === 'request') {
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!email || !phone || name.length < 2 || name.length > 80 || body.consent !== true
        || !isUuid(body.type_id) || typeof body.starts_at !== 'string'
        || (body.body_region_id != null && !isUuid(body.body_region_id))) {
      return fail('validation_failed');
    }
    if (!emailConfigured()) {
      return json({ error: 'email_failed', details: 'e-mail transport not configured' }, 503);
    }
    for (const [bucket, limit, window] of [
      [`booking-request:ip:${ip}`, 10, 3600],
      [`booking-request:email:${await hashKey(email)}`, 3, 3600],
      [`booking-request:clinic:${slug}`, 60, 3600],
    ] as const) {
      const limited = await rateLimit(svc, bucket, limit, window);
      if (limited) return limited;
    }

    const code = generateCode();
    const { data, error } = await rpc('public_booking_request', {
      p_slug: slug,
      p_input: {
        type_id: body.type_id,
        starts_at: body.starts_at,
        name,
        phone,
        email,
        body_region_id: body.body_region_id ?? null,
        consent: true,
        consent_version: CONSENT_VERSION,
      },
      p_code_hash: await codeHash(code),
      p_ip_hash: ip,
    });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return fail(data.error);

    const { data: profile } = await rpc('public_booking_profile', { p_slug: slug });
    try {
      await sendCodeEmail(email, code, profile?.clinic?.name ?? 'ReCOVR');
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', fn: 'public-booking', msg: 'code e-mail failed', details: e instanceof Error ? e.message : String(e) }));
      return json({ error: 'email_failed' }, 502);
    }
    return json({ request_id: data.request_id, email }, 201);
  }

  if (rest[1] === 'confirm') {
    const limited = await rateLimit(svc, `booking-confirm:ip:${ip}`, 30, 600);
    if (limited) return limited;
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : '';
    if (!isUuid(body.request_id) || code.length !== 6
        || (body.starts_at != null && typeof body.starts_at !== 'string')) {
      return fail('validation_failed');
    }
    const { data, error } = await rpc('public_booking_confirm', {
      p_slug: slug,
      p_request_id: body.request_id,
      p_code_hash: await codeHash(code),
      p_starts_at: body.starts_at ?? null,
    });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return fail(data.error, data.attempts_left != null ? { attempts_left: data.attempts_left } : {});

    if (!data.repeat) {
      await sendBookingEmail(svc, data.clinic_id, data.appointment_id, data.status === 'confirmed' ? 'confirmed' : 'received');
    }
    const token = await manageToken(data.clinic_id, data.appointment_id);
    const { data: appt } = await rpc('public_appointment', { p_clinic_id: data.clinic_id, p_appointment_id: data.appointment_id });
    return json({ status: data.status, token, appointment: appt?.appointment ?? null, clinic: appt?.clinic ?? null });
  }

  if (rest[1] === 'resend') {
    const limited = await rateLimit(svc, `booking-resend:ip:${ip}`, 10, 3600);
    if (limited) return limited;
    if (!isUuid(body.request_id)) return fail('validation_failed');
    const code = generateCode();
    const { data, error } = await rpc('public_booking_resend', {
      p_slug: slug,
      p_request_id: body.request_id,
      p_code_hash: await codeHash(code),
    });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return fail(data.error);
    const { data: profile } = await rpc('public_booking_profile', { p_slug: slug });
    try {
      await sendCodeEmail(data.email, code, profile?.clinic?.name ?? 'ReCOVR');
    } catch {
      return json({ error: 'email_failed' }, 502);
    }
    return json({ ok: true });
  }

  return fail('not_found');
}));
