import { useState, type CSSProperties } from 'react';
import {
  addDays,
  dayUtilisation,
  formatDateRange,
  formatILS,
  formatLocalDate,
  formatMinutes,
  monthGrid,
  sumDays,
  t,
  utilisationLevel,
  weekStart,
  weekdayOf,
  type CalendarDaySummary,
  type CalendarSummaryTotals,
  type I18nKey,
} from 'shared';
import { Chevron, HEAT, loadColor, panelStyle } from './calendarUi';

// The calendar's big picture: how full the week / month is, where the free
// time is, and what it's worth. Every number comes from app.calendar_summary.

const tile: CSSProperties = {
  background: 'var(--white)',
  border: '1px solid var(--line-soft)',
  borderRadius: 14,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
};

const hours = (min: number) => (min / 60).toFixed(min % 60 === 0 ? 0 : 1);

export function KpiTiles({ totals, slotMin, scope, hasPrices }: { totals: CalendarSummaryTotals; slotMin: number; scope: 'week' | 'month'; hasPrices: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
      <div style={tile}>
        <span style={labelStyle}>{t(scope === 'week' ? 'sched.kpi.utilisation_week' : 'sched.kpi.utilisation_month')}</span>
        <span style={valueStyle}>{totals.utilisation}%</span>
        <Bar pct={totals.utilisation} />
        <span style={subStyle}>{t('sched.kpi.hours_of', { booked: hours(totals.booked_min), total: hours(totals.available_min) })}</span>
      </div>
      <div style={tile}>
        <span style={labelStyle}>{t('sched.kpi.open_slots')}</span>
        <span style={{ ...valueStyle, color: 'var(--flag-green)' }}>{totals.open_slots}</span>
        <span style={subStyle}>{t('sched.kpi.open_slots_sub', { n: slotMin })}</span>
      </div>
      <div style={tile}>
        <span style={labelStyle}>{t('sched.kpi.requests')}</span>
        <span style={valueStyle}>
          <span style={{ color: totals.pending ? 'var(--gold-deep)' : undefined }}>{totals.pending}</span>
          {' · '}
          <span style={{ color: totals.no_show ? 'var(--flag-red)' : undefined }}>{totals.no_show}</span>
        </span>
        <span style={subStyle}>{t('sched.kpi.requests_sub', { count: totals.cancelled })}</span>
      </div>
      <div style={tile}>
        <span style={labelStyle}>{t('sched.kpi.revenue')}</span>
        {hasPrices ? (
          <>
            <span style={valueStyle}>{formatILS(Number(totals.revenue_expected))}</span>
            <span style={subStyle}>
              {t('sched.kpi.revenue_sub', { amount: formatILS(Number(totals.revenue_realised)) })}
              {Number(totals.revenue_pending) > 0 ? ` · ${t('sched.kpi.revenue_pending', { amount: formatILS(Number(totals.revenue_pending)) })}` : ''}
            </span>
          </>
        ) : (
          <span style={{ ...subStyle, color: 'var(--ink-soft)' }}>{t('sched.kpi.no_prices')}</span>
        )}
      </div>
    </div>
  );
}

function Bar({ pct, height = 6 }: { pct: number; height?: number }) {
  return (
    <span style={{ height, borderRadius: height / 2, background: 'var(--line-soft)', overflow: 'hidden', display: 'flex' }}>
      <span style={{ height: '100%', width: `${pct}%`, background: loadColor(pct) }} />
    </span>
  );
}

// --- week ---------------------------------------------------------------------

