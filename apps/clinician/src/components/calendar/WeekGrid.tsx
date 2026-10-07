import { useMemo, type ReactNode } from 'react';
import {
  addDays,
  formatTime,
  hhmm,
  isLive,
  t,
  windowsOn,
  zonedParts,
  zonedTimeToUtc,
  type CalendarAppointment,
  type TimeOff,
  type WeeklyHoursRule,
} from 'shared';
import { HATCH, TYPE_STYLE, isLead, personName, statusLabel, weekdayLabel } from './calendarUi';

// The time grid for one or more clinic-local days. Everything is placed by
// clinic-local minutes, so the grid reads the same in any browser timezone.

const HOUR_PX = 56;
const PX_PER_MIN = HOUR_PX / 60;
const DAY_MIN = 24 * 60;

interface Placed<T> {
  item: T;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

/** [start, end) of an instant range, clipped to one local day, in minutes. */
function clipToDay(start: string, end: string, day: string, tz: string): [number, number] | null {
  const dayStart = zonedTimeToUtc(day, '00:00', tz).getTime();
  const dayEnd = zonedTimeToUtc(addDays(day, 1), '00:00', tz).getTime();
  const s = Math.max(Date.parse(start), dayStart);
  const e = Math.min(Date.parse(end), dayEnd);
  if (e <= s) return null;
  const sMin = s === dayStart ? 0 : zonedParts(new Date(s), tz).minutes;
  const eMin = e === dayEnd ? DAY_MIN : zonedParts(new Date(e), tz).minutes;
  return [sMin, Math.max(eMin, sMin + 5)];
}

/** Side-by-side lanes for overlapping items (e.g. a cancelled visit under a new one). */
function layout<T>(items: { item: T; start: number; end: number }[], fromMin: number): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: { p: Placed<T>; end: number }[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const flush = () => {
    for (const c of cluster) c.p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  for (const it of sorted) {
    if (it.start >= clusterEnd) {
      flush();
      clusterEnd = it.end;
    } else {
      clusterEnd = Math.max(clusterEnd, it.end);
    }
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    const p: Placed<T> = {
      item: it.item,
      top: (it.start - fromMin) * PX_PER_MIN,
      height: Math.max((it.end - it.start) * PX_PER_MIN, 18),
      lane,
      lanes: 1,
    };
    cluster.push({ p, end: it.end });
    out.push(p);
  }
  flush();
  return out;
}

export interface WeekGridProps {
  days: string[];
  tz: string;
  rules: WeeklyHoursRule[];
  appointments: CalendarAppointment[];
  timeOff: TimeOff[];
  now: Date;
  /** empty half-hours open the new-appointment form */
  onCreate?: (date: string, minutes: number) => void;
  onOpen: (a: CalendarAppointment) => void;
  onOpenTimeOff?: (o: TimeOff) => void;
}

export default function WeekGrid({ days, tz, rules, appointments, timeOff, now, onCreate, onOpen, onOpenTimeOff }: WeekGridProps) {
  const today = zonedParts(now, tz).date;

  const perDay = useMemo(
    () =>
      days.map((day) => {
        const appts = appointments.flatMap((a) => {
          const r = clipToDay(a.starts_at, a.ends_at, day, tz);
          return r ? [{ item: a, start: r[0], end: r[1] }] : [];
        });
        const offs = timeOff.flatMap((o) => {
          const r = clipToDay(o.starts_at, o.ends_at, day, tz);
          return r ? [{ item: o, start: r[0], end: r[1] }] : [];
        });
        return { day, appts, offs, windows: windowsOn(rules, day) };
      }),
    [days, appointments, timeOff, rules, tz],
  );

  // Visible hours: working hours and anything booked, at least 08:00–19:00.
  const [fromMin, toMin] = useMemo(() => {
    let lo = 8 * 60;
    let hi = 19 * 60;
    for (const d of perDay) {
      for (const w of d.windows) {
        lo = Math.min(lo, w.start);
        hi = Math.max(hi, w.end);
      }
      for (const a of d.appts) {
        lo = Math.min(lo, a.start);
        hi = Math.max(hi, a.end);
      }
    }
    return [Math.floor(lo / 60) * 60, Math.min(DAY_MIN, Math.ceil(hi / 60) * 60)];
  }, [perDay]);

  const height = (toMin - fromMin) * PX_PER_MIN;
  const halfHours = Array.from({ length: (toMin - fromMin) / 30 }, (_, i) => fromMin + i * 30);
  const nowMin = zonedParts(now, tz).minutes;
  const columns = `56px repeat(${days.length}, minmax(${days.length > 1 ? 112 : 240}px, 1fr))`;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: days.length > 1 ? 56 + days.length * 112 : undefined }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: columns,
            position: 'sticky',
            top: 0,
            zIndex: 2,
            background: 'var(--shell-sidebar-bg)',
            borderBottom: '1px solid var(--shell-border)',
          }}
        >
          <div />
          {perDay.map(({ day, appts, windows }) => {
            const p = zonedParts(zonedTimeToUtc(day, '12:00', tz), tz);
            const isToday = day === today;
            const live = appts.filter((a) => isLive(a.item.status)).length;
            return (
              <div
                key={day}
                style={{
                  padding: '8px 6px',
                  textAlign: 'center',
                  borderInlineStart: '1px solid var(--shell-border-soft)',
                  background: isToday ? 'var(--nav-active-bg)' : undefined,
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--nav-inactive-text)' }}>{weekdayLabel(p.weekday)}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isToday ? 'var(--gold-deep)' : 'var(--ink)' }}>{p.day}</div>
                <div style={{ fontSize: 11, color: 'var(--muted-2)', minHeight: 15 }}>
                  {windows.length === 0 && live === 0 ? t('sched.cal.day_off') : live > 0 ? t('sched.cal.day_load', { count: live }) : ''}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: columns }}>
          <div style={{ position: 'relative', height }}>
            {halfHours
              .filter((m) => m % 60 === 0)
              .map((m) => (
                <div
                  key={m}
                  style={{ position: 'absolute', top: (m - fromMin) * PX_PER_MIN + 2, insetInline: 0, textAlign: 'center', fontSize: 11, color: 'var(--muted-2)' }}
                >
                  {hhmm(m)}
                </div>
              ))}
          </div>

          {perDay.map(({ day, appts, offs, windows }) => {
            const placedAppts = layout(appts, fromMin);
            const placedOffs = layout(offs, fromMin);
            const isToday = day === today;
            return (
              <div
                key={day}
                style={{
                  position: 'relative',
                  height,
                  borderInlineStart: '1px solid var(--shell-border-soft)',
                  background: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--line-soft) ${HOUR_PX - 1}px, var(--line-soft) ${HOUR_PX}px), var(--shell-content-bg)`,
                }}
              >
                {windows.map((w) => (
                  <div
                    key={w.start}
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: (Math.max(w.start, fromMin) - fromMin) * PX_PER_MIN,
                      height: (Math.min(w.end, toMin) - Math.max(w.start, fromMin)) * PX_PER_MIN,
                      insetInline: 0,
                      background: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--line-soft) ${HOUR_PX - 1}px, var(--line-soft) ${HOUR_PX}px), var(--paper)`,
                      backgroundPositionY: `${-((Math.max(w.start, fromMin) - fromMin) % 60) * PX_PER_MIN}px`,
                    }}
                  />
                ))}

                {onCreate &&
                  halfHours.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="cal-cell"
                      onClick={() => onCreate(day, m)}
                      aria-label={`${t('sched.cal.new')} · ${day} ${hhmm(m)}`}
                      style={{ position: 'absolute', top: (m - fromMin) * PX_PER_MIN, height: 30 * PX_PER_MIN, insetInline: 0 }}
                    />
                  ))}

                {placedOffs.map((p) => (
                  <button
                    key={p.item.id}
                    type="button"
                    onClick={() => onOpenTimeOff?.(p.item)}
                    disabled={!onOpenTimeOff}
                    style={{
                      position: 'absolute',
                      top: p.top,
                      height: p.height,
                      insetInlineStart: 2,
                      insetInlineEnd: 2,
                      background: HATCH,
                      border: '1px solid var(--shell-border)',
                      borderRadius: 6,
                      padding: '4px 7px',
                      textAlign: 'start',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      color: 'var(--ink-soft)',
                      cursor: onOpenTimeOff ? 'pointer' : 'default',
                      overflow: 'hidden',
                    }}
                  >
                    <strong>{t('sched.cal.blocked')}</strong>
                    {p.item.reason ? ` · ${p.item.reason}` : ''}
                  </button>
                ))}

                {placedAppts.map((p) => (
                  <AppointmentBlock key={p.item.id} placed={p} tz={tz} onOpen={onOpen} />
                ))}

                {isToday && nowMin >= fromMin && nowMin <= toMin && (
                  <div
                    aria-label={t('sched.cal.now')}
                    style={{
                      position: 'absolute',
                      top: (nowMin - fromMin) * PX_PER_MIN,
                      insetInline: 0,
                      height: 2,
                      background: 'var(--danger)',
                      zIndex: 1,
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AppointmentBlock({ placed, tz, onOpen }: { placed: Placed<CalendarAppointment>; tz: string; onOpen: (a: CalendarAppointment) => void }) {
  const a = placed.item;
  const look = TYPE_STYLE[a.type.color];
  const pending = a.status === 'pending';
  const inactive = !isLive(a.status);
  const width = 100 / placed.lanes;
  const time = `${formatTime(a.starts_at, tz)}–${formatTime(a.ends_at, tz)}`;
  const name = personName(a);
  const clinical = a.clinical;

  return (
    <button
      type="button"
      onClick={() => onOpen(a)}
      aria-label={`${name}, ${time}, ${a.type.name}, ${statusLabel(a.status)}`}
      style={{
        position: 'absolute',
        top: placed.top + 1,
        height: placed.height - 2,
        insetInlineStart: `calc(${placed.lane * width}% + 3px)`,
        width: `calc(${width}% - 6px)`,
        boxSizing: 'border-box',
        borderRadius: 7,
        padding: '4px 7px',
        textAlign: 'start',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.3,
        overflow: 'hidden',
        cursor: 'pointer',
        zIndex: 1,
        opacity: inactive && a.status !== 'attended' ? 0.55 : 1,
        ...(pending
          ? { background: 'var(--white)', color: 'var(--ink)', border: '1.5px dashed var(--gold-deep)' }
          : {
              background: look.background,
              color: look.color,
              border: 'none',
              borderInlineStart: `3px solid ${look.accent}`,
            }),
      }}
    >
      <div style={{ fontWeight: 700, textDecoration: inactive && a.status !== 'attended' && a.status !== 'no_show' ? 'line-through' : undefined, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {a.status === 'attended' ? '✓ ' : a.status === 'no_show' ? '✕ ' : ''}
        {name}
      </div>
      {placed.height >= 38 && (
        <div style={{ opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {time} · {a.type.name}
        </div>
      )}
      {placed.height >= 58 && (
        <div style={{ marginTop: 3, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {pending && <MiniTag tone="gold">{statusLabel('pending')}</MiniTag>}
          {a.status === 'no_show' && <MiniTag tone="red">{statusLabel('no_show')}</MiniTag>}
          {isLead(a) && <MiniTag tone="gold">{t('sched.lead')}</MiniTag>}
          {clinical?.phase_n != null && (
            <MiniTag tone={clinical.low_adherence ? 'red' : 'green'}>
              {t('sched.cal.phase', { n: clinical.phase_n })}
              {clinical.adherence != null ? ` · ${clinical.adherence}%` : ''}
            </MiniTag>
          )}
        </div>
      )}
    </button>
  );
}

function MiniTag({ tone, children }: { tone: 'gold' | 'green' | 'red'; children: ReactNode }) {
  const tones = {
    gold: { background: 'var(--warn-bg)', color: 'var(--gold-deep)' },
    green: { background: 'var(--pill-good-bg)', color: 'var(--flag-green)' },
    red: { background: 'var(--pill-attention-bg)', color: 'var(--flag-red)' },
  };
  return (
    <span style={{ ...tones[tone], borderRadius: 'var(--radius-pill)', padding: '0 6px', fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
