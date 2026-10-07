// Edge Function: the signed-in patient's appointments (T-35).
//
//   GET  /me-appointments                          upcoming + recent, bookable types, policy
//   GET  /me-appointments/slots?type_id&from&to    free start times (local dates)
//   POST /me-appointments           { type_id, starts_at }  book
//   POST /me-appointments/:id/cancel                cancel within policy
//   GET  /me-appointments/:id/ics                   calendar file
//
// The practitioner is the patient's primary clinician; the slot rules are
// the clinic's (app._sched_free_slots), enforced again when booking.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getAuthUser } from '../_shared/auth.ts';
import { rateLimit } from '../_shared/rate-limit.ts';
import { buildIcs, icsStatus, isUuid, json, statusFor } from '../_shared/booking.ts';
import { sendBookingEmail } from '../_shared/booking-emails.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PatientAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  type: { name: string };
}

Deno.serve(withCors(async (req) => {
  const user = await getAuthUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const rpc = (fn: string, args: Record<string, unknown>) => svc.schema('app').rpc(fn, args);
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const rest = parts.slice(parts.indexOf('me-appointments') + 1);

  const reply = (data: { error?: string } | null, error: { message: string } | null, okStatus = 200) => {
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return json(data, statusFor(data.error));
    return json(data, okStatus);
  };

  if (req.method === 'GET' && rest.length === 0) {
    const { data, error } = await rpc('me_appointments', { p_patient_auth_id: user.id });
    return reply(data, error);
  }

  if (req.method === 'GET' && rest[0] === 'slots') {
    const typeId = url.searchParams.get('type_id');
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isUuid(typeId) || !DATE.test(from) || !DATE.test(to)) return json({ error: 'validation_failed' }, 422);
    const { data, error } = await rpc('me_appointment_slots', {
      p_patient_auth_id: user.id, p_type_id: typeId, p_from: from, p_to: to,
    });
    return reply(data, error);
  }

  if (req.method === 'GET' && rest.length === 2 && rest[1] === 'ics' && isUuid(rest[0])) {
    const { data, error } = await rpc('me_appointments', { p_patient_auth_id: user.id });
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return json(data, statusFor(data.error));
    const appt = (data.upcoming as PatientAppointment[]).find((a) => a.id === rest[0]);
    if (!appt) return json({ error: 'not_found' }, 404);
    const ics = buildIcs({
      uid: appt.id,
      start: new Date(appt.starts_at),
      end: new Date(appt.ends_at),
      summary: `${appt.type.name} · ${data.clinic.name}`,
      location: data.clinic.address,
      sequence: 0,
      status: icsStatus(appt.status),
    });
    return new Response(ics, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="appointment.ics"' },
    });
  }

  if (req.method === 'POST' && rest.length === 0) {
    const limited = await rateLimit(svc, `me-book:user:${user.id}`, 20, 3600);
    if (limited) return limited;
    let body: { type_id?: unknown; starts_at?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'validation_failed' }, 422);
    }
    if (!isUuid(body.type_id) || typeof body.starts_at !== 'string') return json({ error: 'validation_failed' }, 422);

    const { data, error } = await rpc('me_appointment_book', {
      p_patient_auth_id: user.id, p_type_id: body.type_id, p_starts_at: body.starts_at,
    });
    if (error || data?.error) return reply(data, error);
    const emailed = await sendBookingEmail(svc, data.clinic_id, data.appointment.id,
      data.appointment.status === 'confirmed' ? 'confirmed' : 'received');
    return json({ appointment: data.appointment, emailed }, 201);
  }

  if (req.method === 'POST' && rest.length === 2 && rest[1] === 'cancel' && isUuid(rest[0])) {
    const { data, error } = await rpc('me_appointment_cancel', { p_patient_auth_id: user.id, p_appointment_id: rest[0] });
    return reply(data, error);
  }

  return json({ error: 'not_found' }, 404);
}));
