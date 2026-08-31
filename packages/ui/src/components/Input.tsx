import React, { useState } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      {off && (
        <path
          d="M2 2l20 20"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, style, type, ...props }, ref) => {
    const inputId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`;
    const isPassword = type === 'password';
    const [visible, setVisible] = useState(false);

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
        <div style={{ position: 'relative' }}>
          <input
            {...props}
            type={isPassword && visible ? 'text' : type}
            ref={ref}
            id={inputId}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: isPassword ? '10px 40px 10px 12px' : '10px 12px',
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
          {isPassword && (
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'הסתר סיסמה' : 'הצג סיסמה'}
              title={visible ? 'הסתר סיסמה' : 'הצג סיסמה'}
              tabIndex={-1}
              style={{
                position: 'absolute',
                insetInlineEnd: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: 'none',
                padding: 4,
                cursor: 'pointer',
                color: 'var(--muted)',
              }}
            >
              <EyeIcon off={visible} />
            </button>
          )}
        </div>
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
Input.displayName = 'Input';
