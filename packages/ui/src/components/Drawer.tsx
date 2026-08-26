import React, { useEffect } from 'react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
  position?: 'start' | 'end';
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = '420px',
  position = 'end',
}: DrawerProps) {
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
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(27,33,64,.42)',
        zIndex: 'var(--z-modal)',
        display: 'flex',
      }}
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--white)',
          width,
          maxWidth: '95vw',
          height: '100%',
          marginInlineStart: position === 'end' ? 'auto' : 0,
          boxShadow: 'var(--shadow-modal)',
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
      </aside>
    </div>
  );
}
