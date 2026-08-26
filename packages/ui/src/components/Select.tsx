import React from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, error, options, id, style, ...props }: SelectProps) {
  const selectId = id ?? `select-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label
          htmlFor={selectId}
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
      <select
        {...props}
        id={selectId}
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
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}
