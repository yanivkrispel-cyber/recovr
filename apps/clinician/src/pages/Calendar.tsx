import { useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button, EmptyState, QueryError, Skeleton, useIsPhone, useIsTablet } from 'ui';
import {
  addDays,
  clinicDate,
  formatDayLong,
  formatLocalDate,
  formatTime,
  isLive,
  t,
  weekStart,
  windowsOn,
  zonedTimeToUtc,
  type CalendarAppointment,
  type TimeOff,
} from 'shared';
import { AuthContext } from '../App';
import AppShell from '../components/AppShell';
import WeekGrid from '../components/calendar/WeekGrid';
import AppointmentDrawer from '../components/calendar/AppointmentDrawer';
import NewAppointmentModal from '../components/calendar/NewAppointmentModal';
import TimeOffModal from '../components/calendar/TimeOffModal';
import RequestsPanel from '../components/calendar/RequestsPanel';
import { Chevron, PlusIcon, StatusPill, TypeSwatch, iconButton, isLead, panelStyle, personName } from '../components/calendar/calendarUi';
import { useCalendarRange, useSchedulingSetup } from '../lib/scheduling';
import '../calendar.css';

export type CalendarView = 'week' | 'day';

export default function Calendar() {
  const { user } = useContext(AuthContext);
  const search = useSearch({ strict: false }) as { date?: string; view?: CalendarView };
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const isTablet = useIsTablet();
  const editable = !isTablet;

  const setup = useSchedulingSetup();
  const tz = setup.data?.timezone ?? 'Asia/Jerusalem';
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const today = clinicDate(now, tz);
  const anchor = search.date ?? today;
  const view: CalendarView = isPhone ? 'day' : (search.view ?? 'week');
  const rangeDays = useMemo(
    () => (view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i)) : [anchor]),
    [view, anchor],
  );
  const from = zonedTimeToUtc(rangeDays[0], '00:00', tz).toISOString();
  const to = zonedTimeToUtc(addDays(rangeDays[rangeDays.length - 1], 1), '00:00', tz).toISOString();
  const calendar = useCalendarRange(from, to);

  const [showCancelled, setShowCancelled] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ date: string; minutes: number } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [offTarget, setOffTarget] = useState<'new' | TimeOff | null>(null);
  const [openRequest, setOpenRequest] = useState<CalendarAppointment | null>(null);

  const myRules = useMemo(
    () => (setup.data?.availability ?? []).filter((r) => r.practitioner_id === setup.data?.me),
    [setup.data],
  );
  const appointments = useMemo(
    () => (calendar.data?.appointments ?? []).filter((a) => showCancelled || isLive(a.status)),
    [calendar.data, showCancelled],
  );

  // The Israeli week is Sunday–Thursday; Friday/Saturday show up only when
  // something lives there.
  const days = useMemo(() => {
    if (view === 'day') return rangeDays;
    return rangeDays.filter((d, i) => {
      if (i < 5) return true;
      return (
        windowsOn(myRules, d).length > 0 ||
        appointments.some((a) => clinicDate(a.starts_at, tz) === d) ||
        (calendar.data?.time_off ?? []).some((o) => clinicDate(o.starts_at, tz) <= d && clinicDate(o.ends_at, tz) >= d)
      );
    });
  }, [view, rangeDays, myRules, appointments, calendar.data, tz]);

  const opened = openRequest ?? calendar.data?.appointments.find((a) => a.id === openId) ?? null;

  function go(date: string, nextView: CalendarView = view) {
    navigate({ to: '/calendar', search: { date: date === today ? undefined : date, view: nextView === 'week' ? undefined : nextView } });
  }

  if (!user) return null;

  const notConfigured = setup.data && setup.data.types.length === 0 && setup.data.availability.length === 0;
  const step = view === 'week' ? 7 : 1;
  const title =
    view === 'week'
      ? `${formatLocalDate(days[0], 'short')} – ${formatLocalDate(days[days.length - 1], 'short')}`
      : formatLocalDate(anchor, 'long');

  const live = (calendar.data?.appointments ?? []).filter((a) => isLive(a.status));
  const stats = [
    { label: t('sched.cal.stats.week'), value: live.length },
    { label: t('sched.cal.stats.pending'), value: calendar.data?.pending_count ?? 0 },
    { label: t('sched.cal.stats.no_show'), value: live.filter((a) => a.status === 'no_show').length },
  ];

  return (
    <AppShell user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>
            {t('sched.cal.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>{t('sched.cal.nav_en')}</span>
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginInlineStart: 8 }}>
            <button type="button" style={iconButton} onClick={() => go(addDays(anchor, -step))} aria-label={view === 'week' ? t('sched.cal.prev_week') : t('sched.cal.prev_day')}>
              <Chevron dir="prev" />
            </button>
            <span style={{ minWidth: 150, textAlign: 'center', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }} aria-live="polite">
              {title}
            </span>
            <button type="button" style={iconButton} onClick={() => go(addDays(anchor, step))} aria-label={view === 'week' ? t('sched.cal.next_week') : t('sched.cal.next_day')}>
              <Chevron dir="next" />
            </button>
            <button type="button" style={{ ...iconButton, width: 'auto', padding: '0 12px', fontSize: 13 }} onClick={() => go(today)} disabled={anchor === today}>
              {t('sched.cal.today')}
            </button>
          </div>
          {!isPhone && (
            <div role="group" aria-label={t('sched.cal.view.week')} style={{ display: 'flex', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-button)', overflow: 'hidden' }}>
              {(['week', 'day'] as CalendarView[]).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => go(anchor, v)} style={toggleStyle(view === v)}>
                  {t(v === 'week' ? 'sched.cal.view.week' : 'sched.cal.view.day')}
                </button>
              ))}
            </div>
          )}
          <div style={{ flex: 1 }} />
          {!isPhone && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--nav-inactive-text)' }}>
              <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
              {t('sched.cal.show_cancelled')}
            </label>
          )}
          <Link to="/calendar/setup" style={{ fontSize: 13, color: 'var(--gold-deep)', fontWeight: 600 }}>
            {t('sched.cal.setup')}
          </Link>
          {editable && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setOffTarget('new')}>
                {t('sched.cal.block')}
              </Button>
              <Button
                size="sm"
                iconLeft={<PlusIcon />}
                onClick={() => {
                  setCreating(null);
                  setNewOpen(true);
                }}
              >
                {t('sched.cal.new')}
              </Button>
            </>
          )}
        </header>

        {setup.error ? (
          <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => setup.refetch()} />
        ) : notConfigured ? (
          <EmptyState
            title={t('sched.cal.no_setup.title')}
            body={t('sched.cal.no_setup.body')}
            action={<Button onClick={() => navigate({ to: '/calendar/setup' })}>{t('sched.cal.no_setup.action')}</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: '999 1 620px', minWidth: 0, ...panelStyle, overflow: 'hidden' }}>
              {calendar.error ? (
                <div style={{ padding: 16 }}>
                  <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => calendar.refetch()} />
                </div>
              ) : !calendar.data || !setup.data ? (
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-label={t('sched.cal.loading')}>
                  <Skeleton height={44} radius={8} />
                  <Skeleton count={6} height={52} radius={8} />
                </div>
              ) : isPhone ? (
                <DayAgenda day={anchor} tz={tz} appointments={appointments} timeOff={calendar.data.time_off} onOpen={(a) => setOpenId(a.id)} />
              ) : (
                <WeekGrid
                  days={days}
                  tz={tz}
                  rules={myRules}
                  appointments={appointments}
                  timeOff={calendar.data.time_off}
                  now={now}
                  onCreate={
                    editable
                      ? (date, minutes) => {
                          setCreating({ date, minutes });
                          setNewOpen(true);
                        }
                      : undefined
                  }
                  onOpen={(a) => setOpenId(a.id)}
                  onOpenTimeOff={editable ? (o) => setOffTarget(o) : undefined}
                />
              )}
            </div>

            <aside style={{ flex: '1 1 280px', maxWidth: isPhone ? undefined : 340, display: 'flex', flexDirection: 'column', gap: 16, order: isPhone ? -1 : 0 }}>
              <RequestsPanel tz={tz} onOpen={(a) => setOpenRequest(a)} />
              {!isPhone && (
                <section aria-label={t('sched.cal.stats.week')} style={{ ...panelStyle, background: 'var(--navy)', border: 'none', color: 'var(--cream)', padding: 14, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, textAlign: 'center' }}>
                  {stats.map((s) => (
                    <div key={s.label}>
                      <div style={{ fontSize: 22, fontWeight: 700 }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: 'var(--line-input)' }}>{s.label}</div>
                    </div>
                  ))}
                </section>
              )}
              {!isPhone && setup.data && (
                <section style={{ ...panelStyle, padding: 14, display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
                  {setup.data.types.filter((ty) => ty.active).map((ty) => (
                    <span key={ty.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-soft)' }}>
                      <TypeSwatch color={ty.color} /> {ty.name}
                    </span>
                  ))}
                </section>
              )}
            </aside>
          </div>
        )}
      </div>

      {setup.data && (
        <>
          <AppointmentDrawer
            appointment={opened}
            tz={tz}
            types={setup.data.types}
            rules={myRules}
            editable={editable}
            onClose={() => {
              setOpenId(null);
              setOpenRequest(null);
            }}
          />
          {newOpen && (
            <NewAppointmentModal open onClose={() => setNewOpen(false)} tz={tz} types={setup.data.types} rules={myRules} initial={creating ?? { date: anchor, minutes: 9 * 60 }} />
          )}
          <TimeOffModal target={offTarget} defaultDate={anchor} tz={tz} onClose={() => setOffTarget(null)} />
        </>
      )}
    </AppShell>
  );
}

