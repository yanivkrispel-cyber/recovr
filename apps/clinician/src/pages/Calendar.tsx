import { useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button, EmptyState, QueryError, Skeleton, useIsPhone, useToast } from 'ui';
import {
  addDays,
  addMonths,
  clinicDate,
  dayUtilisation,
  formatDateRange,
  formatLocalDate,
  formatMinutes,
  formatMonthTitle,
  isLive,
  monthGrid,
  monthStart,
  t,
  weekStart,
  windowsOn,
  zonedTimeToUtc,
  type CalendarAppointment,
  type CalendarSummary,
  type I18nKey,
  type TimeOff,
} from 'shared';
import { AuthContext } from '../App';
import AppShell from '../components/AppShell';
import { PHONE_HEADER_HEIGHT } from '../components/PhoneShell';
import WeekGrid from '../components/calendar/WeekGrid';
import DayAgenda from '../components/calendar/DayAgenda';
import WeekStrip from '../components/calendar/WeekStrip';
import BottomSheet from '../components/calendar/BottomSheet';
import { KpiTiles, MonthOverview, WeekOverview } from '../components/calendar/Overview';
import AppointmentDrawer from '../components/calendar/AppointmentDrawer';
import NewAppointmentModal from '../components/calendar/NewAppointmentModal';
import TimeOffModal from '../components/calendar/TimeOffModal';
import RequestsPanel from '../components/calendar/RequestsPanel';
import { Chevron, PlusIcon, Segmented, TypeSwatch, iconButton, panelStyle, useHorizontalSwipe } from '../components/calendar/calendarUi';
import {
  useBookingRequestCount,
  useCalendarRange,
  useCalendarSummary,
  useSchedulingSetup,
  useUpdateAppointment,
  type AppointmentPatch,
} from '../lib/scheduling';
import '../calendar.css';

export type CalendarView = 'day' | 'week' | 'month';
type DayMode = 'list' | 'timeline';

const DAY_MODE_KEY = 'recoveryos.calendar.day-mode';

function readDayMode(): DayMode {
  try {
    return localStorage.getItem(DAY_MODE_KEY) === 'timeline' ? 'timeline' : 'list';
  } catch {
    return 'list';
  }
}

function byDate(summary: CalendarSummary | undefined) {
  return new Map((summary?.days ?? []).map((d) => [d.date, d]));
}