export function WeekOverview({
  days,
  summary,
  today,
  slotMin,
  hasPrices,
  onOpenDay,
}: {
  days: string[];
  summary: Map<string, CalendarDaySummary>;
  today: string;
  slotMin: number;
  hasPrices: boolean;
  onOpenDay: (date: string) => void;
}) {
  const rows = days.map((d) => summary.get(d)).filter((s): s is CalendarDaySummary => !!s);
  const totals = sumDays(rows);
  const openDays = rows.filter((s) => s.available_min > 0 || s.appointments > 0);
  const span = openDays.length ? [openDays[0].date, openDays[openDays.length - 1].date] : [days[0], days[days.length - 1]];
  const closedNames = rows.filter((s) => s.available_min === 0 && s.appointments === 0).map((s) => t(`sched.weekday.${weekdayOf(s.date)}` as I18nKey));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--navy)' }}>
        {t('sched.overview.week_title', { range: formatDateRange(span[0], span[1]) })}
      </div>
      <KpiTiles totals={totals} slotMin={slotMin} scope="week" hasPrices={hasPrices} />
      {openDays.map((s) => {
        const pct = dayUtilisation(s);
        const isToday = s.date === today;
        return (
          <button
            key={s.date}
            type="button"
            onClick={() => onOpenDay(s.date)}
            style={{ width: '100%', textAlign: 'start', background: 'var(--white)', borderRadius: 14, padding: '12px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'inherit', color: 'var(--ink)', border: isToday ? '2px solid var(--navy)' : '1px solid var(--line-soft)' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>{formatLocalDate(s.date, 'long')}</span>
              {isToday && <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 'var(--radius-pill)', padding: '2px 8px', background: 'var(--navy)', color: 'var(--cream)' }}>{t('sched.mobile.today')}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: pct >= 75 ? 'var(--gold-deep)' : 'var(--navy)', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
            </span>
            <Bar pct={pct} height={8} />
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 12.5, color: 'var(--muted)' }}>
              <span>{t('sched.overview.day_line', { count: s.appointments, free: formatMinutes(s.free_min) })}</span>
              {s.pending > 0 && <span style={{ color: 'var(--gold-deep)', fontWeight: 700 }}>{t('sched.overview.day_pending', { n: s.pending })}</span>}
            </span>
          </button>
        );
      })}
      {closedNames.length > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--line-soft)', color: 'var(--muted-2)', fontSize: 13 }}>
          {closedNames.join(' · ')} · {t('sched.overview.closed')}
        </div>
      )}
    </div>
  );
}

// --- month --------------------------------------------------------------------

