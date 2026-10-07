import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Logo, Skeleton } from 'ui';
import {
  formatDayLong,
  formatTime,
  googleCalendarUrl,
  isValidEmail,
  normalizePhone,
  t,
  typePriceText,
  type BookableType,
  type ClinicContact,
  type PatientAppointment,
} from 'shared';
import SlotPicker from '../components/booking/SlotPicker';
import { LIGHT as th } from '../components/booking/theme';
import { BookingError, publicBooking, publicIcsUrl } from '../lib/booking';

// The public booking page, /m/book/:slug (T-35): a new patient books a first
// visit without the app or a patient card. Details → e-mail code → request.

type Step = 'type' | 'time' | 'details' | 'verify' | 'done';
const STEPS: Step[] = ['type', 'time', 'details', 'verify'];

interface Done {
  status: 'pending' | 'confirmed';
  token: string;
  appointment: PatientAppointment | null;
  clinic: ClinicContact | null;
}

export default function Book({ slug }: { slug: string }) {
  const profile = useQuery({
    queryKey: ['public-booking', slug],
    queryFn: () => publicBooking.profile(slug),
    retry: (n, e) => !(e instanceof BookingError && e.code === 'not_found') && n < 2,
  });

  const [step, setStep] = useState<Step>('type');
  const [type, setType] = useState<BookableType | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [region, setRegion] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [slotTaken, setSlotTaken] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const p = profile.data;
  const tz = p?.clinic.timezone ?? 'Asia/Jerusalem';

  useEffect(() => {
    if (p) document.title = `${p.clinic.name} · ${t('sched.me.book')}`;
  }, [p]);

  // A single bookable type needs no choosing.
  useEffect(() => {
    if (p?.types.length === 1 && step === 'type') {
      setType(p.types[0]);
      setStep('time');
    }
  }, [p, step]);

  useEffect(() => setMessage(null), [step]);

  const phoneNorm = normalizePhone(phone);
  const detailsValid = name.trim().length >= 2 && !!phoneNorm && isValidEmail(email) && consent;

  const loadSlots = useMemo(
    () => (from: string, to: string) => (type ? publicBooking.slots(slug, type.id, from, to) : Promise.resolve([])),
    [slug, type],
  );

  function fail(e: unknown) {
    const code = e instanceof BookingError ? e.code : 'network';
    const map: Record<string, string> = {
      invalid_code: t('sched.book.error.invalid_code', { n: Number((e as BookingError).payload?.attempts_left ?? 0) }),
      code_expired: t('sched.book.error.code_expired'),
      too_many_attempts: t('sched.book.error.too_many'),
      already_booked: t('sched.book.error.already_booked'),
      rate_limited: t('sched.book.error.rate_limited'),
      email_failed: t('sched.book.error.email_failed'),
      network: t('error.network.body'),
    };
    setMessage({ tone: 'error', text: map[code] ?? t('error.generic.body') });
  }

  async function sendCode() {
    setTouched(true);
    if (!detailsValid || !type || !slot || !phoneNorm) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await publicBooking.request(slug, {
        type_id: type.id,
        starts_at: slot,
        name: name.trim(),
        phone: phoneNorm,
        email: email.trim(),
        body_region_id: region || null,
        consent: true,
      });
      setRequestId(res.request_id);
      setCode('');
      setSlotTaken(false);
      setStep('verify');
    } catch (e) {
      if (e instanceof BookingError && e.code === 'slot_taken') {
        setSlot(null);
        setStep('time');
        setMessage({ tone: 'error', text: t('sched.book.error.slot_taken_before') });
      } else {
        fail(e);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!requestId || code.replace(/\D/g, '').length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await publicBooking.confirm(slug, { request_id: requestId, code, starts_at: slotTaken && slot ? slot : undefined });
      setDone(res);
      setStep('done');
    } catch (e) {
      if (e instanceof BookingError && e.code === 'slot_taken') {
        setSlotTaken(true);
        setSlot(null);
        setMessage({ tone: 'error', text: t('sched.book.error.slot_taken') });
      } else {
        fail(e);
      }
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!requestId) return;
    setBusy(true);
    try {
      await publicBooking.resend(slug, requestId);
      setMessage({ tone: 'info', text: t('sched.book.resent') });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);
  const canGoBack = step !== 'type' && step !== 'done' && !(step === 'time' && p?.types.length === 1);

  return (
    <div dir="rtl" style={{ minHeight: '100dvh', background: th.page, color: th.text, fontFamily: 'var(--font-ui)' }}>
      <header style={{ background: 'var(--navy)', color: 'var(--cream)', padding: 'calc(14px + env(safe-area-inset-top)) 18px 14px' }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {canGoBack && (
              <button
                type="button"
                onClick={() => setStep(STEPS[stepIndex - 1])}
                aria-label={t('sched.book.back')}
                style={{ width: 44, height: 44, margin: '-8px', border: 'none', background: 'none', color: 'var(--cream)', cursor: 'pointer', fontSize: 20 }}
              >
                →
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{p?.clinic.name ?? ' '}</div>
              {p?.clinic.address && <div style={{ fontSize: 13, opacity: 0.8 }}>{p.clinic.address}</div>}
            </div>
            <Logo height={30} tone="light" />
          </div>
          {step !== 'done' && p && (
            <div aria-hidden style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4 }}>
              {STEPS.map((s, i) => (
                <span key={s} style={{ height: 4, borderRadius: 2, background: i <= stepIndex ? 'var(--gold)' : 'var(--patient-border)' }} />
              ))}
            </div>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: '0 auto', padding: '20px 18px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {profile.isLoading ? (
          <div aria-busy="true">
            <Skeleton count={3} height={84} radius={14} />
          </div>
        ) : profile.error || !p ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <h1 style={h1}>{t('sched.book.not_found.title')}</h1>
            <p style={{ color: th.muted, fontSize: 15 }}>{t('sched.book.not_found.body')}</p>
          </div>
        ) : (
          <>
            {message && (
              <div role={message.tone === 'error' ? 'alert' : 'status'} style={{ padding: '10px 12px', borderRadius: 10, fontSize: 14, background: message.tone === 'error' ? 'var(--pill-attention-bg)' : th.notice, color: th.text }}>
                {message.text}
              </div>
            )}

            {step === 'type' && (
              <>
                <h1 style={h1}>{t('sched.book.choose_type')}</h1>
                {p.types.map((ty) => (
                  <button
                    key={ty.id}
                    type="button"
                    onClick={() => {
                      setType(ty);
                      setSlot(null);
                      setStep('time');
                    }}
                    style={{ ...card, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', color: th.text, display: 'flex', flexDirection: 'column', gap: 4 }}
                  >
                    <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8 }}>
                      <strong style={{ fontSize: 16 }}>{ty.name}</strong>
                      <span style={{ fontSize: 14, color: th.muted, whiteSpace: 'nowrap' }}>{t('sched.minutes', { n: ty.duration_min })}</span>
                    </span>
                    {ty.description && <span style={{ fontSize: 14, color: th.muted }}>{ty.description}</span>}
                    {typePriceText(ty) && <span style={{ fontSize: 14, fontWeight: 600, color: th.cta }}>{typePriceText(ty)}</span>}
                  </button>
                ))}
                <p style={{ margin: 0, fontSize: 14, color: th.muted }}>{t('sched.book.existing_hint')}</p>
              </>
            )}

            {step === 'time' && type && (
              <>
                <h1 style={h1}>{t('sched.book.choose_time')}</h1>
                <div style={{ fontSize: 14, color: th.muted }}>
                  {type.name} · {t('sched.minutes', { n: type.duration_min })}
                </div>
                <SlotPicker
                  tz={tz}
                  horizonDays={p.settings.horizon_days}
                  load={loadSlots}
                  cacheKey={['public', slug, type.id]}
                  theme={th}
                  selected={slot}
                  onPick={(s) => {
                    setSlot(s);
                    setStep('details');
                  }}
                />
              </>
            )}

            {step === 'details' && type && slot && (
              <>
                <h1 style={h1}>{t('sched.book.details')}</h1>
                <Summary type={type} slot={slot} tz={tz} />
                <Field label={t('sched.book.field.name')} error={touched && name.trim().length < 2 ? t('valid.required') : null}>
                  {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} style={input} />}
                </Field>
                <Field label={t('sched.book.field.phone')} error={touched && !phoneNorm ? t('valid.phone') : null}>
                  {(id) => <input id={id} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" dir="ltr" style={{ ...input, textAlign: 'right' }} />}
                </Field>
                <Field label={t('sched.book.field.email')} error={touched && !isValidEmail(email) ? t('valid.email') : null}>
                  {(id) => <input id={id} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" dir="ltr" style={{ ...input, textAlign: 'right' }} />}
                </Field>
                <Field label={t('sched.book.field.region')} hint={t('sched.book.field.region_hint')}>
                  {(id) => (
                    <select id={id} value={region} onChange={(e) => setRegion(e.target.value)} style={input}>
                      <option value="">{t('sched.book.field.region_placeholder')}</option>
                      {p.body_regions.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  )}
                </Field>
                <details style={{ fontSize: 14, color: th.muted }}>
                  <summary style={{ cursor: 'pointer', color: th.link, fontWeight: 600, minHeight: 32 }}>{t('sched.book.privacy.title')}</summary>
                  <p style={{ margin: '8px 0 0', lineHeight: 1.6 }}>{t('sched.book.privacy.body')}</p>
                </details>
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14, color: th.text, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2, flex: 'none', accentColor: 'var(--gold-deep)' }} />
                  <span>{t('sched.book.consent', { n: p.settings.free_cancel_hours })}</span>
                </label>
                {touched && !consent && <span role="alert" style={{ fontSize: 13, color: th.danger }}>{t('valid.required')}</span>}
                <button type="button" onClick={sendCode} disabled={busy} style={cta(busy)}>
                  {busy ? t('loading.generic') : t('sched.book.send_code')}
                </button>
              </>
            )}

            {step === 'verify' && type && (
              <>
                <h1 style={h1}>{t('sched.book.verify')}</h1>
                <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{t('sched.book.code_sent', { email: email.trim() })}</p>
                {slotTaken ? (
                  <SlotPicker
                    tz={tz}
                    horizonDays={p.settings.horizon_days}
                    load={loadSlots}
                    cacheKey={['public', slug, type.id, 'retry']}
                    theme={th}
                    selected={slot}
                    onPick={setSlot}
                  />
                ) : (
                  slot && <Summary type={type} slot={slot} tz={tz} />
                )}
                <Field label={t('sched.book.code_label')}>
                  {(id) => (
                    <input
                      id={id}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      dir="ltr"
                      placeholder="000000"
                      style={{ ...input, fontSize: 24, letterSpacing: 8, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                    />
                  )}
                </Field>
                <button type="button" onClick={confirm} disabled={busy || code.replace(/\D/g, '').length !== 6 || (slotTaken && !slot)} style={cta(busy || code.replace(/\D/g, '').length !== 6 || (slotTaken && !slot))}>
                  {busy ? t('loading.generic') : t('sched.book.confirm')}
                </button>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <button type="button" onClick={resend} disabled={busy} style={linkBtn}>
                    {t('sched.book.resend')}
                  </button>
                  <button type="button" onClick={() => setStep('details')} disabled={busy} style={linkBtn}>
                    {t('sched.book.edit_details')}
                  </button>
                </div>
              </>
            )}

            {step === 'done' && done && <DoneView done={done} tz={tz} />}
          </>
        )}
      </main>
    </div>
  );
}

function DoneView({ done, tz }: { done: Done; tz: string }) {
  const a = done.appointment;
  const c = done.clinic;
  const confirmed = done.status === 'confirmed';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, paddingTop: 8 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--pill-good-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--flag-green)" strokeWidth="2.4" aria-hidden>
            <path d="M5 12l5 5 9-10" />
          </svg>
        </div>
        <h1 style={h1}>{confirmed ? t('sched.book.done.confirmed') : t('sched.book.done.pending')}</h1>
        <p style={{ margin: 0, fontSize: 15, color: th.muted, lineHeight: 1.6 }}>
          {confirmed ? t('sched.book.done.confirmed_body') : t('sched.book.done.pending_body')}
        </p>
      </div>
      {a && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 15 }}>
          <strong>{a.type.name}</strong>
          <span>
            {formatDayLong(a.starts_at, tz)} · {formatTime(a.starts_at, tz)}–{formatTime(a.ends_at, tz)}
          </span>
          {c?.address && (
            <span style={{ color: th.muted }}>
              {c.address} ·{' '}
              <a href={`https://maps.google.com/?q=${encodeURIComponent(c.address)}`} target="_blank" rel="noreferrer" style={{ color: th.link }}>
                {t('sched.book.navigate')}
              </a>
            </span>
          )}
          {c?.phone && (
            <a href={`tel:${c.phone}`} dir="ltr" style={{ color: th.text, textAlign: 'right' }}>
              {c.phone}
            </a>
          )}
        </div>
      )}
      {a && confirmed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <a
            href={googleCalendarUrl({ title: `${a.type.name} · ${c?.name ?? ''}`, start: new Date(a.starts_at), end: new Date(a.ends_at), location: c?.address })}
            target="_blank"
            rel="noreferrer"
            style={secondaryCta}
          >
            {t('sched.book.add_google')}
          </a>
          <a href={publicIcsUrl(done.token)} style={secondaryCta}>
            {t('sched.book.add_ics')}
          </a>
        </div>
      )}
      <p style={{ margin: 0, fontSize: 14, color: th.muted, textAlign: 'center', lineHeight: 1.6 }}>
        {t('sched.book.done.manage')} {t('sched.book.done.after_first')}
      </p>
    </div>
  );
}

