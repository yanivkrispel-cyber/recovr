// Booking helpers shared by the scheduling, public-booking and
// me-appointments functions: e-mail verification codes, signed manage links,
// .ics invites and the booking URLs.
//
// Manage links are stateless: the token is the clinic and appointment ids
// plus an HMAC over them, so any e-mail can carry a working link and nothing
// is stored. The key is BOOKING_LINK_SECRET, or — when that secret isn't set
// — one derived from the service-role key (rotating that key then retires
// old links, which is acceptable: the patient can still call the clinic).

const SECRET =
  Deno.env.get('BOOKING_LINK_SECRET') ||
  `derived:${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`;

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'http://localhost:5173';
// Same normalisation as patient-invite: callers append "/m/…".
export const PATIENT_BASE_URL = (Deno.env.get('PATIENT_BASE_URL') ?? APP_BASE_URL)
  .replace(/\/+$/, '')
  .replace(/\/m$/, '');

export const EMAIL_LOGO_URL = `${PATIENT_BASE_URL}/m/brand/email-logo.png`;

export function bookingPageUrl(slug: string): string {
  return `${PATIENT_BASE_URL}/m/book/${encodeURIComponent(slug)}`;
}

export function manageUrl(token: string): string {
  return `${PATIENT_BASE_URL}/m/booking/${token}`;
}

const enc = new TextEncoder();
let keyPromise: Promise<CryptoKey> | null = null;

function hmacKey(): Promise<CryptoKey> {
  keyPromise ??= crypto.subtle
    .digest('SHA-256', enc.encode(`recovr-booking:${SECRET}`))
    .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  return keyPromise;
}

async function hmac(message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function uuidBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function bytesUuid(b: Uint8Array): string {
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// --- e-mail verification codes -------------------------------------------------

/** A 6-digit code, uniformly distributed. */
export function generateCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000); // drop the biased tail of 2^32
  return String(n % 1_000_000).padStart(6, '0');
}

/** What the database stores instead of the code. */
export async function codeHash(code: string): Promise<string> {
  return toHex(await hmac(`booking-code:${code}`));
}

// --- manage links ----------------------------------------------------------------

export async function manageToken(clinicId: string, appointmentId: string): Promise<string> {
  const mac = (await hmac(`manage:${clinicId}:${appointmentId}`)).subarray(0, 16);
  const out = new Uint8Array(48);
  out.set(uuidBytes(clinicId), 0);
  out.set(uuidBytes(appointmentId), 16);
  out.set(mac, 32);
  return b64url(out);
}

export async function parseManageToken(token: string): Promise<{ clinicId: string; appointmentId: string } | null> {
  const raw = fromB64url(token);
  if (!raw || raw.length !== 48) return null;
  const clinicId = bytesUuid(raw.subarray(0, 16));
  const appointmentId = bytesUuid(raw.subarray(16, 32));
  const expected = (await hmac(`manage:${clinicId}:${appointmentId}`)).subarray(0, 16);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expected[i] ^ raw[32 + i];
  return diff === 0 ? { clinicId, appointmentId } : null;
}

// --- .ics -------------------------------------------------------------------------

function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Lines longer than 75 octets fold onto continuation lines that start with a
// space (RFC 5545 §3.1), never splitting a UTF-8 sequence.
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string | null;
  description?: string | null;
  /** monotonically increasing per change, e.g. epoch seconds of updated_at */
  sequence: number;
  /** pending requests go in as tentative */
  status: 'confirmed' | 'tentative' | 'cancelled';
}

/** The .ics status for an appointment status. */
export function icsStatus(appointmentStatus: string): IcsEvent['status'] {
  if (appointmentStatus === 'pending') return 'tentative';
  return appointmentStatus === 'confirmed' || appointmentStatus === 'attended' ? 'confirmed' : 'cancelled';
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ReCOVR//Scheduling//HE',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.status === 'cancelled' ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}@recovr`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(e.start)}`,
    `DTEND:${icsStamp(e.end)}`,
    `SEQUENCE:${e.sequence}`,
    `STATUS:${e.status.toUpperCase()}`,
    `SUMMARY:${icsText(e.summary)}`,
  ];
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// --- small HTTP helpers --------------------------------------------------------------

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** HTTP status for an error code returned by a scheduling RPC. */
export function statusFor(code: string): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'slot_taken':
    case 'already_booked':
    case 'slug_taken':
    case 'invalid_transition':
    case 'not_cancellable':
    case 'too_late':
    case 'limit_reached':
      return 409;
    case 'rate_limited':
      return 429;
    default:
      return 422;
  }
}
