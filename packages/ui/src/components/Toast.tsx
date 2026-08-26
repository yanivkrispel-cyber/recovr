import React, { createContext, useCallback, useContext, useState } from 'react';

interface ToastItem {
  id: string;
  message: string;
  tone?: 'info' | 'success' | 'error';
  duration?: number;
}

interface ToastContextValue {
  show: (message: string, opts?: { tone?: ToastItem['tone']; duration?: number }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback<ToastContextValue['show']>((message, opts) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const duration = opts?.duration ?? 2600;
    setItems(prev => [...prev, { id, message, tone: opts?.tone, duration }]);
    setTimeout(() => {
      setItems(prev => prev.filter(i => i.id !== id));
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          insetInlineStart: '50%',
          bottom: 24,
          transform: 'translateX(-50%)',
          zIndex: 'var(--z-toast)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {items.map(item => (
          <div
            key={item.id}
            style={{
              background: 'var(--navy)',
              color: 'var(--cream)',
              padding: '12px 20px',
              borderRadius: 'var(--radius-panel)',
              boxShadow: 'var(--shadow-floating)',
              fontSize: 14,
              fontFamily: 'var(--font-ui)',
              fontWeight: 500,
              minWidth: 220,
              textAlign: 'center',
            }}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export { ToastContext as _ToastContext };
export type { ToastItem };
