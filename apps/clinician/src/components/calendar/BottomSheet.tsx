import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from 'ui';
import { t } from 'shared';

// A sheet that rises from the bottom of a phone screen — the phone's answer
// to the desktop drawer/modal: thumb-reachable, keeps context visible above.

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** sticky actions under the scrolling content */
  footer?: ReactNode;
}

export default function BottomSheet({ open, onClose, title, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  // Parents pass a fresh onClose every render; reading it through a ref keeps
  // the effect below from re-running (and re-focusing the panel, which would
  // pull the cursor out of a field) on each background refresh.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <button
        type="button"
        aria-label={t('sched.book.back')}
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, border: 0, padding: 0, background: 'rgba(27,33,64,.45)', cursor: 'pointer' }}
      />
      <div
        ref={panel}
        className="cal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: 'relative',
          maxHeight: '88dvh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--paper)',
          borderRadius: '20px 20px 0 0',
          boxShadow: 'var(--shadow-modal)',
          fontFamily: 'var(--font-ui)',
          outline: 'none',
        }}
      >
        <div aria-hidden style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--shell-border)', margin: '10px auto 2px', flex: 'none' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px 4px', flex: 'none' }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 19, fontWeight: 800, color: 'var(--ink)' }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('sched.book.back')}
            style={{ width: 36, height: 36, border: 'none', borderRadius: '50%', background: 'var(--line-soft)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 16px 16px', flex: 1, minHeight: 0 }}>{children}</div>
        {footer && (
          <div style={{ flex: 'none', padding: '10px 16px calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--line-soft)', background: 'var(--paper)' }}>
            {footer}
          </div>
        )}
        {!footer && <div style={{ height: 'env(safe-area-inset-bottom)', flex: 'none' }} />}
      </div>
    </div>
  );
}

/** One form, two frames: a centred modal on desktop, a bottom sheet on a phone. */
export function DialogFrame({ sheet, ...props }: Props & { sheet: boolean }) {
  if (sheet) return <BottomSheet {...props} />;
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.title} size="sm" footer={props.footer}>
      {props.children}
    </Modal>
  );
}
