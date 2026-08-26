import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  tone?: 'neutral' | 'gold' | 'danger' | 'navy';
}

const toneStyles: Record<NonNullable<BadgeProps['tone']>, React.CSSProperties> = {
  neutral: { background: 'var(--cream)', color: 'var(--ink-soft)', border: '1px solid var(--line)' },
  gold: { background: 'var(--gold)', color: 'var(--navy)' },
  danger: { background: 'var(--warn-bg)', color: 'var(--danger)', border: '1px solid var(--warn-line)' },
  navy: { background: 'var(--navy)', color: 'var(--cream)' },
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
