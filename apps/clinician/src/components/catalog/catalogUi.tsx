// T-30 small building blocks shared by the catalog workspace and bulk grid.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { completenessKeyLabel, completenessTone, exerciseStatusLabel, t, type ExerciseStatus } from 'shared';

export const fieldLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--ink-soft)', letterSpacing: '0.02em',
};

export const textInputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 'var(--radius-button)',
  border: 'var(--border-input)', background: 'var(--white)', fontFamily: 'var(--font-ui)', fontSize: 14,
  color: 'var(--ink)', outline: 'none',
};

export const textareaStyle: CSSProperties = { ...textInputStyle, resize: 'vertical', minHeight: 72, lineHeight: 1.55 };

export const smallButtonStyle: CSSProperties = {
  background: 'transparent', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)',
  padding: '5px 11px', fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', cursor: 'pointer',
  fontFamily: 'inherit', whiteSpace: 'nowrap',
};

export const linkButtonStyle: CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--gold-deep)',
  cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
};

const STATUS_STYLE: Record<ExerciseStatus, CSSProperties> = {
  draft: { background: 'var(--cream)', color: 'var(--ink-soft)', border: '1px solid var(--line)' },
  in_review: { background: 'var(--pill-attention-bg)', color: 'var(--flag-red)', border: '1px solid transparent' },
  approved: { background: 'var(--pill-good-bg)', color: 'var(--flag-green)', border: '1px solid transparent' },
  archived: { background: 'transparent', color: 'var(--muted)', border: '1px dashed var(--line)' },
};

export function StatusBadge({ status, compact }: { status: ExerciseStatus; compact?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 'var(--radius-pill)',
        padding: compact ? '1px 7px' : '3px 10px', fontSize: compact ? 10.5 : 12, fontWeight: 700, whiteSpace: 'nowrap',
        ...STATUS_STYLE[status],
      }}
    >
      {exerciseStatusLabel(status)}
    </span>
  );
}

const TONE_COLOR = { low: 'var(--danger)', mid: 'var(--gold-deep)', high: 'var(--flag-green)' } as const;

/** Small ring for list rows. */
export function CompletenessRing({ score, size = 30 }: { score: number; size?: number }) {
  const r = (size - 5) / 2;
  const c = 2 * Math.PI * r;
  const color = TONE_COLOR[completenessTone(score)];
  return (
    <span title={`${t('catalog.completeness')} ${score}%`} style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-soft)" strokeWidth={3} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3} strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size < 32 ? 9 : 11, fontWeight: 700, color: 'var(--ink-soft)' }}>
        {score}
      </span>
    </span>
  );
}