function toggleStyle(active: boolean): CSSProperties {
  return {
    padding: '0 14px',
    height: 36,
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
    background: active ? 'var(--navy)' : 'var(--shell-sidebar-bg)',
    color: active ? 'var(--cream)' : 'var(--nav-inactive-text)',
    fontWeight: active ? 700 : 500,
  };
}

/** Phone: one day as a list — the clinician's "who's next" view. */
function DayAgenda({ day, tz, appointments, timeOff, onOpen }: { day: string; tz: string; appointments: CalendarAppointment[]; timeOff: TimeOff[]; onOpen: (a: CalendarAppointment) => void }) {
  const items = appointments.filter((a) => clinicDate(a.starts_at, tz) === day);
  const offs = timeOff.filter((o) => clinicDate(o.starts_at, tz) <= day && clinicDate(o.ends_at, tz) >= day);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 14px', fontSize: 14, fontWeight: 700, color: 'var(--ink)', borderBottom: '1px solid var(--shell-border-soft)' }}>
        {formatDayLong(zonedTimeToUtc(day, '12:00', tz), tz)}
      </div>
      {offs.map((o) => (
        <div key={o.id} style={{ padding: '10px 14px', fontSize: 13, color: 'var(--ink-soft)', borderBottom: '1px solid var(--shell-border-soft)' }}>
          {formatTime(o.starts_at, tz)}–{formatTime(o.ends_at, tz)} · {t('sched.cal.blocked')}
          {o.reason ? ` · ${o.reason}` : ''}
        </div>
      ))}
      {items.length === 0 && offs.length === 0 && (
        <p style={{ margin: 0, padding: '24px 14px', fontSize: 14, color: 'var(--muted)', textAlign: 'center' }}>{t('sched.cal.empty_day')}</p>
      )}
      {items.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            minHeight: 56,
            border: 'none',
            borderBottom: '1px solid var(--shell-border-soft)',
            background: a.status === 'pending' ? 'var(--warn-bg)' : 'transparent',
            textAlign: 'start',
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 48, flex: 'none', fontSize: 15, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
            {formatTime(a.starts_at, tz)}
          </span>
          <TypeSwatch color={a.type.color} size={12} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {personName(a)}
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {a.type.name}
              {isLead(a) ? ` · ${t('sched.lead')}` : ''}
            </span>
          </span>
          <StatusPill status={a.status} />
        </button>
      ))}
    </div>
  );
}
