import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from 'ui';
import { addDays, clinicDate, daysBetween, formatTime, t, zonedParts, zonedTimeToUtc, type I18nKey } from 'shared';
import type { BookingTheme } from './theme';

const WINDOW_DAYS = 14;

interface Props {
  tz: string;
  horizonDays: number;
  /** free start times (ISO instants) for clinic-local dates [from, to] */
  load: (from: string, to: string) => Promise<string[]>;
  /** identifies the slot list (clinic / type) for caching */
  cacheKey: readonly unknown[];
  theme: BookingTheme;
  selected: string | null;
  onPick: (iso: string) => void;
}

/** Two weeks of days with free times; pick a day, then a time. */
export default function SlotPicker({ tz, horizonDays, load, cacheKey, theme, selected, onPick }: Props) {
  const today = clinicDate(new Date(), tz);
  const lastDay = addDays(today, horizonDays);
  const [windowStart, setWindowStart] = useState(today);
  const windowEnd = useMemo(() => {
    const end = addDays(windowStart, WINDOW_DAYS - 1);
    return end > lastDay ? lastDay : end;
  }, [windowStart, lastDay]);

  const { data: slots, isLoading, isError, refetch } = useQuery({
    queryKey: ['slots', ...cacheKey, windowStart, windowEnd],
    queryFn: () => load(windowStart, windowEnd),
    staleTime: 30_000,
  });

  const byDay = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of slots ?? []) {
      const d = clinicDate(s, tz);
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return m;
  }, [slots, tz]);

  const [day, setDay] = useState<string | null>(null);
  useEffect(() => {
    if (!slots) return;
    if (day && byDay.has(day)) return;
    setDay([...byDay.keys()][0] ?? null);
  }, [slots, byDay, day]);

  const days = Array.from({ length: daysBetween(windowStart, windowEnd) + 1 }, (_, i) => addDays(windowStart, i));
  const canEarlier = windowStart > today;
  const canLater = windowEnd < lastDay;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div role="group" aria-label={t('sched.book.choose_time')} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
        {days.map((d) => {
          const p = zonedParts(zonedTimeToUtc(d, '12:00', tz), tz);
          const count = byDay.get(d)?.length ?? 0;
          const active = d === day;
          const disabled = !isLoading && count === 0;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={active}
              disabled={disabled || isLoading}
              onClick={() => setDay(d)}
              aria-label={`${t(`sched.weekday.${p.weekday}` as I18nKey)} ${p.day}.${p.month}`}
              style={{
                minHeight: 56,
                borderRadius: 12,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 1,
                fontFamily: 'inherit',
                cursor: disabled ? 'default' : 'pointer',
                border: `1.5px solid ${active ? theme.accent : theme.border}`,
                background: active ? theme.accent : disabled ? 'transparent' : theme.card,
                color: active ? theme.accentInk : disabled ? theme.faint : theme.text,
                opacity: disabled ? 0.55 : 1,
              }}
            >
              <span style={{ fontSize: 11 }}>{t(`sched.weekday_short.${p.weekday}` as I18nKey)}</span>
              <span style={{ fontSize: 17, fontWeight: 700 }}>{p.day}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div aria-busy="true" aria-label={t('sched.book.loading_slots')}>
          <Skeleton count={2} height={46} radius={10} />
        </div>
      ) : isError ? (
        <button type="button" onClick={() => refetch()} style={{ ...linkButton(theme), alignSelf: 'flex-start' }}>
          {t('error.generic.action')}
        </button>
      ) : byDay.size === 0 ? (
        <p style={{ margin: 0, padding: 12, borderRadius: 12, background: theme.notice, color: theme.text, fontSize: 14 }}>{t('sched.book.no_slots_range')}</p>
      ) : day ? (
        <div role="group" aria-label={t('sched.appt.time')} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          {(byDay.get(day) ?? []).map((s) => {
            const active = s === selected;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => onPick(s)}
                style={{
                  minHeight: 48,
                  borderRadius: 10,
                  fontFamily: 'inherit',
                  fontSize: 16,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  cursor: 'pointer',
                  border: `1.5px solid ${active ? theme.accent : theme.border}`,
                  background: active ? theme.accent : theme.card,
                  color: active ? theme.accentInk : theme.text,
                }}
              >
                {formatTime(s, tz)}
              </button>
            );
          })}
        </div>
      ) : null}

      {(canEarlier || canLater) && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          {canEarlier ? (
            <button type="button" style={linkButton(theme)} onClick={() => setWindowStart((w) => { const p = addDays(w, -WINDOW_DAYS); return p < today ? today : p; })}>
              → {t('sched.book.earlier')}
            </button>
          ) : <span />}
          {canLater && (
            <button type="button" style={linkButton(theme)} onClick={() => setWindowStart(addDays(windowEnd, 1))}>
              {t('sched.book.later')} ←
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function linkButton(theme: BookingTheme) {
  return {
    background: 'none',
    border: 'none',
    padding: '8px 0',
    minHeight: 44,
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    color: theme.link,
    cursor: 'pointer',
  } as const;
}
