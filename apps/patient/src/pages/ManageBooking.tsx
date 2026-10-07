import { useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Logo, Skeleton } from 'ui';
import { formatDayLong, formatTime, googleCalendarUrl, t, type I18nKey } from 'shared';
import SlotPicker from '../components/booking/SlotPicker';
import { LIGHT as th } from '../components/booking/theme';
import { BookingError, publicBooking, publicIcsUrl } from '../lib/booking';

// /m/booking/:token — the link in every booking e-mail (T-35/T-36): see the
// appointment, add it to a calendar, move or cancel it within the clinic's
// policy.

export default function ManageBooking({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const key = ['manage-booking', token];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => publicBooking.manage(token),
    retry: (n, e) => !(e instanceof BookingError && e.code === 'not_found') && n < 2,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [newSlot, setNewSlot] = useState<string | null>(null);

  const tz = data?.clinic.timezone ?? 'Asia/Jerusalem';
  const a = data?.appointment;
  const live = a && (a.status === 'pending' || a.status === 'confirmed');

  async function cancel() {
    setBusy(true);
    setMessage(null);
    try {
      await publicBooking.cancel(token);
      await queryClient.invalidateQueries({ queryKey: key });
      setConfirming(false);
      setMessage(t('sched.manage.cancelled'));
    } catch (e) {
      setMessage(
        e instanceof BookingError && e.code === 'too_late'
          ? t('sched.manage.too_late', { n: data?.free_cancel_hours ?? 24 })
          : t('error.generic.body'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function move() {
    if (!newSlot) return;
    setBusy(true);
    setMessage(null);
    try {
      await publicBooking.move(token, newSlot);
      await queryClient.invalidateQueries({ queryKey: key });
      setMoving(false);
      setNewSlot(null);
      setMessage(t('sched.manage.moved'));
    } catch (e) {
      const code = e instanceof BookingError ? e.code : '';
      if (code === 'slot_taken') {
        setNewSlot(null);
        setMessage(t('sched.manage.slot_taken'));
      } else {
        setMessage(code === 'too_late' ? t('sched.manage.too_late', { n: data?.free_cancel_hours ?? 24 }) : t('error.generic.body'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div dir="rtl" style={{ minHeight: '100dvh', background: th.page, color: th.text, fontFamily: 'var(--font-ui)' }}>
      <header style={{ background: 'var(--navy)', padding: 'calc(14px + env(safe-area-inset-top)) 18px 14px' }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, color: 'var(--cream)' }}>
          <strong style={{ fontSize: 17 }}>{data?.clinic.name ?? ' '}</strong>
          <Logo height={30} tone="light" />
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: '0 auto', padding: '20px 18px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {isLoading ? (
          <Skeleton count={2} height={90} radius={14} />
        ) : error || !data || !a ? (
          <p style={{ textAlign: 'center', padding: '40px 0', fontSize: 16 }}>{t('sched.manage.invalid')}</p>
        ) : (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)' }}>{t('sched.manage.title')}</h1>
            <div style={{ background: th.card, border: `1.5px solid ${th.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 15 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: live ? (a.status === 'confirmed' ? th.success : 'var(--gold-deep)') : th.muted }}>
                {t(`sched.status.${a.status}` as I18nKey)}
              </span>
              <strong>{a.type.name}</strong>
              <span style={{ textDecoration: live ? undefined : 'line-through' }}>
                {formatDayLong(a.starts_at, tz)} · {formatTime(a.starts_at, tz)}–{formatTime(a.ends_at, tz)}
              </span>
              {data.clinic.address && <span style={{ color: th.muted }}>{data.clinic.address}</span>}
              {data.clinic.phone && (
                <a href={`tel:${data.clinic.phone}`} dir="ltr" style={{ color: th.text, textAlign: 'right' }}>
                  {data.clinic.phone}
                </a>
              )}
            </div>

            {message && (
              <div role="status" style={{ padding: '10px 12px', borderRadius: 10, background: th.notice, fontSize: 14 }}>
                {message}
              </div>
            )}

            {a.status === 'confirmed' && (
              <>
                <a
                  href={googleCalendarUrl({ title: `${a.type.name} · ${data.clinic.name}`, start: new Date(a.starts_at), end: new Date(a.ends_at), location: data.clinic.address })}
                  target="_blank"
                  rel="noreferrer"
                  style={outline}
                >
                  {t('sched.book.add_google')}
                </a>
                <a href={publicIcsUrl(token)} style={outline}>
                  {t('sched.book.add_ics')}
                </a>
              </>
            )}

            {live && (a.can_move ?? a.can_cancel) && !confirming && (
              moving ? (
                <section aria-label={t('sched.manage.move_title')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{t('sched.manage.move_title')}</h2>
                  {newSlot ? (
                    <>
                      <p style={{ margin: 0, fontSize: 15 }}>
                        {t('sched.manage.move_confirm', { when: `${formatDayLong(newSlot, tz)} · ${formatTime(newSlot, tz)}` })}
                      </p>
                      <button type="button" onClick={move} disabled={busy} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
                        {busy ? t('loading.generic') : t('sched.manage.move_ok')}
                      </button>
                      <button type="button" onClick={() => setNewSlot(null)} style={{ ...outline, background: 'none' }}>
                        {t('sched.book.back')}
                      </button>
                    </>
                  ) : (
                    <>
                      <SlotPicker
                        tz={tz}
                        horizonDays={data.horizon_days ?? 42}
                        load={(from, to) => publicBooking.moveSlots(token, from, to)}
                        cacheKey={['manage-move', token, a.starts_at]}
                        theme={th}
                        selected={null}
                        onPick={setNewSlot}
                      />
                      <button type="button" onClick={() => setMoving(false)} style={{ ...outline, background: 'none' }}>
                        {t('sched.book.back')}
                      </button>
                    </>
                  )}
                </section>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMessage(null);
                    setMoving(true);
                  }}
                  style={outline}
                >
                  {t('sched.manage.move')}
                </button>
              )
            )}

            {live &&
              !moving &&
              (a.can_cancel ? (
                confirming ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p style={{ margin: 0, fontSize: 15 }}>{t('sched.manage.cancel_confirm')}</p>
                    <button type="button" onClick={cancel} disabled={busy} style={{ ...danger, opacity: busy ? 0.6 : 1 }}>
                      {busy ? t('loading.generic') : t('sched.manage.cancel')}
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} style={{ ...outline, background: 'none' }}>
                      {t('sched.book.back')}
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)} style={danger}>
                    {t('sched.manage.cancel')}
                  </button>
                )
              ) : (
                <p style={{ margin: 0, fontSize: 14, color: th.muted }}>{t('sched.manage.too_late', { n: data.free_cancel_hours })}</p>
              ))}

            {!live && data.clinic.booking_slug && (
              <a href={`/m/book/${data.clinic.booking_slug}`} style={outline}>
                {t('sched.manage.book_again')}
              </a>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const outline: CSSProperties = {
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
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const primary: CSSProperties = {
  minHeight: 50,
  border: 'none',
  borderRadius: 10,
  background: th.cta,
  color: th.ctaInk,
  fontSize: 15,
  fontWeight: 700,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const danger: CSSProperties = {
  minHeight: 48,
  border: `1.5px solid ${th.danger}`,
  borderRadius: 10,
  background: 'transparent',
  color: th.danger,
  fontSize: 15,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
