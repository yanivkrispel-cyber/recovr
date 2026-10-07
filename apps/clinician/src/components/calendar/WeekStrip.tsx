import { dayUtilisation, t, weekdayOf, type CalendarDaySummary, type I18nKey } from 'shared';
import { loadColor, useHorizontalSwipe } from './calendarUi';

// Seven days with a load bar under each — the phone's "where am I in the
// week" line. Swipe sideways for the neighbouring week (RTL: next is left).

interface Props {
  days: string[];
  selected: string;
  today: string;
  summary: Map<string, CalendarDaySummary>;
  onPick: (date: string) => void;
  onWeek: (delta: 1 | -1) => void;
}

export default function WeekStrip({ days, selected, today, summary, onPick, onWeek }: Props) {
  const swipe = useHorizontalSwipe(onWeek);

  return (
    <div
      role="group"
      aria-label={t('sched.mobile.swipe_hint')}
      {...swipe}
      style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', touchAction: 'pan-y' }}
    >
      {days.map((d) => {
        const s = summary.get(d);
        const open = !!s && s.available_min > 0;
        const pct = s ? dayUtilisation(s) : 0;
        const isSel = d === selected;
        const isToday = d === today;
        const weekday = weekdayOf(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={isSel}
            aria-label={`${t(`sched.weekday.${weekday}` as I18nKey)} ${Number(d.slice(8))}.${Number(d.slice(5, 7))}${open ? ` · ${pct}%` : ''}`}
            onClick={() => onPick(d)}
            style={{ height: 64, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontFamily: 'inherit' }}
          >
            <span style={{ fontSize: 11.5, color: 'var(--nav-inactive-text)' }}>{t(`sched.weekday_short.${weekday}` as I18nKey)}</span>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 15,
                fontWeight: 700,
                ...(isSel
                  ? { background: 'var(--navy)', color: 'var(--cream)' }
                  : isToday
                    ? { color: 'var(--danger)', boxShadow: 'inset 0 0 0 2px var(--danger)' }
                    : { color: open ? 'var(--ink)' : 'var(--muted-2)', opacity: open ? 1 : 0.6 }),
              }}
            >
              {Number(d.slice(8))}
            </span>
            <span style={{ width: 24, height: 5, borderRadius: 3, background: 'var(--shell-border-soft)', overflow: 'hidden', display: 'flex' }}>
              {open && <span style={{ height: '100%', width: `${pct}%`, background: loadColor(pct) }} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
