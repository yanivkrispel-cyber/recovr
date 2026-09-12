import React from 'react';

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

// forwardRef so libraries that need the underlying input (react-hook-form's
// `register`, focus management) actually reach it. Without it RHF silently
// drops the ref and mishandles the checkbox value.
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, id, style, checked, ...props }, ref) => {
    const cbId = id ?? `cb-${Math.random().toString(36).slice(2, 9)}`;
    // The <label> wraps the input, so the association is implicit — do NOT
    // also set htmlFor. A label that both wraps AND `for`-references its
    // control toggles twice per click (real + label-synthesised), so the box
    // never changes state.
    return (
      <label
        style={{
          position: 'relative',
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
        <input
          {...props}
          ref={ref}
          checked={checked}
          type="checkbox"
          id={cbId}
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            opacity: 0,
            margin: 0,
          }}
        />
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            borderRadius: 'var(--radius-checkbox)',
            border: 'var(--border-input)',
            background: checked ? 'var(--navy)' : 'var(--white)',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          {checked && (
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
  },
);
Checkbox.displayName = 'Checkbox';