export function MonthOverview({
  anchor,
  monthDays,
  horizonDays,
  today,
  slotMin,
  hasPrices,
  wide,
  onOpenDay,
  onMonth,
}: {
  anchor: string;
  monthDays: Map<string, CalendarDaySummary>;
  horizonDays: CalendarDaySummary[];
  today: string;
  slotMin: number;
  hasPrices: boolean;
  wide: boolean;
  onOpenDay: (date: string) => void;
  onMonth: (delta: 1 | -1) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const grid = monthGrid(anchor);
  const inMonth = grid.filter((c) => c.inMonth).map((c) => monthDays.get(c.date)).filter((s): s is CalendarDaySummary => !!s);
  const totals = sumDays(inMonth);
  const pickedSummary = picked ? monthDays.get(picked) : undefined;

  // Four weeks from this week, for "where is there room".
  const weeks: { label: string; pct: number }[] = [];
  const firstWeek = weekStart(today);
  for (let w = 0; w < 4; w++) {
    const start = addDays(firstWeek, w * 7);
    const days = horizonDays.filter((d) => d.date >= start && d.date <= addDays(start, 6));
    if (!days.length) continue;
    const open = days.filter((d) => d.available_min > 0);
    const label = open.length
      ? `${Number(open[0].date.slice(8))}–${Number(open[open.length - 1].date.slice(8))}/${Number(open[open.length - 1].date.slice(5, 7))}`
      : formatLocalDate(start, 'short');
    weeks.push({ label, pct: sumDays(days).utilisation });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <KpiTiles totals={totals} slotMin={slotMin} scope="month" hasPrices={hasPrices} />

      <section style={{ ...panelStyle, background: 'var(--white)', padding: '10px 10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 8px' }}>
          <button type="button" aria-label={t('sched.cal.month_prev')} onClick={() => onMonth(-1)} style={navBtn}>
            <Chevron dir="prev" />
          </button>
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--navy)' }}>{t('sched.overview.month_title')}</span>
          <button type="button" aria-label={t('sched.cal.month_next')} onClick={() => onMonth(1)} style={navBtn}>
            <Chevron dir="next" />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', textAlign: 'center', fontSize: 11.5, color: 'var(--nav-inactive-text)', paddingBottom: 6 }}>
          {[0, 1, 2, 3, 4, 5, 6].map((w) => (
            <span key={w}>{t(`sched.weekday_short.${w}` as I18nKey)}</span>
          ))}
        </div>
        <div role="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
          {grid.map((c) => {
            const s = monthDays.get(c.date);
            const open = !!s && (s.available_min > 0 || s.appointments > 0);
            const pct = s ? dayUtilisation(s) : 0;
            const heat = HEAT[utilisationLevel(pct)];
            const isToday = c.date === today;
            const isPicked = c.date === picked;
            return (
              <button
                key={c.date}
                type="button"
                disabled={!c.inMonth || !open}
                onClick={() => setPicked(c.date === picked ? null : c.date)}
                aria-pressed={isPicked}
                aria-label={`${formatLocalDate(c.date, 'long')}${open ? ` · ${pct}%` : ''}`}
                style={{
                  height: wide ? 64 : 48,
                  borderRadius: 9,
                  border: 'none',
                  padding: '3px 0',
                  cursor: c.inMonth && open ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1,
                  fontFamily: 'inherit',
                  ...(c.inMonth && open ? { background: heat.background, color: heat.color } : { background: 'transparent', color: 'var(--muted-2)', opacity: c.inMonth ? 0.75 : 0.4 }),
                  boxShadow: isToday ? 'inset 0 0 0 2.5px var(--danger)' : undefined,
                  outline: isPicked ? '2.5px solid var(--navy)' : undefined,
                  outlineOffset: 1,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700 }}>{Number(c.date.slice(8))}</span>
                {c.inMonth && open && <span style={{ fontSize: 9.5, fontWeight: 700 }}>{pct}%</span>}
                {wide && c.inMonth && open && s && <span style={{ fontSize: 9.5 }}>{t('sched.cal.day_load', { count: s.appointments })}</span>}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 10, fontSize: 11, color: 'var(--muted)' }}>
          <span>{t('sched.overview.heat_free')}</span>
          {[1, 2, 3, 4, 5].map((lv) => (
            <span key={lv} aria-hidden style={{ width: 18, height: 10, borderRadius: 3, background: HEAT[lv].background, border: lv === 1 ? '1px solid var(--shell-border-soft)' : undefined }} />
          ))}
          <span>{t('sched.overview.heat_full')}</span>
        </div>
      </section>

      {pickedSummary && picked && (
        <button
          type="button"
          onClick={() => onOpenDay(picked)}
          style={{ width: '100%', textAlign: 'start', background: 'var(--navy)', color: 'var(--cream)', border: 'none', borderRadius: 14, padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit' }}
        >
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}>
              {formatLocalDate(picked, 'long')} · {dayUtilisation(pickedSummary)}%
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--line-input)' }}>
              {t('sched.overview.day_line', { count: pickedSummary.appointments, free: formatMinutes(pickedSummary.free_min) })}
              {pickedSummary.pending > 0 ? ` · ${t('sched.overview.day_pending', { n: pickedSummary.pending })}` : ''}
            </span>
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gold)' }}>{t('sched.overview.open_day')} ←</span>
        </button>
      )}

      {weeks.length > 0 && (
        <section style={{ ...tile, gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)' }}>{t('sched.overview.horizon')}</span>
          {weeks.map((w) => (
            <div key={w.label} style={{ display: 'grid', gridTemplateColumns: '78px 1fr 40px', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <span style={{ color: 'var(--ink-soft)' }}>{w.label}</span>
              <Bar pct={w.pct} height={8} />
              <span style={{ fontWeight: 800, color: 'var(--navy)', fontVariantNumeric: 'tabular-nums' }}>{w.pct}%</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--muted)' };
const valueStyle: CSSProperties = { fontSize: 22, fontWeight: 800, color: 'var(--navy)', fontVariantNumeric: 'tabular-nums' };
const subStyle: CSSProperties = { fontSize: 11.5, color: 'var(--muted)' };
const navBtn: CSSProperties = {
  width: 40,
  height: 40,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--navy)',
};
