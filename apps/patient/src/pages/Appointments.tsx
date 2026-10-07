import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryError, Skeleton, useToast } from 'ui';
import { formatDayLong, formatTime, t, typePriceText, type BookableType, type I18nKey, type PatientAppointment } from 'shared';
import SlotPicker from '../components/booking/SlotPicker';
import { DARK as th } from '../components/booking/theme';
import StatusTag from '../components/booking/StatusTag';
import { BookingError, MY_APPOINTMENTS_KEY, myAppointments } from '../lib/booking';

// "My appointments" inside the patient app (T-35): what's coming up, booking
// a follow-up from the clinic's open slots, cancelling within the policy.

type Mode = { kind: 'list' } | { kind: 'type' } | { kind: 'time'; type: BookableType } | { kind: 'confirm'; type: BookableType; slot: string };

export default function Appointments({ onBack, startBooking = false }: { onBack: () => void; startBooking?: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: MY_APPOINTMENTS_KEY, queryFn: myAppointments.list });
  const [mode, setMode] = useState<Mode>(startBooking ? { kind: 'type' } : { kind: 'list' });
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const tz = data?.timezone ?? 'Asia/Jerusalem';
  const load = useMemo(
    () => (mode.kind === 'time' || mode.kind === 'confirm' ? (from: string, to: string) => myAppointments.slots(mode.type.id, from, to) : () => Promise.resolve([])),
    [mode],
  );

  async function book(type: BookableType, slot: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await myAppointments.book(type.id, slot);
      toast.show(res.appointment.status === 'confirmed' ? t('sched.me.booked.confirmed') : t('sched.me.booked.pending'), { tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: MY_APPOINTMENTS_KEY });
      setMode({ kind: 'list' });
    } catch (e) {
      const code = e instanceof BookingError ? e.code : '';
      if (code === 'slot_taken') {
        setMessage(t('sched.book.error.slot_taken_before'));
        setMode({ kind: 'time', type });
      } else {
        setMessage(code === 'limit_reached' ? t('sched.me.error.limit') : t('error.generic.body'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel(a: PatientAppointment) {
    setBusy(true);
    setMessage(null);
    try {
      await myAppointments.cancel(a.id);
      toast.show(t('sched.me.cancelled'), { tone: 'success' });
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: MY_APPOINTMENTS_KEY });
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

  const back = () => {
    setMessage(null);
    if (mode.kind === 'list') onBack();
    else if (mode.kind === 'type') setMode({ kind: 'list' });
    else if (mode.kind === 'time') setMode(data && data.types.length > 1 ? { kind: 'type' } : { kind: 'list' });
    else setMode({ kind: 'time', type: mode.type });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: th.text }}>
      <button type="button" onClick={back} style={{ background: 'none', border: 'none', color: th.muted, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, textAlign: 'right', minHeight: 32 }}>
        → {t('sched.book.back')}
      </button>
      <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700 }}>
        {mode.kind === 'list' ? t('sched.me.my') : mode.kind === 'type' ? t('sched.book.choose_type') : mode.kind === 'time' ? t('sched.book.choose_time') : t('sched.me.book')}
      </h1>

      {message && (
        <div role="alert" style={{ padding: '10px 12px', borderRadius: 12, background: th.notice, fontSize: 14 }}>
          {message}
        </div>
      )}

      {isLoading ? (
        <div aria-busy="true" aria-label={t('sched.me.loading')}>
          <Skeleton count={2} height={92} radius={14} />
        </div>
      ) : error || !data ? (
        <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => refetch()} />
      ) : mode.kind === 'type' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.types.map((ty) => (
            <button key={ty.id} type="button" onClick={() => setMode({ kind: 'time', type: ty })} style={{ ...card, textAlign: 'start', cursor: 'pointer', fontFamily: 'inherit', color: th.text, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <strong style={{ fontSize: 16 }}>{ty.name}</strong>
                <span style={{ fontSize: 13, color: th.muted }}>{t('sched.minutes', { n: ty.duration_min })}</span>
              </span>
              {ty.description && <span style={{ fontSize: 13, color: th.muted }}>{ty.description}</span>}
              {typePriceText(ty) && <span style={{ fontSize: 13, fontWeight: 600, color: th.text }}>{typePriceText(ty)}</span>}
              {ty.confirmation === 'manual' && <span style={{ fontSize: 12, color: th.accent }}>{t('sched.me.needs_approval')}</span>}
            </button>
          ))}
        </div>
      ) : mode.kind === 'time' ? (
        <>
          <div style={{ fontSize: 13, color: th.muted }}>
            {mode.type.name} · {t('sched.minutes', { n: mode.type.duration_min })}
          </div>
          <SlotPicker
            tz={tz}
            horizonDays={data.horizon_days}
            load={load}
            cacheKey={['me', mode.type.id]}
            theme={th}
            selected={null}
            onPick={(slot) => setMode({ kind: 'confirm', type: mode.type, slot })}
          />
        </>
      ) : mode.kind === 'confirm' ? (
        <>
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 15 }}>
            <strong>{mode.type.name}</strong>
            <span>
              {formatDayLong(mode.slot, tz)} · {formatTime(mode.slot, tz)}
            </span>
            {data.clinic.address && <span style={{ color: th.muted, fontSize: 13 }}>{data.clinic.address}</span>}
            {mode.type.confirmation === 'manual' && <span style={{ fontSize: 12, color: th.accent }}>{t('sched.me.needs_approval')}</span>}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: th.muted }}>{t('sched.me.free_cancel', { n: data.free_cancel_hours })}</p>
          <button type="button" disabled={busy} onClick={() => book(mode.type, mode.slot)} style={{ ...cta, opacity: busy ? 0.6 : 1 }}>
            {busy ? t('loading.generic') : t('sched.book.confirm')}
          </button>
        </>
      ) : (
        <>
          {data.types.length > 0 && (
            <button type="button" onClick={() => setMode(data.types.length === 1 ? { kind: 'time', type: data.types[0] } : { kind: 'type' })} style={cta}>
              {t('sched.me.book')}
            </button>
          )}

          <h2 style={h2}>{t('sched.me.upcoming')}</h2>
          {data.upcoming.length === 0 ? (
            <p style={{ margin: 0, fontSize: 14, color: th.muted }}>{t('sched.me.none')}</p>
          ) : (
            data.upcoming.map((a) => (
              <article key={a.id} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{a.type.name}</strong>
                  <StatusTag a={a} />
                </div>
                <div style={{ fontSize: 15 }}>
                  {formatDayLong(a.starts_at, tz)} · {formatTime(a.starts_at, tz)}–{formatTime(a.ends_at, tz)}
                </div>
                {cancelling === a.id ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14 }}>{t('sched.me.cancel_confirm')}</span>
                    <button type="button" disabled={busy} onClick={() => cancel(a)} style={{ ...pill, borderColor: th.danger, color: th.danger }}>
                      {t('sched.me.cancel')}
                    </button>
                    <button type="button" onClick={() => setCancelling(null)} style={pill}>
                      {t('sched.book.back')}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {a.status === 'confirmed' && (
                      <button type="button" onClick={() => void myAppointments.downloadIcs(a.id)} style={pill}>
                        {t('sched.book.add_ics')}
                      </button>
                    )}
                    {a.can_cancel ? (
                      <button type="button" onClick={() => setCancelling(a.id)} style={pill}>
                        {t('sched.me.cancel')}
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: th.muted }}>{t('sched.me.call_clinic', { n: data.free_cancel_hours })}</span>
                    )}
                  </div>
                )}
              </article>
            ))
          )}

          {data.past.length > 0 && (
            <>
              <h2 style={h2}>{t('sched.me.past')}</h2>
              {data.past.map((a) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, color: th.muted, padding: '8px 2px', borderBottom: `1px solid ${th.border}` }}>
                  <span>
                    {formatDayLong(a.starts_at, tz)} · {formatTime(a.starts_at, tz)} · {a.type.name}
                  </span>
                  <span>{t(`sched.status.${a.status}` as I18nKey)}</span>
                </div>
              ))}
            </>
          )}

          {data.clinic.phone && (
            <a href={`tel:${data.clinic.phone}`} style={{ fontSize: 13, color: th.link, textAlign: 'center', padding: 8 }}>
              {data.clinic.name} · <span dir="ltr">{data.clinic.phone}</span>
            </a>
          )}
        </>
      )}
    </div>
  );
}

const card: CSSProperties = { background: th.card, border: `1px solid ${th.border}`, borderRadius: 14, padding: 14 };
const h2: CSSProperties = { margin: '6px 0 0', fontSize: 14, fontWeight: 700, color: th.muted };
const cta: CSSProperties = {
  minHeight: 50,
  border: 'none',
  borderRadius: 999,
  background: th.cta,
  color: th.ctaInk,
  fontFamily: 'inherit',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};
const pill: CSSProperties = {
  minHeight: 40,
  padding: '0 14px',
  borderRadius: 999,
  border: `1px solid ${th.border}`,
  background: 'transparent',
  color: th.text,
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
