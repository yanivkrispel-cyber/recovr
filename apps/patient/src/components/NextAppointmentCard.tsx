import { useQuery } from '@tanstack/react-query';
import { formatDayLong, formatTime, t, zonedParts, type I18nKey } from 'shared';
import { MY_APPOINTMENTS_KEY, myAppointments } from '../lib/booking';
import StatusTag from './booking/StatusTag';

// Home's appointment card: the next visit, or a way to book one. It never
// gets in the way of the day's plan — on any error it simply isn't shown.
export default function NextAppointmentCard({ onOpen }: { onOpen: (book: boolean) => void }) {
  const { data } = useQuery({ queryKey: MY_APPOINTMENTS_KEY, queryFn: myAppointments.list, staleTime: 60_000, retry: false });
  if (!data) return null;

  const next = data.upcoming[0];
  if (!next && data.types.length === 0) return null;

  if (!next) {
    return (
      <button type="button" onClick={() => onOpen(true)} style={{ ...shell, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'start' }}>
        <span style={{ fontSize: 13, color: 'var(--patient-muted)' }}>{t('sched.me.none')}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--patient-gold)' }}>{t('sched.me.book')} ←</span>
      </button>
    );
  }

  const p = zonedParts(new Date(next.starts_at), data.timezone);
  return (
    <section aria-label={t('sched.me.next')} style={shell}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--patient-muted)' }}>{t('sched.me.next')}</span>
        <StatusTag a={next} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div aria-hidden style={{ width: 54, height: 58, flex: 'none', borderRadius: 12, background: 'var(--patient-gold)', color: 'var(--patient-gold-ink)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{t(`sched.weekday_short.${p.weekday}` as I18nKey)}</span>
          <span style={{ fontSize: 22, fontWeight: 800 }}>{p.day}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--patient-text)' }}>
            {formatTime(next.starts_at, data.timezone)}–{formatTime(next.ends_at, data.timezone)}
          </div>
          <div style={{ fontSize: 13, color: 'var(--patient-muted)' }}>
            {next.type.name} · {formatDayLong(next.starts_at, data.timezone)}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpen(false)}
        style={{ minHeight: 44, border: '1px solid var(--patient-border)', background: 'transparent', color: 'var(--patient-text)', borderRadius: 999, fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
      >
        {t('sched.me.my')}
      </button>
    </section>
  );
}

const shell = {
  background: 'var(--patient-card)',
  border: '1px solid var(--patient-border)',
  borderRadius: 16,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: 'var(--patient-text)',
} as const;
