import type { CSSProperties, ReactNode } from 'react';
import {
  clinicDate,
  clipToLocalDay,
  formatMinutes,
  formatTime,
  freeGaps,
  hhmm,
  isLive,
  t,
  whatsappUrl,
  windowsOn,
  zonedParts,
  type CalendarAppointment,
  type TimeOff,
  type WeeklyHoursRule,
} from 'shared';
import { TYPE_STYLE, isLead, personName, statusLabel } from './calendarUi';

// The phone's day: one scrolling list that answers "who's next", shows the
// gaps worth filling and lets requests be approved where they sit.

interface Props {
  day: string;
  tz: string;
  now: Date;
  rules: WeeklyHoursRule[];
  appointments: CalendarAppointment[];
  timeOff: TimeOff[];
  slotMin: number;
  busyId: string | null;
  onOpen: (a: CalendarAppointment) => void;
  onBook: (day: string, minutes: number) => void;
  onApprove: (a: CalendarAppointment) => void;
  onArrived: (a: CalendarAppointment) => void;
}

type Row =
  | { kind: 'now'; key: string }
  | { kind: 'free'; key: string; start: number; end: number }
  | { kind: 'next'; key: string; a: CalendarAppointment }
  | { kind: 'appt'; key: string; a: CalendarAppointment };

