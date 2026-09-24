import React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, id, style, rows = 3, ...props }, ref) => {
    const textareaId = id ?? `textarea-${Math.random().toString(36).slice(2, 9)}`;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {label && (
          <label
            htmlFor={textareaId}
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
        <textarea
          {...props}
          ref={ref}
          id={textareaId}
          rows={rows}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 12px',
            borderRadius: 'var(--radius-button)',
            border: error ? '1px solid var(--danger)' : 'var(--border-input)',
            background: 'var(--white)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            color: 'var(--ink)',
            outline: 'none',
            resize: 'vertical',
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
  },
);
Textarea.displayName = 'Textarea';