/** Bar + clickable "missing" chips for the editor header. */
export function CompletenessMeter({ score, missing, onJump }: { score: number; missing: string[]; onJump: (key: string) => void }) {
  const color = TONE_COLOR[completenessTone(score)];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ ...fieldLabelStyle, minWidth: 44 }}>{t('catalog.completeness')}</span>
        <div style={{ flex: 1, height: 7, borderRadius: 'var(--radius-pill)', background: 'var(--line-soft)', overflow: 'hidden' }}>
          <div style={{ width: `${score}%`, height: '100%', background: color, transition: 'width var(--motion-panel)' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color, minWidth: 38, textAlign: 'end' }}>{score}%</span>
      </div>
      {missing.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--flag-green)', fontWeight: 600 }}>✓ {t('catalog.completeness.done')}</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('catalog.completeness.missing')}</span>
          {missing.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onJump(k)}
              style={{ ...smallButtonStyle, padding: '2px 9px', fontSize: 11.5, borderStyle: 'dashed', color: 'var(--ink-soft)' }}
            >
              {completenessKeyLabel(k)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chips + free-text entry. Enter or comma adds; Backspace on empty removes the last. */
export function TagInput({
  id, value, onChange, disabled, placeholder, suggestions, dir,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  suggestions?: string[];
  dir?: 'ltr' | 'rtl';
}) {
  const [text, setText] = useState('');
  const listId = id ? `${id}-suggestions` : undefined;

  function add(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (!value.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...value, v]);
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      style={{
        ...textInputStyle, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px',
        opacity: disabled ? 0.75 : 1, background: disabled ? 'var(--paper)' : 'var(--white)',
      }}
    >
      {value.map((v) => (
        <span
          key={v}
          dir={dir}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--nav-active-bg)', color: 'var(--gold-deep)', borderRadius: 'var(--radius-pill)', padding: '2px 4px 2px 9px', fontSize: 12, fontWeight: 600 }}
        >
          {v}
          {!disabled && (
            <button
              type="button"
              aria-label={`${t('catalog.field.remove')} ${v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold-deep)', fontSize: 14, lineHeight: 1, padding: '0 3px' }}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          id={id}
          value={text}
          dir={dir}
          list={listId}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
          placeholder={value.length === 0 ? placeholder : undefined}
          style={{ flex: 1, minWidth: 90, border: 'none', outline: 'none', fontFamily: 'inherit', fontSize: 13, background: 'transparent', padding: '3px 2px' }}
        />
      )}
      {listId && suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}

/** Ordered list of short texts (key cues). */
export function CueListEditor({
  id, value, onChange, onCommit, disabled,
}: {
  id?: string;
  value: string[];
  /** every keystroke (local state) */
  onChange: (next: string[]) => void;
  /** structural changes and blur — save now */
  onCommit: (next: string[]) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    if (focusIndex != null) {
      refs.current[focusIndex]?.focus();
      setFocusIndex(null);
    }
  }, [focusIndex, value.length]);

  const clean = (list: string[]) => list.map((s) => s.trim()).filter(Boolean);

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    onCommit(clean(next));
  }

  return (
    <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.map((cue, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--gold-deep)' }}>{i + 1}</span>
          <input
            ref={(el) => { refs.current[i] = el; }}
            value={cue}
            disabled={disabled}
            placeholder={t('catalog.field.key_cues.placeholder')}
            onChange={(e) => onChange(value.map((c, k) => (k === i ? e.target.value : c)))}
            onBlur={() => onCommit(clean(value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const next = [...value.slice(0, i + 1), '', ...value.slice(i + 1)];
                onChange(next);
                setFocusIndex(i + 1);
              }
            }}
            style={{ ...textInputStyle, padding: '7px 10px' }}
          />
          {!disabled && (
            <>
              <button type="button" aria-label={t('catalog.field.move_up')} disabled={i === 0} onClick={() => move(i, -1)} style={{ ...smallButtonStyle, padding: '4px 8px', opacity: i === 0 ? 0.35 : 1 }}>↑</button>
              <button type="button" aria-label={t('catalog.field.move_down')} disabled={i === value.length - 1} onClick={() => move(i, 1)} style={{ ...smallButtonStyle, padding: '4px 8px', opacity: i === value.length - 1 ? 0.35 : 1 }}>↓</button>
              <button
                type="button"
                aria-label={t('catalog.field.remove')}
                onClick={() => {
                  const next = value.filter((_, k) => k !== i);
                  onChange(next);
                  onCommit(clean(next));
                }}
                style={{ ...smallButtonStyle, padding: '4px 9px', color: 'var(--danger)' }}
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={() => {
            onChange([...value, '']);
            setFocusIndex(value.length);
          }}
          style={{ ...linkButtonStyle, alignSelf: 'flex-start', textDecoration: 'none' }}
        >
          {t('catalog.field.key_cues.add')}
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string | number>({
  options, value, onChange, disabled, allowClear,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (next: T | null) => void;
  disabled?: boolean;
  allowClear?: boolean;
}) {
  return (
    <div role="radiogroup" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 5 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(active && allowClear ? null : o.value)}
            style={{
              padding: '6px 13px', borderRadius: 'var(--radius-pill)', fontSize: 12.5, fontWeight: active ? 700 : 500,
              fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
              background: active ? 'var(--gold-deep)' : 'var(--white)', color: active ? 'var(--cream)' : 'var(--ink-soft)',
              border: active ? '1px solid var(--gold-deep)' : '1px solid var(--shell-border)', opacity: disabled && !active ? 0.6 : 1,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Filter chip that opens a list of values with counts. */
export function FacetDropdown({
  label, valueLabel, options, onSelect, active,
}: {
  label: string;
  valueLabel: string | null;
  options: { value: string; label: string; count?: number }[];
  onSelect: (value: string | null) => void;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 'var(--radius-pill)',
          fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
          background: active ? 'var(--nav-active-bg)' : 'var(--white)',
          border: active ? '1px solid var(--gold-deep)' : '1px solid var(--shell-border)',
          color: active ? 'var(--gold-deep)' : 'var(--ink-soft)', fontWeight: active ? 700 : 500,
        }}
      >
        {label}{valueLabel ? `: ${valueLabel}` : ''}
        <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', insetBlockStart: 'calc(100% + 6px)', insetInlineStart: 0, zIndex: 'var(--z-dropdown)',
            background: 'var(--white)', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-floating)', minWidth: 210, maxHeight: 340, overflowY: 'auto', padding: 5,
          }}
        >
          <FacetOption label={t('catalog.filter.any')} selected={!active} onClick={() => { onSelect(null); setOpen(false); }} />
          {options.map((o) => (
            <FacetOption
              key={o.value}
              label={o.label}
              count={o.count}
              selected={active && valueLabel === o.label}
              onClick={() => { onSelect(o.value); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FacetOption({ label, count, selected, onClick }: { label: string; count?: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      disabled={count === 0 && !selected}
      style={{
        display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 14,
        padding: '7px 10px', border: 'none', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, textAlign: 'start',
        background: selected ? 'var(--nav-active-bg)' : 'transparent', color: count === 0 && !selected ? 'var(--muted-2)' : 'var(--ink)',
        fontWeight: selected ? 700 : 400, cursor: count === 0 && !selected ? 'default' : 'pointer',
      }}
    >
      <span>{label}</span>
      {count != null && <span style={{ fontSize: 11.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </button>
  );
}

export function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginBlockStart: 64, paddingBlock: 18, borderBlockStart: '1px solid var(--shell-border-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: 12 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>{title}</h3>
        {aside}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </section>
  );
}