function Summary({ type, slot, tz }: { type: BookableType; slot: string; tz: string }) {
  return (
    <div style={{ ...card, fontSize: 15 }}>
      <strong>{type.name}</strong> · {formatDayLong(slot, tz)} · {formatTime(slot, tz)}
    </div>
  );
}

let fieldSeq = 0;

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const [id] = useState(() => `book-field-${++fieldSeq}`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label htmlFor={id} style={{ fontSize: 14, fontWeight: 600, color: th.text }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: th.muted, fontSize: 13 }}> — {hint}</span>}
      </label>
      {children(id)}
      {error && <span role="alert" style={{ fontSize: 13, color: th.danger }}>{error}</span>}
    </div>
  );
}

const h1: CSSProperties = { margin: 0, fontSize: 22, fontWeight: 700, color: th.text, fontFamily: 'var(--font-display)' };

const card: CSSProperties = {
  background: th.card,
  border: `1.5px solid ${th.border}`,
  borderRadius: 14,
  padding: 16,
};

const input: CSSProperties = {
  minHeight: 48,
  border: 'var(--border-input)',
  borderRadius: 'var(--radius-button)',
  padding: '0 12px',
  fontSize: 16,
  fontFamily: 'inherit',
  background: th.card,
  color: th.text,
  width: '100%',
  boxSizing: 'border-box',
};

function cta(disabled: boolean): CSSProperties {
  return {
    minHeight: 52,
    border: 'none',
    borderRadius: 10,
    background: th.cta,
    color: th.ctaInk,
    fontFamily: 'inherit',
    fontSize: 17,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}

const secondaryCta: CSSProperties = {
  minHeight: 48,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1.5px solid ${th.accent}`,
  borderRadius: 10,
  color: th.accent,
  fontSize: 15,
  fontWeight: 600,
  textDecoration: 'none',
};

const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '8px 0',
  minHeight: 44,
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  color: th.link,
  cursor: 'pointer',
};
