import React from 'react';

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: React.ReactNode;
  illustration?: React.ReactNode;
}

export function EmptyState({ title, body, action, illustration }: EmptyStateProps) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 40,
        fontFamily: 'var(--font-ui)',
        color: 'var(--ink-soft)',
      }}
    >
      {illustration && (
        <div style={{ marginBottom: 20, color: 'var(--muted-2)' }}>{illustration}</div>
      )}
      <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 600, color: 'var(--ink)' }}>
        {title}
      </h3>
      {body && <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--muted)' }}>{body}</p>}
      {action}
    </div>
  );
}
