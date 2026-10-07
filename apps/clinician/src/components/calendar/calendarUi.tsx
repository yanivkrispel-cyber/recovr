import { useRef, type CSSProperties, type ReactNode, type TouchEvent } from 'react';
import { formatLocalDate, t, type AppointmentStatus, type CalendarAppointment, type TypeColor, type I18nKey } from 'shared';
import '../../calendar.css';

// Look of the calendar, from the token layer only (CLAUDE.md rule 11).

export const TYPE_STYLE: Record<TypeColor, { background: string; color: string; accent: string }> = {
  navy: { background: 'var(--navy)', color: 'var(--cream)', accent: 'var(--gold)' },
  gold: { background: 'var(--sand)', color: 'var(--ink)', accent: 'var(--gold)' },
  green: { background: 'var(--pill-good-bg)', color: 'var(--ink)', accent: 'var(--flag-green)' },
  clay: { background: 'var(--pill-attention-bg)', color: 'var(--ink)', accent: 'var(--danger)' },
  slate: { background: 'var(--line-soft)', color: 'var(--ink)', accent: 'var(--navy-muted)' },
};

/** Load bar colour for a utilisation percentage. */
export function loadColor(pct: number): string {
  if (pct >= 75) return 'var(--gold-deep)';
  if (pct >= 30) return 'var(--gold)';
  return 'var(--line-input)';
}

/** Heat-map cell colours by utilisation level (0 free … 5 full). */
export const HEAT: { background: string; color: string }[] = [
  { background: 'var(--cream)', color: 'var(--ink-soft)' },
  { background: 'var(--cream)', color: 'var(--ink-soft)' },
  { background: 'var(--sand)', color: 'var(--navy)' },
  { background: 'var(--gold)', color: 'var(--navy)' },
  { background: 'var(--gold-deep)', color: 'var(--white)' },
  { background: 'var(--navy)', color: 'var(--cream)' },
];

export const HATCH =
  'repeating-linear-gradient(135deg, var(--line-soft) 0, var(--line-soft) 6px, var(--shell-border-soft) 6px, var(--shell-border-soft) 12px)';

export function statusLabel(status: AppointmentStatus): string {
  return t(`sched.status.${status}` as I18nKey);
}

export function weekdayLabel(weekday: number): string {
  return t(`sched.weekday.${weekday}` as I18nKey);
}

/** The person an appointment is for: the patient card, or a website visitor. */
export function personName(a: CalendarAppointment): string {
  return a.patient?.name ?? a.lead?.name ?? '—';
}

export function isLead(a: CalendarAppointment): boolean {
  return !a.patient && !!a.lead;
}

const STATUS_TONE: Record<AppointmentStatus, CSSProperties> = {
  pending: { background: 'var(--warn-bg)', color: 'var(--gold-deep)', border: '1px solid var(--warn-line)' },
  confirmed: { background: 'var(--pill-good-bg)', color: 'var(--flag-green)' },
  attended: { background: 'var(--line-soft)', color: 'var(--ink-soft)' },
  no_show: { background: 'var(--pill-attention-bg)', color: 'var(--flag-red)' },
  cancelled: { background: 'var(--line-soft)', color: 'var(--muted)' },
  declined: { background: 'var(--line-soft)', color: 'var(--muted)' },
  expired: { background: 'var(--line-soft)', color: 'var(--muted)' },
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  return <Pill style={STATUS_TONE[status]}>{statusLabel(status)}</Pill>;
}

export function Pill({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 9px',
        borderRadius: 'var(--radius-pill)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function TypeSwatch({ color, size = 10 }: { color: TypeColor; size?: number }) {
  const s = TYPE_STYLE[color];
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 3,
        background: s.background,
        borderInlineStart: `3px solid ${s.accent}`,
        boxSizing: 'border-box',
        flex: 'none',
      }}
    />
  );
}

export const panelStyle: CSSProperties = {
  background: 'var(--shell-sidebar-bg)',
  border: '1px solid var(--shell-border)',
  borderRadius: 'var(--radius-panel)',
};

export const iconButton: CSSProperties = {
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--shell-border)',
  background: 'var(--shell-sidebar-bg)',
  borderRadius: 'var(--radius-button)',
  cursor: 'pointer',
  color: 'var(--ink)',
  fontFamily: 'inherit',
};

