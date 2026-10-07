// Booking API for the patient app: the public booking page and manage link
// (edge function `public-booking`, no session) and the signed-in patient's
// appointments (`me-appointments`). Errors carry the server's code so the
// screens can say exactly what happened (slot taken, wrong code, …).
import { FunctionsHttpError } from '@supabase/functions-js';
import type { BookableType, ClinicContact, MyAppointments, PatientAppointment, PublicBookingProfile } from 'shared';
import { supabase } from './supabase';

export class BookingError extends Error {
  constructor(
    public code: string,
    public payload: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

async function invoke<T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(path, { method, body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = await (error.context as Response).json().catch(() => null);
      throw new BookingError(typeof payload?.error === 'string' ? payload.error : 'internal_error', payload ?? {});
    }
    throw new BookingError('network');
  }
  return data as T;
}

// --- public page ---------------------------------------------------------------------

export type Profile = PublicBookingProfile & { consent_version: string };

export const publicBooking = {
  profile: (slug: string) => invoke<Profile>(`public-booking/${slug}`, 'GET'),

  slots: async (slug: string, typeId: string, from: string, to: string) =>
    (await invoke<{ slots: string[] }>(`public-booking/${slug}/slots?type_id=${typeId}&from=${from}&to=${to}`, 'GET')).slots,

  request: (
    slug: string,
    input: { type_id: string; starts_at: string; name: string; phone: string; email: string; body_region_id: string | null; consent: true },
  ) => invoke<{ request_id: string; email: string }>(`public-booking/${slug}/request`, 'POST', input),

  confirm: (slug: string, input: { request_id: string; code: string; starts_at?: string }) =>
    invoke<{ status: 'pending' | 'confirmed'; token: string; appointment: PatientAppointment | null; clinic: ClinicContact | null }>(
      `public-booking/${slug}/confirm`,
      'POST',
      input,
    ),

  resend: (slug: string, requestId: string) => invoke<{ ok: true }>(`public-booking/${slug}/resend`, 'POST', { request_id: requestId }),

  manage: (token: string) =>
    invoke<{ appointment: PatientAppointment; clinic: ClinicContact; free_cancel_hours: number }>(`public-booking/manage/${token}`, 'GET'),

  cancel: (token: string) => invoke<{ appointment: PatientAppointment }>(`public-booking/manage/${token}/cancel`, 'POST'),
};

/** The .ics download for a manage-link appointment (no session needed). */
export function publicIcsUrl(token: string): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/public-booking/ics/${token}`;
}

// --- signed-in patient ---------------------------------------------------------------

export const MY_APPOINTMENTS_KEY = ['me-appointments'] as const;

export const myAppointments = {
  list: () => invoke<MyAppointments>('me-appointments', 'GET'),

  slots: async (typeId: string, from: string, to: string) =>
    (await invoke<{ slots: string[] }>(`me-appointments/slots?type_id=${typeId}&from=${from}&to=${to}`, 'GET')).slots,

  book: (typeId: string, startsAt: string) =>
    invoke<{ appointment: PatientAppointment; emailed: boolean }>('me-appointments', 'POST', { type_id: typeId, starts_at: startsAt }),

  cancel: (id: string) => invoke<{ appointment: PatientAppointment }>(`me-appointments/${id}/cancel`, 'POST'),

  /** .ics needs the session's bearer, so it's fetched and handed over as a file. */
  async downloadIcs(id: string): Promise<void> {
    const { data, error } = await supabase.functions.invoke(`me-appointments/${id}/ics`, { method: 'GET' });
    if (error) throw new BookingError('internal_error');
    const text = typeof data === 'string' ? data : await (data as Blob).text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'appointment.ics';
    a.click();
    URL.revokeObjectURL(url);
  },
};

export type { BookableType };
