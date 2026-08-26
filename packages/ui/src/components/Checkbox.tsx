import React from 'react';

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export function Checkbox({ label, id, style, ...props }: CheckboxProps) {
  const cbId = id ?? `cb-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <label
      htmlFor={cbId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        color: 'var(--ink)',
        ...style,
      }}
    >
      <input {...props} type="checkbox" id={cbId} style={{ display: 'none' }} />
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: 'var(--radius-checkbox)',
          border: 'var(--border-input)',
          background: props.checked ? 'var(--navy)' : 'var(--white)',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        {props.checked && (
          <svg
            viewBox="0 0 16 16"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          >
            <path d="M3 8l3 3 7-7" stroke="var(--cream)" strokeWidth="1.6" fill="none" />
          </svg>
        )}
      </span>
      {label}
    </label>
  );
}
