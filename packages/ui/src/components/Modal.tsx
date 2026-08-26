import React, { useEffect, useRef } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  footer?: React.ReactNode;
}

const sizeMap: Record<NonNullable<ModalProps['size']>, string> = {
  sm: '420px',
  md: '560px',
  lg: '760px',
};

export function Modal({ open, onClose, title, children, size = 'md', footer }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(27,33,64,.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 'var(--z-modal)',
      }}
      onClick={onClose}
    >
      <div
        ref={ref}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--white)',
          borderRadius: 'var(--radius-panel)',
          boxShadow: 'var(--shadow-modal)',
          width: '90vw',
          maxWidth: sizeMap[size],
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <header
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--line-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="סגירה"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 20,
              color: 'var(--muted)',
              padding: 4,
            }}
          >
            ×
          </button>
        </header>
        <div style={{ padding: 24, overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <footer
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--line-soft)',
              display: 'flex',
              gap: 12,
              justifyContent: 'flex-end',
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
