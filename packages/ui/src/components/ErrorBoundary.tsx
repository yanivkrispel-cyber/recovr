import React from 'react';

interface Props {
  children: React.ReactNode;
  /** app name, sent with the report so the sink can tell clinician vs patient apart */
  app: string;
  /** where to POST the report — omit to only log to the console */
  reportUrl?: string;
  /** short auth/anon key for the report endpoint, if it needs one */
  reportKey?: string;
  fallback?: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes so a single broken screen doesn't blank the whole
 * app (T-24 error tracking). Also installs window-level handlers for uncaught
 * errors and unhandled rejections. Reports are best-effort — a failed report
 * never throws.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidMount(): void {
    window.addEventListener('error', this.onWindowError);
    window.addEventListener('unhandledrejection', this.onRejection);
  }

  componentWillUnmount(): void {
    window.removeEventListener('error', this.onWindowError);
    window.removeEventListener('unhandledrejection', this.onRejection);
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.report('react', error.message, error.stack, info.componentStack ?? undefined);
  }

  private onWindowError = (e: ErrorEvent): void => {
    this.report('window', e.message, e.error?.stack, `${e.filename}:${e.lineno}:${e.colno}`);
  };

  private onRejection = (e: PromiseRejectionEvent): void => {
    const reason = e.reason;
    this.report('unhandledrejection', String(reason?.message ?? reason), reason?.stack);
  };

  private report(kind: string, message: string, stack?: string, context?: string): void {
    const payload = {
      app: this.props.app,
      kind,
      message: String(message).slice(0, 1000),
      stack: stack ? String(stack).slice(0, 4000) : undefined,
      context: context ? String(context).slice(0, 2000) : undefined,
      url: location.pathname + location.search,
      user_agent: navigator.userAgent,
      at: new Date().toISOString(),
    };
    // Always leave a trace locally.
    console.error('[error-report]', payload);
    if (!this.props.reportUrl) return;
    try {
      const body = JSON.stringify(payload);
      const blob = new Blob([body], { type: 'application/json' });
      // sendBeacon survives an unload; falls back to fetch when unavailable.
      if (!navigator.sendBeacon?.(this.props.reportUrl, blob)) {
        void fetch(this.props.reportUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.props.reportKey ? { apikey: this.props.reportKey, Authorization: `Bearer ${this.props.reportKey}` } : {}),
          },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      /* reporting must never make things worse */
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div
            dir="rtl"
            style={{
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: 24,
              fontFamily: 'var(--font-ui, system-ui)',
              color: 'var(--ink, #2A2A2A)',
              background: 'var(--cream, #F6EFE3)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700 }}>משהו השתבש</div>
            <div style={{ fontSize: 13, color: 'var(--muted, #6E6A5E)' }}>נסה לרענן את הדף.</div>
            <button
              onClick={() => location.reload()}
              style={{
                marginTop: 8,
                padding: '9px 18px',
                borderRadius: 999,
                border: 'none',
                background: 'var(--navy, #1B2140)',
                color: 'var(--cream, #F6EFE3)',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              רענון
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