export default function DayAgenda({ day, tz, now, rules, appointments, timeOff, slotMin, busyId, onOpen, onBook, onApprove, onArrived }: Props) {
  const today = clinicDate(now, tz);
  const nowMin = zonedParts(now, tz).minutes;
  const isToday = day === today;
  const isPast = day < today;

  const items = appointments
    .filter((a) => clinicDate(a.starts_at, tz) === day && (isLive(a.status)))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const windows = windowsOn(rules, day);
  const busy = [...items, ...timeOff]
    .map((x) => clipToLocalDay(x.starts_at, x.ends_at, day, tz))
    .filter((x): x is [number, number] => !!x);
  const gaps = isPast
    ? []
    : freeGaps(windows, busy, 30)
        .map((g) => ({ start: isToday ? Math.max(g.start, roundUp5(nowMin)) : g.start, end: g.end }))
        .filter((g) => g.end - g.start >= 30);

  const next = isToday
    ? items.find((a) => a.status === 'confirmed' && Date.parse(a.ends_at) > now.getTime())
    : undefined;

  const events: { at: number; row: Row }[] = [
    ...items.map((a) => ({
      at: clipToLocalDay(a.starts_at, a.ends_at, day, tz)?.[0] ?? 0,
      row: (a === next ? { kind: 'next', key: a.id, a } : { kind: 'appt', key: a.id, a }) as Row,
    })),
    ...gaps.map((g) => ({ at: g.start, row: { kind: 'free', key: `free-${g.start}`, start: g.start, end: g.end } as Row })),
  ].sort((x, y) => x.at - y.at || (x.row.kind === 'free' ? 1 : -1));

  const rows: Row[] = [];
  let nowPlaced = !isToday;
  for (const ev of events) {
    if (!nowPlaced && ev.at >= nowMin) {
      rows.push({ kind: 'now', key: 'now' });
      nowPlaced = true;
    }
    rows.push(ev.row);
  }
  if (!nowPlaced) rows.push({ kind: 'now', key: 'now' });

  if (windows.length === 0 && items.length === 0) {
    return <p style={emptyStyle}>{t('sched.mobile.closed_day')}</p>;
  }
  if (rows.length === 0) {
    return <p style={emptyStyle}>{t('sched.cal.empty_day')}</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => {
        if (r.kind === 'now') {
          return (
            <div key={r.key} aria-label={t('sched.mobile.now', { time: hhmm(nowMin) })} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--danger)' }}>{t('sched.mobile.now', { time: hhmm(nowMin) })}</span>
              <span style={{ flex: 1, height: 2, borderRadius: 1, background: 'var(--danger)' }} />
            </div>
          );
        }
        if (r.kind === 'free') {
          const len = r.end - r.start;
          const n = Math.floor(len / slotMin);
          return (
            <button key={r.key} type="button" onClick={() => onBook(day, r.start)} style={freeRow}>
              <span style={{ width: 46, flex: 'none', fontSize: 14, fontWeight: 700, color: 'var(--flag-green)', fontVariantNumeric: 'tabular-nums' }}>{hhmm(r.start)}</span>
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--flag-green)' }}>{t('sched.mobile.free', { len: formatMinutes(len) })}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {hhmm(r.start)}–{hhmm(r.end)} · {n === 0 ? t('sched.mobile.fits_none') : n === 1 ? t('sched.mobile.fits_one') : t('sched.mobile.fits_n', { n })}
                </span>
              </span>
              <span style={{ height: 32, padding: '0 12px', borderRadius: 'var(--radius-pill)', background: 'var(--pill-good-bg)', color: 'var(--flag-green)', fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center' }}>
                {t('sched.mobile.book_here')}
              </span>
            </button>
          );
        }
        if (r.kind === 'next') {
          const a = r.a;
          const startsIn = Math.round((Date.parse(a.starts_at) - now.getTime()) / 60_000);
          const phone = a.patient?.phone ?? a.lead?.phone ?? null;
          const wa = phone ? whatsappUrl(phone) : null;
          return (
            <div key={r.key} style={{ background: 'var(--navy)', color: 'var(--cream)', borderRadius: 16, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button type="button" onClick={() => onOpen(a)} style={{ border: 'none', background: 'transparent', color: 'inherit', padding: 0, textAlign: 'start', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'inherit' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)' }}>
                  {t('sched.mobile.next')} · {startsIn > 0 ? t('sched.mobile.in_time', { time: formatMinutes(startsIn) }) : t('sched.mobile.started')}
                </span>
                <span style={{ fontSize: 19, fontWeight: 800 }}>{personName(a)}</span>
                <span style={{ fontSize: 13.5, color: 'var(--line-input)' }}>
                  {formatTime(a.starts_at, tz)}–{formatTime(a.ends_at, tz)} · {a.type.name}
                </span>
                <ClinicalChip a={a} onDark />
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={busyId === a.id} onClick={() => onArrived(a)} style={{ flex: 1, height: 44, border: 'none', borderRadius: 10, background: 'var(--gold)', color: 'var(--patient-gold-ink)', fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', opacity: busyId === a.id ? 0.6 : 1 }}>
                  {t('sched.appt.attended')}
                </button>
                {wa && (
                  <a href={wa} target="_blank" rel="noreferrer" style={darkOutline}>
                    {t('sched.mobile.whatsapp')}
                  </a>
                )}
                <button type="button" onClick={() => onOpen(a)} style={{ ...darkOutline, cursor: 'pointer', fontFamily: 'inherit', background: 'transparent' }}>
                  {t('sched.appt.details')}
                </button>
              </div>
            </div>
          );
        }
        const a = r.a;
        const pending = a.status === 'pending';
        const past = a.status === 'attended' || a.status === 'no_show';
        return (
          <div key={r.key} style={{ background: 'var(--white)', borderRadius: 12, border: pending ? '1.5px dashed var(--gold-deep)' : '1px solid var(--line-soft)', opacity: past ? 0.62 : 1 }}>
            <button type="button" onClick={() => onOpen(a)} style={{ width: '100%', border: 'none', background: 'transparent', padding: '10px 12px', textAlign: 'start', cursor: 'pointer', display: 'flex', alignItems: 'stretch', gap: 10, fontFamily: 'inherit', color: 'var(--ink)' }}>
              <span style={{ width: 46, flex: 'none', display: 'flex', flexDirection: 'column', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>{formatTime(a.starts_at, tz)}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>{formatTime(a.ends_at, tz)}</span>
              </span>
              <span aria-hidden style={{ width: 4, flex: 'none', borderRadius: 2, background: TYPE_STYLE[a.type.color].accent }} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{personName(a)}</span>
                  {(pending || past) && <span style={tagStyle(a.status)}>{statusLabel(a.status)}</span>}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{a.type.name}</span>
                <ClinicalChip a={a} />
              </span>
            </button>
            {pending && (
              <div style={{ display: 'flex', gap: 8, padding: '0 12px 12px' }}>
                <button type="button" disabled={busyId === a.id} onClick={() => onApprove(a)} style={{ flex: 1, height: 42, border: 'none', borderRadius: 9, background: 'var(--navy)', color: 'var(--cream)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: busyId === a.id ? 0.6 : 1 }}>
                  {t('sched.appt.approve')}
                </button>
                <button type="button" onClick={() => onOpen(a)} style={{ flex: 1, height: 42, border: '1px solid var(--shell-border)', borderRadius: 9, background: 'var(--paper)', color: 'var(--navy)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {t('sched.appt.details')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function roundUp5(m: number): number {
  return Math.ceil(m / 5) * 5;
}

function ClinicalChip({ a, onDark }: { a: CalendarAppointment; onDark?: boolean }): ReactNode {
  if (isLead(a)) {
    return (
      <span style={{ ...chipBase, background: onDark ? 'var(--gold)' : 'var(--nav-active-bg)', color: onDark ? 'var(--patient-gold-ink)' : 'var(--navy)' }}>
        {t('sched.lead')}
        {a.lead?.body_region ? ` · ${a.lead.body_region.name}` : ''}
      </span>
    );
  }
  const c = a.clinical;
  if (!c || c.phase_n == null) return null;
  const text = `${c.phase_name ?? t('sched.cal.phase', { n: c.phase_n })}${c.adherence != null ? ` · ${t('sched.cal.adherence', { n: c.adherence })}` : ''}`;
  const look = onDark
    ? { background: 'var(--gold)', color: 'var(--patient-gold-ink)' }
    : c.low_adherence
      ? { background: 'var(--pill-attention-bg)', color: 'var(--flag-red)' }
      : { background: 'var(--pill-good-bg)', color: 'var(--flag-green)' };
  return <span style={{ ...chipBase, ...look }}>{text}</span>;
}

function tagStyle(status: string): CSSProperties {
  const base: CSSProperties = { fontSize: 11, fontWeight: 800, borderRadius: 'var(--radius-pill)', padding: '2px 8px', whiteSpace: 'nowrap' };
  if (status === 'pending') return { ...base, background: 'var(--warn-bg)', color: 'var(--gold-deep)' };
  if (status === 'no_show') return { ...base, background: 'var(--pill-attention-bg)', color: 'var(--flag-red)' };
  return { ...base, background: 'var(--line-soft)', color: 'var(--ink-soft)' };
}

const chipBase: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 'var(--radius-pill)',
  padding: '1px 9px',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const freeRow: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: 'transparent',
  border: '1.5px dashed var(--line-input)',
  borderRadius: 12,
  padding: '9px 12px',
  textAlign: 'start',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const darkOutline: CSSProperties = {
  height: 44,
  padding: '0 14px',
  border: '1px solid var(--navy-muted)',
  borderRadius: 10,
  color: 'var(--cream)',
  fontSize: 13.5,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'none',
};

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: '28px 12px',
  textAlign: 'center',
  color: 'var(--muted)',
  fontSize: 14,
  background: 'var(--paper)',
  borderRadius: 14,
};
