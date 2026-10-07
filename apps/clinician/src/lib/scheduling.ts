import { useContext, type ContextType } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppointmentStatus,
  AppointmentType,
  AvailabilityRule,
  CalendarAppointment,
  CalendarConflicts,
  CalendarRange,
  CalendarSummary,
  SchedulingSettings,
  SchedulingSetup,
  TimeOff,
  WeeklyHoursRule,
} from 'shared';
import { SupabaseContext } from '../App';

// Data layer for the calendar (edge function `scheduling`, T-34 / T-35).
// Errors surface as SchedulingError with the server's error code, so screens
// can react to `conflict`, `slug_taken`, … instead of a generic failure.

export class SchedulingError extends Error {
  constructor(
    public code: string,
    public payload: Record<string, unknown> = {},
  ) {
    super(code);
  }

  get conflicts(): CalendarConflicts | null {
    return (this.payload.conflicts as CalendarConflicts | undefined) ?? null;
  }
}

type Supabase = ContextType<typeof SupabaseContext>;

async function call<T>(supabase: Supabase, path: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`scheduling/${path}`, { method, body: body as Record<string, unknown> });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = await (error.context as Response).json().catch(() => null);
      throw new SchedulingError(typeof payload?.error === 'string' ? payload.error : 'internal_error', payload ?? {});
    }
    throw new SchedulingError('network');
  }
  return data as T;
}

export const SETUP_KEY = ['scheduling', 'setup'] as const;
export const REQUESTS_KEY = ['scheduling', 'requests'] as const;
export const REQUEST_COUNT_KEY = ['scheduling', 'requests', 'count'] as const;
const CALENDAR_KEY = ['scheduling', 'calendar'] as const;
const SUMMARY_KEY = ['scheduling', 'summary'] as const;

export function useSchedulingSetup() {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => call<SchedulingSetup>(supabase, 'setup', 'GET'),
    staleTime: 60_000,
  });
}

export function useCalendarRange(from: string, to: string, enabled = true) {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: [...CALENDAR_KEY, from, to],
    enabled,
    queryFn: () =>
      call<CalendarRange>(supabase, `calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, 'GET'),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
}

/** Per-day big picture for clinic-local dates [from, to] (≤ 62 days). */
export function useCalendarSummary(from: string, to: string, enabled = true) {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: [...SUMMARY_KEY, from, to],
    enabled,
    queryFn: () => call<CalendarSummary>(supabase, `summary?from=${from}&to=${to}`, 'GET'),
    placeholderData: (prev) => prev,
    refetchInterval: 120_000,
  });
}

/** Open start times to suggest for a new appointment of `typeId`. */
export function useClinicianSlots(typeId: string | null, from: string, to: string) {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: ['scheduling', 'slots', typeId, from, to],
    enabled: !!typeId,
    queryFn: async () => (await call<{ slots: string[] }>(supabase, `slots?type_id=${typeId}&from=${from}&to=${to}`, 'GET')).slots,
    staleTime: 30_000,
  });
}

/** Existing cards with this phone (last 9 digits) or e-mail — offered before
 *  booking a new contact, so the same person doesn't end up twice. */
export function useContactMatches(phone: string, email: string, enabled: boolean) {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: ['scheduling', 'contact-matches', phone, email],
    enabled,
    queryFn: async () =>
      (
        await call<{ matches: { id: string; name: string; status: string }[] }>(
          supabase,
          `contact-matches?phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`,
          'GET',
        )
      ).matches,
    staleTime: 30_000,
  });
}

export function useBookingRequests() {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: REQUESTS_KEY,
    queryFn: async () => (await call<{ requests: CalendarAppointment[] }>(supabase, 'requests', 'GET')).requests,
    refetchInterval: 60_000,
  });
}

/** Pending requests, for the nav badge. Cheap; polled. */
export function useBookingRequestCount() {
  const supabase = useContext(SupabaseContext);
  return useQuery({
    queryKey: REQUEST_COUNT_KEY,
    queryFn: async () => (await call<{ count: number }>(supabase, 'requests?count=1', 'GET')).count,
    refetchInterval: 60_000,
    retry: false,
  });
}

function useInvalidateCalendar() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CALENDAR_KEY });
    void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['scheduling', 'slots'] });
  };
}

export interface AppointmentInput {
  /** an existing card … */
  patient_id?: string;
  /** … or someone without one yet (shown as a new patient until a card is opened) */
  lead?: { name: string; phone: string; email?: string };
  type_id: string;
  starts_at: string;
  duration_min?: number;
  note?: string;
  notify?: boolean;
}

export interface AppointmentPatch {
  status?: AppointmentStatus;
  starts_at?: string;
  duration_min?: number;
  type_id?: string;
  note?: string | null;
  cancel_reason?: string;
  price_ils?: number | null;
  notify?: boolean;
}

interface WriteResult {
  appointment: CalendarAppointment;
  change?: string | null;
  emailed: boolean | null;
}

export function useCreateAppointment() {
  const supabase = useContext(SupabaseContext);
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (input: AppointmentInput) => call<WriteResult>(supabase, 'appointments', 'POST', input),
    onSuccess: invalidate,
  });
}

export function useUpdateAppointment() {
  const supabase = useContext(SupabaseContext);
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AppointmentPatch }) =>
      call<WriteResult>(supabase, `appointments/${id}`, 'PATCH', patch),
    onSuccess: invalidate,
  });
}

export function useCreateTimeOff() {
  const supabase = useContext(SupabaseContext);
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (input: { starts_at: string; ends_at: string; reason?: string }) =>
      call<{ time_off: TimeOff }>(supabase, 'time-off', 'POST', input),
    onSuccess: invalidate,
  });
}

export function useDeleteTimeOff() {
  const supabase = useContext(SupabaseContext);
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: (id: string) => call<{ ok: true }>(supabase, `time-off/${id}`, 'DELETE'),
    onSuccess: invalidate,
  });
}

export function useLinkRequest() {
  const supabase = useContext(SupabaseContext);
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: ({ requestId, patientId }: { requestId: string; patientId: string }) =>
      call<{ ok: true }>(supabase, `requests/${requestId}/link`, 'POST', { patient_id: patientId }),
    onSuccess: invalidate,
  });
}

function useSetupMutation<TInput, TResult>(fn: (supabase: Supabase, input: TInput) => Promise<TResult>) {
  const supabase = useContext(SupabaseContext);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => fn(supabase, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETUP_KEY });
      void queryClient.invalidateQueries({ queryKey: CALENDAR_KEY });
      void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    },
  });
}

export function useUpdateSchedulingSettings() {
  return useSetupMutation((s, patch: Partial<SchedulingSettings> & { booking_slug?: string | null }) =>
    call<{ settings: SchedulingSettings; booking_slug: string | null; booking_url: string | null }>(s, 'settings', 'PATCH', patch),
  );
}

export function useSaveAppointmentType() {
  return useSetupMutation((s, type: Partial<AppointmentType>) => call<{ type: AppointmentType }>(s, 'types', 'POST', type));
}

export function useSaveAvailability() {
  return useSetupMutation((s, input: { practitioner_id?: string; rules: WeeklyHoursRule[] }) =>
    call<{ availability: AvailabilityRule[] }>(s, 'availability', 'PUT', input),
  );
}
