// Edge Function: the clinician's calendar and its setup (T-34 / T-35).
//
//   GET    /scheduling/setup                      settings, types, weekly hours, practitioners
//   PATCH  /scheduling/settings                   booking rules + public page
//   POST   /scheduling/types                      create / update an appointment type
//   PUT    /scheduling/availability               { practitioner_id?, rules } replace weekly hours
//   GET    /scheduling/calendar?from&to           appointments + blocked time (ISO instants)
//   POST   /scheduling/appointments               book a patient            { …, notify? }
//   PATCH  /scheduling/appointments/:id           move / status / note      { …, notify? }
//   POST   /scheduling/time-off                   block time
//   DELETE /scheduling/time-off/:id
//   GET    /scheduling/requests[?count=1]         pending requests (website + app)
//   POST   /scheduling/requests/:id/link          { patient_id } tie a website request to a card
//
// A booking change that the patient should hear about (approved, declined,
// moved, cancelled, or a new booking made for them) is e-mailed unless the
// request says notify: false; the response reports `emailed`.

import { createClient } from 'jsr:@supabase/supabase-js@2.45.0';
import { withCors } from '../_shared/cors.ts';
import { getAuthUser } from '../_shared/auth.ts';
import { requireMfa } from '../_shared/mfa.ts';
import { rateLimit } from '../_shared/rate-limit.ts';
import { isUuid, json, statusFor } from '../_shared/booking.ts';
import { sendBookingEmail, type BookingEmailKind } from '../_shared/booking-emails.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const EMAIL_FOR_CHANGE: Record<string, BookingEmailKind> = {
  confirmed: 'confirmed',
  declined: 'declined',
  cancelled: 'cancelled',
  moved: 'moved',
};

Deno.serve(withCors(async (req) => {
  const user = await getAuthUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const mfaRefusal = await requireMfa(req, user);
  if (mfaRefusal) return mfaRefusal;

  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const rpc = (fn: string, args: Record<string, unknown>) => svc.schema('app').rpc(fn, args);
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const rest = parts.slice(parts.indexOf('scheduling') + 1);
  const [resource, id, action] = rest;

  const reply = (data: { error?: string } | null, error: { message: string } | null, okStatus = 200) => {
    if (error) return json({ error: 'internal_error', details: error.message }, 500);
    if (data?.error) return json(data, statusFor(data.error));
    return json(data, okStatus);
  };

  const body = async (): Promise<Record<string, unknown> | null> => {
    try {
      const b = await req.json();
      return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
    } catch {
      return null;
    }
  };

  // Booking changes e-mail the patient; cap it so a compromised session
  // can't turn the calendar into a mail cannon.
  const mayEmail = async () => (await rateLimit(svc, `sched-email:user:${user.id}`, 120, 3600)) === null;

  if (req.method === 'GET' && resource === 'setup') {
    const { data, error } = await rpc('scheduling_setup', { p_clinician_id: user.id });
    return reply(data, error);
  }

  if (req.method === 'PATCH' && resource === 'settings') {
    const patch = await body();
    if (!patch) return json({ error: 'validation_failed' }, 422);
    const { data, error } = await rpc('scheduling_update_settings', { p_clinician_id: user.id, p_patch: patch });
    return reply(data, error);
  }

  if (req.method === 'POST' && resource === 'types') {
    const type = await body();
    if (!type) return json({ error: 'validation_failed' }, 422);
    const { data, error } = await rpc('appointment_type_save', { p_clinician_id: user.id, p_type: type });
    return reply(data, error);
  }

  if (req.method === 'PUT' && resource === 'availability') {
    const b = await body();
    if (!b || !Array.isArray(b.rules) || (b.practitioner_id != null && !isUuid(b.practitioner_id))) {
      return json({ error: 'validation_failed' }, 422);
    }
    const { data, error } = await rpc('availability_save', {
      p_clinician_id: user.id,
      p_practitioner_id: b.practitioner_id ?? null,
      p_rules: b.rules,
    });
    return reply(data, error);
  }

  if (req.method === 'GET' && resource === 'calendar') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return json({ error: 'validation_failed' }, 422);
    }
    const { data, error } = await rpc('calendar_range', { p_clinician_id: user.id, p_from: from, p_to: to });
    return reply(data, error);
  }

  if (req.method === 'POST' && resource === 'appointments' && !id) {
    const b = await body();
    if (!b) return json({ error: 'validation_failed' }, 422);
    const { notify, ...input } = b;
    const { data, error } = await rpc('appointment_create', { p_clinician_id: user.id, p_input: input });
    if (error || data?.error) return reply(data, error);
    const emailed = notify === false || !(await mayEmail())
      ? null
      : await sendBookingEmail(svc, data.clinic_id, data.appointment.id, 'confirmed');
    return json({ appointment: data.appointment, emailed }, 201);
  }

  if (req.method === 'PATCH' && resource === 'appointments' && isUuid(id)) {
    const b = await body();
    if (!b) return json({ error: 'validation_failed' }, 422);
    const { notify, ...patch } = b;
    const { data, error } = await rpc('appointment_update', { p_clinician_id: user.id, p_appointment_id: id, p_patch: patch });
    if (error || data?.error) return reply(data, error);
    const kind = data.change ? EMAIL_FOR_CHANGE[data.change] : undefined;
    const emailed = !kind || notify === false || !(await mayEmail())
      ? null
      : await sendBookingEmail(svc, data.clinic_id, id, kind);
    return json({ appointment: data.appointment, change: data.change, emailed });
  }

  if (req.method === 'POST' && resource === 'time-off' && !id) {
    const b = await body();
    if (!b) return json({ error: 'validation_failed' }, 422);
    const { data, error } = await rpc('time_off_create', { p_clinician_id: user.id, p_input: b });
    return reply(data, error, 201);
  }

  if (req.method === 'DELETE' && resource === 'time-off' && isUuid(id)) {
    const { data, error } = await rpc('time_off_delete', { p_clinician_id: user.id, p_time_off_id: id });
    return reply(data, error);
  }

  if (req.method === 'GET' && resource === 'requests') {
    const counting = url.searchParams.get('count') === '1';
    const { data, error } = await rpc(counting ? 'booking_requests_count' : 'booking_requests', { p_clinician_id: user.id });
    return reply(data, error);
  }

  if (req.method === 'POST' && resource === 'requests' && isUuid(id) && action === 'link') {
    const b = await body();
    if (!b || !isUuid(b.patient_id)) return json({ error: 'validation_failed' }, 422);
    const { data, error } = await rpc('booking_link_patient', { p_clinician_id: user.id, p_request_id: id, p_patient_id: b.patient_id });
    return reply(data, error);
  }

  return json({ error: 'not_found' }, 404);
}));