export default function Calendar() {
  const { user } = useContext(AuthContext);
  const search = useSearch({ strict: false }) as { date?: string; view?: CalendarView };
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const toast = useToast();

  const setup = useSchedulingSetup();
  const tz = setup.data?.timezone ?? 'Asia/Jerusalem';
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const today = clinicDate(now, tz);
  const anchor = search.date ?? today;
  // A phone opens on the day ("who's next"), a desktop on the week.
  const defaultView: CalendarView = isPhone ? 'day' : 'week';
  const view: CalendarView = search.view ?? defaultView;

  // Appointments are fetched a week at a time, so moving between days of the
  // week (strip, swipe) is instant.
  const week0 = weekStart(anchor);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week0, i)), [week0]);
  const calendar = useCalendarRange(
    zonedTimeToUtc(week0, '00:00', tz).toISOString(),
    zonedTimeToUtc(addDays(week0, 7), '00:00', tz).toISOString(),
    view !== 'month',
  );
  const weekSummary = useCalendarSummary(week0, addDays(week0, 6), view !== 'month');
  const grid = monthGrid(anchor);
  const monthSummary = useCalendarSummary(grid[0].date, grid[grid.length - 1].date, view === 'month');
  const horizon0 = weekStart(today);
  const horizon = useCalendarSummary(horizon0, addDays(horizon0, 27), view === 'month');
  const { data: pendingCount = 0 } = useBookingRequestCount();
  const update = useUpdateAppointment();

  const weekMap = useMemo(() => byDate(weekSummary.data), [weekSummary.data]);
  const monthMap = useMemo(() => byDate(monthSummary.data), [monthSummary.data]);
  const slotMin = weekSummary.data?.slot_min ?? monthSummary.data?.slot_min ?? 45;
  const hasPrices = (setup.data?.types ?? []).some((ty) => (ty.price_ils ?? 0) > 0);

  const [showCancelled, setShowCancelled] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<CalendarAppointment | null>(null);
  const [creating, setCreating] = useState<{ date: string; minutes: number } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [offTarget, setOffTarget] = useState<'new' | TimeOff | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [dayMode, setDayModeState] = useState<DayMode>(readDayMode);

  const myRules = useMemo(
    () => (setup.data?.availability ?? []).filter((r) => r.practitioner_id === setup.data?.me),
    [setup.data],
  );
  const appointments = useMemo(
    () => (calendar.data?.appointments ?? []).filter((a) => showCancelled || isLive(a.status)),
    [calendar.data, showCancelled],
  );

  // Desktop week: the Israeli week is Sunday–Thursday; Friday/Saturday show
  // up only when something lives there.
  const gridDays = useMemo(() => {
    if (view === 'day') return [anchor];
    return weekDays.filter((d, i) => {
      if (i < 5) return true;
      return (
        windowsOn(myRules, d).length > 0 ||
        appointments.some((a) => clinicDate(a.starts_at, tz) === d) ||
        (calendar.data?.time_off ?? []).some((o) => clinicDate(o.starts_at, tz) <= d && clinicDate(o.ends_at, tz) >= d)
      );
    });
  }, [view, anchor, weekDays, myRules, appointments, calendar.data, tz]);

  const opened = openRequest ?? calendar.data?.appointments.find((a) => a.id === openId) ?? null;

  function go(date: string, nextView: CalendarView = view) {
    navigate({ to: '/calendar', search: { date: date === today ? undefined : date, view: nextView === defaultView ? undefined : nextView } });
  }

  function step(delta: 1 | -1) {
    if (view === 'month') go(monthStart(addMonths(anchor, delta)));
    else go(addDays(anchor, view === 'week' ? delta * 7 : delta));
  }

  const swipe = useHorizontalSwipe(step);

  function setDayMode(mode: DayMode) {
    setDayModeState(mode);
    try {
      localStorage.setItem(DAY_MODE_KEY, mode);
    } catch {
      // private mode / blocked storage: the choice just isn't remembered
    }
  }

  function openNew(at: { date: string; minutes: number } | null) {
    setCreating(at);
    setNewOpen(true);
  }

  /** One-tap status changes from the phone's day list. */
  async function quick(a: CalendarAppointment, patch: AppointmentPatch, success: I18nKey) {
    try {
      const res = await update.mutateAsync({ id: a.id, patch });
      toast.show(t(success), { tone: 'success' });
      if (res.emailed === true) toast.show(t('sched.appt.toast.emailed'));
      if (res.emailed === false && (a.patient?.email || a.lead?.email)) toast.show(t('sched.appt.toast.email_failed'), { tone: 'error' });
    } catch {
      toast.show(t('error.save.body'), { tone: 'error' });
    }
  }

  if (!user) return null;

  const notConfigured = setup.data && setup.data.types.length === 0 && setup.data.availability.length === 0;
  const busyId = update.isPending ? (update.variables?.id ?? null) : null;
  const loading = (
    <div style={{ padding: isPhone ? 0 : 16, display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-label={t('sched.cal.loading')}>
      <Skeleton height={44} radius={8} />
      <Skeleton count={6} height={52} radius={8} />
    </div>
  );
  const calendarError = (
    <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => calendar.refetch()} />
  );

  const month =
    monthSummary.data && setup.data ? (
      <MonthOverview
        key={monthStart(anchor)}
        anchor={anchor}
        monthDays={monthMap}
        horizonDays={horizon.data?.days ?? []}
        today={today}
        slotMin={slotMin}
        hasPrices={hasPrices}
        wide={!isPhone}
        onOpenDay={(d) => go(d, 'day')}
        onMonth={(delta) => go(monthStart(addMonths(anchor, delta)), 'month')}
      />
    ) : monthSummary.error ? (
      <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => monthSummary.refetch()} />
    ) : (
      loading
    );

  let body: ReactNode;
  if (setup.error) {
    body = <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => setup.refetch()} />;
  } else if (notConfigured) {
    body = (
      <EmptyState
        title={t('sched.cal.no_setup.title')}
        body={t('sched.cal.no_setup.body')}
        action={<Button onClick={() => navigate({ to: '/calendar/setup' })}>{t('sched.cal.no_setup.action')}</Button>}
      />
    );
  } else if (isPhone) {
    const daySummary = weekMap.get(anchor);
    body = (
      // Room under the content for the floating "+" button.
      <div {...swipe} style={{ paddingBottom: 72 }}>
        {view === 'month' ? (
          month
        ) : view === 'week' ? (
          weekSummary.data ? (
            <WeekOverview days={weekDays} summary={weekMap} today={today} slotMin={slotMin} hasPrices={hasPrices} onOpenDay={(d) => go(d, 'day')} />
          ) : weekSummary.error ? (
            <QueryError title={t('error.generic.title')} body={t('error.generic.body')} retryLabel={t('error.generic.action')} onRetry={() => weekSummary.refetch()} />
          ) : (
            loading
          )
        ) : calendar.error ? (
          calendarError
        ) : !calendar.data || !setup.data ? (
          loading
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--navy)' }}>{formatLocalDate(anchor, 'long')}</h2>
                {daySummary && (daySummary.available_min > 0 || daySummary.appointments > 0) && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {t('sched.mobile.day_summary', { count: daySummary.appointments, free: formatMinutes(daySummary.free_min), pct: dayUtilisation(daySummary) })}
                  </div>
                )}
              </div>
              <DayModeToggle mode={dayMode} onChange={setDayMode} />
            </div>
            {dayMode === 'list' ? (
              <DayAgenda
                day={anchor}
                tz={tz}
                now={now}
                rules={myRules}
                appointments={calendar.data.appointments}
                timeOff={calendar.data.time_off}
                slotMin={slotMin}
                busyId={busyId}
                onOpen={(a) => setOpenId(a.id)}
                onBook={(date, minutes) => openNew({ date, minutes })}
                onApprove={(a) => quick(a, { status: 'confirmed' }, 'sched.appt.toast.approved')}
                onArrived={(a) => quick(a, { status: 'attended' }, 'sched.appt.toast.saved')}
              />
            ) : (
              <div style={{ ...panelStyle, overflow: 'hidden' }}>
                <WeekGrid
                  days={[anchor]}
                  hideHeader
                  tz={tz}
                  rules={myRules}
                  appointments={appointments}
                  timeOff={calendar.data.time_off}
                  now={now}
                  onCreate={(date, minutes) => openNew({ date, minutes })}
                  onOpen={(a) => setOpenId(a.id)}
                  onOpenTimeOff={(o) => setOffTarget(o)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 620px', minWidth: 0, ...(view === 'month' ? {} : { ...panelStyle, overflow: 'hidden' }) }}>
          {view === 'month' ? (
            month
          ) : calendar.error ? (
            <div style={{ padding: 16 }}>{calendarError}</div>
          ) : !calendar.data || !setup.data ? (
            loading
          ) : (
            <WeekGrid
              days={gridDays}
              tz={tz}
              rules={myRules}
              appointments={appointments}
              timeOff={calendar.data.time_off}
              now={now}
              onCreate={(date, minutes) => openNew({ date, minutes })}
              onOpen={(a) => setOpenId(a.id)}
              onOpenTimeOff={(o) => setOffTarget(o)}
            />
          )}
        </div>

        <aside style={{ flex: '1 1 280px', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <RequestsPanel tz={tz} onOpen={(a) => setOpenRequest(a)} />
          {view !== 'month' && weekSummary.data && <KpiTiles totals={weekSummary.data.totals} slotMin={slotMin} scope="week" hasPrices={hasPrices} />}
          {setup.data && (
            <section style={{ ...panelStyle, padding: 14, display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
              {setup.data.types
                .filter((ty) => ty.active)
                .map((ty) => (
                  <span key={ty.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-soft)' }}>
                    <TypeSwatch color={ty.color} /> {ty.name}
                  </span>
                ))}
            </section>
          )}
        </aside>
      </div>
    );
  }

  const viewOptions: { value: CalendarView; label: string }[] = [
    { value: 'day', label: t('sched.cal.view.day') },
    { value: 'week', label: t('sched.cal.view.week') },
    { value: 'month', label: t('sched.cal.view.month') },
  ];
  const sheetOpen = newOpen || offTarget !== null || !!opened || requestsOpen;

  return (
    <AppShell user={user}>
      {isPhone ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Sticks under the shell's logo bar: the month, the view and the week stay in sight. */}
          <div
            style={{
              position: 'sticky',
              top: `calc(${PHONE_HEADER_HEIGHT}px + env(safe-area-inset-top))`,
              zIndex: 'var(--z-sticky)',
              margin: '-16px -16px 0',
              padding: '8px 16px 6px',
              background: 'var(--shell-sidebar-bg)',
              borderBottom: '1px solid var(--shell-border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <h1 style={{ margin: 0 }}>
                <button
                  type="button"
                  onClick={() => go(anchor, 'month')}
                  aria-label={`${formatMonthTitle(anchor)} · ${t('sched.cal.pick_month')}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: '4px 0', cursor: 'pointer', color: 'var(--navy)', fontFamily: 'inherit' }}
                >
                  <span style={{ fontSize: 23, fontWeight: 800 }}>{formatMonthTitle(anchor)}</span>
                  {view !== 'month' && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  )}
                </button>
              </h1>
              <div style={{ flex: 1 }} />
              {!notConfigured && (
                <button
                  type="button"
                  onClick={() => setRequestsOpen(true)}
                  aria-label={pendingCount ? t('sched.cal.requests.banner', { count: pendingCount }) : t('sched.mobile.requests')}
                  style={{ position: 'relative', width: 44, height: 44, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--navy)' }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
                    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" />
                  </svg>
                  {pendingCount > 0 && <span style={badgeStyle}>{pendingCount}</span>}
                </button>
              )}
              <button type="button" onClick={() => go(today)} disabled={anchor === today} style={{ ...todayStyle, opacity: anchor === today ? 0.55 : 1 }}>
                {t('sched.cal.today')}
              </button>
            </div>
            {!notConfigured && (
              <>
                <Segmented label={t('sched.cal.title')} options={viewOptions} value={view} onChange={(v) => go(anchor, v)} />
                {view !== 'month' && (
                  <WeekStrip days={weekDays} selected={anchor} today={today} summary={weekMap} onPick={(d) => go(d, 'day')} onWeek={(delta) => go(addDays(anchor, delta * 7))} />
                )}
              </>
            )}
          </div>
          {body}
          {setup.data && !notConfigured && !sheetOpen && (
            <button type="button" aria-label={t('sched.mobile.new_or_block')} onClick={() => openNew(null)} style={fabStyle}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>
              {t('sched.cal.title')} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--nav-inactive-text)' }}>{t('sched.cal.nav_en')}</span>
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginInlineStart: 8 }}>
              <button type="button" style={iconButton} onClick={() => step(-1)} aria-label={t(view === 'month' ? 'sched.cal.month_prev' : view === 'week' ? 'sched.cal.prev_week' : 'sched.cal.prev_day')}>
                <Chevron dir="prev" />
              </button>
              <span style={{ minWidth: 190, display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.25 }} aria-live="polite">
                <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--navy)' }}>{formatMonthTitle(anchor)}</span>
                {view !== 'month' && (
                  <span style={{ fontSize: 12.5, color: 'var(--nav-inactive-text)' }}>
                    {view === 'week' ? formatDateRange(gridDays[0], gridDays[gridDays.length - 1]) : formatLocalDate(anchor, 'long')}
                  </span>
                )}
              </span>
              <button type="button" style={iconButton} onClick={() => step(1)} aria-label={t(view === 'month' ? 'sched.cal.month_next' : view === 'week' ? 'sched.cal.next_week' : 'sched.cal.next_day')}>
                <Chevron dir="next" />
              </button>
              <button type="button" style={{ ...iconButton, width: 'auto', padding: '0 12px', fontSize: 13 }} onClick={() => go(today)} disabled={anchor === today}>
                {t('sched.cal.today')}
              </button>
            </div>
            <div role="group" aria-label={t('sched.cal.title')} style={{ display: 'flex', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-button)', overflow: 'hidden' }}>
              {(['week', 'day', 'month'] as CalendarView[]).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => go(anchor, v)} style={toggleStyle(view === v)}>
                  {t(`sched.cal.view.${v}`)}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {view !== 'month' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--nav-inactive-text)' }}>
                <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
                {t('sched.cal.show_cancelled')}
              </label>
            )}
            <Link to="/calendar/setup" style={{ fontSize: 13, color: 'var(--gold-deep)', fontWeight: 600 }}>
              {t('sched.cal.setup')}
            </Link>
            <Button variant="secondary" size="sm" onClick={() => setOffTarget('new')}>
              {t('sched.cal.block')}
            </Button>
            <Button size="sm" iconLeft={<PlusIcon />} onClick={() => openNew(null)}>
              {t('sched.cal.new')}
            </Button>
          </header>
          {body}
        </div>
      )}

      {setup.data && (
        <>
          <AppointmentDrawer
            appointment={opened}
            tz={tz}
            types={setup.data.types}
            rules={myRules}
            editable
            variant={isPhone ? 'sheet' : 'drawer'}
            onClose={() => {
              setOpenId(null);
              setOpenRequest(null);
            }}
          />
          {newOpen && (
            <NewAppointmentModal
              onClose={() => setNewOpen(false)}
              tz={tz}
              types={setup.data.types}
              rules={myRules}
              initial={creating}
              defaultDate={anchor < today ? today : anchor}
              sheet={isPhone}
              onSwitchToBlock={
                isPhone
                  ? () => {
                      setNewOpen(false);
                      setOffTarget('new');
                    }
                  : undefined
              }
            />
          )}
          <TimeOffModal
            target={offTarget}
            defaultDate={anchor < today ? today : anchor}
            tz={tz}
            onClose={() => setOffTarget(null)}
            sheet={isPhone}
            onSwitchToAppointment={
              isPhone
                ? () => {
                    setOffTarget(null);
                    openNew(null);
                  }
                : undefined
            }
          />
          {isPhone && (
            <BottomSheet open={requestsOpen} onClose={() => setRequestsOpen(false)} title={t('sched.mobile.requests')}>
              <RequestsPanel
                bare
                tz={tz}
                onOpen={(a) => {
                  setRequestsOpen(false);
                  setOpenRequest(a);
                }}
              />
            </BottomSheet>
          )}
        </>
      )}
    </AppShell>
  );
}

function DayModeToggle({ mode, onChange }: { mode: DayMode; onChange: (mode: DayMode) => void }) {
  const button = (m: DayMode, label: string, icon: ReactNode) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      style={{
        width: 42,
        height: 36,
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: mode === m ? 'var(--navy)' : 'var(--white)',
        color: mode === m ? 'var(--cream)' : 'var(--navy)',
      }}
    >
      {icon}
    </button>
  );
  return (
    <div role="group" style={{ display: 'flex', border: '1px solid var(--shell-border)', borderRadius: 8, overflow: 'hidden', flex: 'none' }}>
      {button(
        'list',
        t('sched.mobile.view_list'),
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
        </svg>,
      )}
      {button(
        'timeline',
        t('sched.mobile.view_timeline'),
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 4v16M8 7h9v4H8zM8 14h12v4H8z" />
        </svg>,
      )}
    </div>
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

const todayStyle: CSSProperties = {
  height: 36,
  padding: '0 14px',
  border: '1px solid var(--shell-border)',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--white)',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--navy)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const badgeStyle: CSSProperties = {
  position: 'absolute',
  top: 5,
  insetInlineStart: 22,
  minWidth: 18,
  height: 18,
  padding: '0 4px',
  boxSizing: 'border-box',
  borderRadius: 9,
  background: 'var(--danger)',
  color: 'var(--white)',
  fontSize: 11,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '2px solid var(--shell-sidebar-bg)',
};

// Above the 60px tab bar, at the thumb's side (inline end = left in RTL).
const fabStyle: CSSProperties = {
  position: 'fixed',
  insetInlineEnd: 16,
  bottom: 'calc(76px + env(safe-area-inset-bottom))',
  zIndex: 'var(--z-sticky)',
  width: 56,
  height: 56,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--gold-deep)',
  color: 'var(--white)',
  boxShadow: 'var(--shadow-modal)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
