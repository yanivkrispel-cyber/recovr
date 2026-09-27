import type { ReactNode } from 'react';
import { clickableDivProps } from 'ui';

interface PhoneRowProps {
  title: ReactNode;
  /** Right-aligned (inline-end) element on the title line — a badge, a count. */
  trailing?: ReactNode;
  /** Secondary facts, joined by " · " on one wrapping line. Empty items drop out. */
  meta?: ReactNode[];
  onClick?: () => void;
}

/** Phone stand-in for one row of a desktop grid table: title + trailing badge
 *  on the first line, the other columns as a compact meta line below. */
export default function PhoneRow({ title, trailing, meta = [], onClick }: PhoneRowProps) {
  const facts = meta.filter((m) => m !== null && m !== undefined && m !== '' && m !== false);
  return (
    <div
      {...(onClick ? clickableDivProps(onClick) : {})}
      style={{
        padding: '13px 16px',
        borderTop: '1px solid var(--shell-border-soft)',
        cursor: onClick ? 'pointer' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </div>
        {trailing && <div style={{ flex: 'none' }}>{trailing}</div>}
      </div>
      {facts.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
          {facts.map((f, i) => (
            <span key={i}>
              {i > 0 && <span style={{ color: 'var(--nav-inactive-text)', margin: '0 5px' }}>·</span>}
              {/* Isolate each fact so mixed Hebrew/English/numbers don't reorder across the separators. */}
              <bdi>{f}</bdi>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
