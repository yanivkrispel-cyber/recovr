import { formatDayShort, formatTime, t, type CalendarConflicts } from 'shared';
import { statusLabel } from './calendarUi';

/** What a booking or blocked time collided with — from a `conflict` error. */
export function ConflictList({ conflicts, tz, intro }: { conflicts: CalendarConflicts; tz: string; intro?: string }) {
  return (
    <div role="alert" style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-line)', borderRadius: 'var(--radius-card)', padding: '10px 12px', fontSize: 13, color: 'var(--ink)' }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('sched.appt.conflict.title')}</div>
      <div style={{ color: 'var(--ink-soft)', marginBottom: 6 }}>{intro ?? t('sched.appt.conflict.body')}</div>
      <ul style={{ margin: 0, paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {conflicts.appointments.map((c) => (
          <li key={c.id}>
            {formatDayShort(c.starts_at, tz)} {formatTime(c.starts_at, tz)}–{formatTime(c.ends_at, tz)} · {c.name ?? '—'} ({statusLabel(c.status)})
          </li>
        ))}
        {conflicts.time_off.map((o) => (
          <li key={o.id}>
            {formatDayShort(o.starts_at, tz)} {formatTime(o.starts_at, tz)}–{formatTime(o.ends_at, tz)} · {t('sched.cal.blocked')}
            {o.reason ? ` (${o.reason})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
