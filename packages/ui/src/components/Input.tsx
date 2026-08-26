import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, id, style, ...props }: InputProps) {
  const inputId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
          }}
        >
          {label}
        </label>
      )}
      <input
        {...props}
        id={inputId}
        style={{
          padding: '10px 12px',
          borderRadius: 'var(--radius-button)',
          border: error ? '1px solid var(--danger)' : 'var(--border-input)',
          background: 'var(--white)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          color: 'var(--ink)',
          outline: 'none',
          ...style,
        }}
      />
      {error && (
        <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
      )}
      {hint && !error && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>
      )}
    </div>
  );
}
