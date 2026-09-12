import React from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: 'var(--navy)', color: 'var(--cream)', border: '1px solid var(--navy)' },
  secondary: { background: 'var(--white)', color: 'var(--navy)', border: '1px solid var(--line)' },
  ghost: { background: 'transparent', color: 'var(--navy)', border: '1px solid transparent' },
  danger: { background: 'var(--danger)', color: 'var(--cream)', border: '1px solid var(--danger)' },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '6px 12px', fontSize: 13, minHeight: 32 },
  md: { padding: '10px 18px', fontSize: 14, minHeight: 44 },
  lg: { padding: '14px 24px', fontSize: 15, minHeight: 48 },
};

function Spinner() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" aria-hidden className="spin">
      <circle cx={12} cy={12} r={10} stroke="currentColor" strokeWidth={3} opacity={0.25} />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  iconLeft,
  iconRight,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      {...props}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={{
        ...variantStyles[variant],
        ...sizeStyles[size],
        borderRadius: 'var(--radius-button)',
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.45 : 1,
        pointerEvents: isDisabled ? 'none' : 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        transition: 'var(--motion-hover)',
        ...style,
      }}
    >
      {loading ? <Spinner /> : iconLeft}
      <span>{children}</span>
      {!loading && iconRight}
    </button>
  );
}
