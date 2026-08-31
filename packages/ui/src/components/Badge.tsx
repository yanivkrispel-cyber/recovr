import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  tone?: 'neutral' | 'gold' | 'danger' | 'navy' | 'success' | 'attention';
}

const toneStyles: Record<NonNullable<BadgeProps['tone']>, React.CSSProperties> = {
  neutral: { background: 'var(--cream)', color: 'var(--ink-soft)', border: '1px solid var(--line)' },
  gold: { background: 'var(--gold)', color: 'var(--navy)' },
  danger: { background: 'var(--warn-bg)', color: 'var(--danger)', border: '1px solid var(--warn-line)' },
  navy: { background: 'var(--navy)', color: 'var(--cream)' },
  // Patient-status pill pair (dashboard/patients rows) — distinct from the
  // general `danger` tone above (#B4562A, reserved for pain/critical alerts
  // per DESIGN_TOKENS.md); these reuse the ROM module's flag colors.
  success: { background: 'var(--pill-good-bg)', color: 'var(--flag-green)' },
  attention: { background: 'var(--pill-attention-bg)', color: 'var(--flag-red)' },
};

export function Badge({ children, tone = 'neutral' }: BadgeProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '4px 10px',
        borderRadius: 'var(--radius-pill)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.2,
        ...toneStyles[tone],
      }}
    >
      {children}
    </span>
  );
}

interface PillProps extends BadgeProps {
  // Same as Badge for now; semantically distinct when used in status chips.
}

export function Pill(props: PillProps) {
  return <Badge {...props} />;
}
