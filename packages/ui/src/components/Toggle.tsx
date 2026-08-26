import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        color: 'var(--ink)',
      }}
    >
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && onChange(!checked)}
        onKeyDown={e => {
          if (disabled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        style={{
          width: 36,
          height: 20,
          borderRadius: 'var(--radius-pill)',
          background: checked ? 'var(--navy)' : 'var(--line-input)',
          position: 'relative',
          transition: 'var(--motion-hover)',
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            insetInlineStart: checked ? 18 : 2,
            top: 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--cream)',
            transition: 'var(--motion-hover)',
          }}
        />
      </span>
      {label}
    </label>
  );
}
