import React from 'react';
import { LogoMark } from './Logo';

interface FullPageLoaderProps {
  tone?: 'dark' | 'light';
  background?: string;
  label?: string;
}

// Full-screen loading state (app boot / session check / route transitions) —
// a gently pulsing brand mark instead of a bare "loading..." string, so a
// slow network doesn't read as the app being stuck.
export function FullPageLoader({ tone = 'dark', background = 'var(--cream)', label }: FullPageLoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: '100dvh',
        background,
      }}
    >
      <LogoMark tone={tone} size={48} className="logo-pulse" />
      {label && (
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            color: tone === 'light' ? 'var(--patient-muted)' : 'var(--muted)',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
