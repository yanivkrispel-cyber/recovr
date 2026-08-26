import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'paper' | 'sand' | 'navy';
  padding?: number;
}

const variantStyles: Record<NonNullable<CardProps['variant']>, React.CSSProperties> = {
  default: { background: 'var(--white)', border: 'var(--border)' },
  paper: { background: 'var(--paper)', border: 'var(--border)' },
  sand: { background: 'var(--sand)', border: '1px solid var(--line)' },
  navy: { background: 'var(--navy)', color: 'var(--cream)' },
};

export function Card({
  children,
  variant = 'default',
  padding = 20,
  style,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      style={{
        borderRadius: 'var(--radius-card)',
        padding,
        ...variantStyles[variant],
        fontFamily: 'var(--font-ui)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