export const fieldStyle: CSSProperties = {
  padding: '9px 11px',
  border: 'var(--border-input)',
  borderRadius: 'var(--radius-button)',
  background: 'var(--white)',
  fontFamily: 'inherit',
  fontSize: 14,
  color: 'var(--ink)',
  boxSizing: 'border-box',
  width: '100%',
};

export const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink)',
};

export function Chevron({ dir }: { dir: 'prev' | 'next' }) {
  // RTL: "previous" points right.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d={dir === 'prev' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Pill-shaped segmented switch (view tabs, "appointment / block time"). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        background: 'var(--line-soft)',
        borderRadius: 10,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            style={{
              height: 34,
              border: 'none',
              borderRadius: 8,
              fontFamily: 'inherit',
              fontSize: 14,
              cursor: 'pointer',
              ...(on
                ? { background: 'var(--white)', color: 'var(--navy)', fontWeight: 800, boxShadow: 'var(--shadow-floating)' }
                : { background: 'transparent', color: 'var(--nav-inactive-text)', fontWeight: 600 }),
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Touch handlers that report a deliberate sideways swipe. RTL: a swipe to
 *  the right brings in what lies to the left — the next day/week — so it
 *  reports +1. */
export function useHorizontalSwipe(onSwipe: (delta: 1 | -1) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    onTouchEnd: (e: TouchEvent) => {
      const from = start.current;
      start.current = null;
      if (!from) return;
      const dx = e.changedTouches[0].clientX - from.x;
      const dy = e.changedTouches[0].clientY - from.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      onSwipe(dx > 0 ? 1 : -1);
    },
  };
}

export function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

/** A date shown as Hebrew text ("יום שני, 19 באוקטובר") over an invisible
 *  native date input: a tap still opens the phone's own calendar, but what's
 *  on screen never depends on the browser's locale (an English phone showed
 *  "10/19/2026", cut off). `icon`: just the calendar button. */
export function DateField({
  value,
  onChange,
  label,
  min,
  variant = 'field',
}: {
  value: string;
  onChange: (date: string) => void;
  label: string;
  min?: string;
  variant?: 'field' | 'icon';
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="cal-datefield" style={{ position: 'relative', display: 'flex', flex: variant === 'icon' ? 'none' : undefined, minWidth: 0 }}>
      {variant === 'icon' ? (
        <span aria-hidden style={{ ...iconButton, width: 40, height: 40, color: 'var(--navy)' }}>
          <CalendarIcon />
        </span>
      ) : (
        <span aria-hidden style={{ ...fieldStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value ? formatLocalDate(value, 'long') : '—'}</span>
          <span style={{ color: 'var(--navy)', display: 'flex', flex: 'none' }}>
            <CalendarIcon />
          </span>
        </span>
      )}
      <input
        ref={input}
        type="date"
        aria-label={label}
        value={value}
        min={min}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        onClick={() => {
          try {
            input.current?.showPicker();
          } catch {
            // no showPicker (older browsers): a tap on the input opens it anyway
          }
        }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 0, margin: 0, padding: 0, cursor: 'pointer' }}
      />
    </span>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/** 24-hour time as hour : minute selects (5-minute steps). A native time
 *  input follows the phone's locale — "06:00 PM" on an English phone. */
export function TimeField({ value, onChange, label, bare = false }: { value: string; onChange: (time: string) => void; label: string; bare?: boolean }) {
  const [h, m] = /^\d{2}:\d{2}/.test(value) ? [value.slice(0, 2), value.slice(3, 5)] : ['', ''];
  const minutes = m && !MINUTES.includes(m) ? [...MINUTES, m].sort() : MINUTES;
  const select: CSSProperties = bare
    ? { border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', padding: '2px 0', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }
    : { ...fieldStyle, width: 'auto', padding: '9px 6px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' };
  return (
    // Times read left to right in Hebrew too: 18:30.
    <span role="group" aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, direction: 'ltr' }}>
      <select aria-label={`${label} · ${t('sched.time.hour')}`} value={h} onChange={(e) => onChange(`${e.target.value}:${m || '00'}`)} style={select}>
        {!h && <option value="">--</option>}
        {HOURS.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      <span aria-hidden style={{ fontWeight: 700, color: 'var(--ink)' }}>
        :
      </span>
      <select aria-label={`${label} · ${t('sched.time.minute')}`} value={m} onChange={(e) => onChange(`${h || '09'}:${e.target.value}`)} style={select}>
        {!m && <option value="">--</option>}
        {minutes.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
    </span>
  );
}
