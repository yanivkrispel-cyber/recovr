import React from 'react';

interface TableColumn<T> {
  key: keyof T | string;
  header: string;
  render?: (row: T) => React.ReactNode;
  width?: string;
  align?: 'start' | 'center' | 'end';
  sortable?: boolean;
}

interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  emptyMessage?: string;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSort?: (key: string) => void;
}

export function Table<T>({
  columns,
  rows,
  emptyMessage = 'אין נתונים',
  rowKey,
  onRowClick,
  sortKey,
  sortDirection,
  onSort,
}: TableProps<T>) {
  return (
    <div
      style={{
        border: 'var(--border)',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        background: 'var(--white)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
          color: 'var(--ink)',
        }}
      >
        <thead>
          <tr style={{ background: 'var(--paper)' }}>
            {columns.map(col => {
              const isSorted = col.sortable && sortKey === col.key;
              return (
                <th
                  key={String(col.key)}
                  onClick={col.sortable ? () => onSort?.(String(col.key)) : undefined}
                  style={{
                    padding: '12px 16px',
                    textAlign: col.align ?? 'start',
                    fontWeight: 600,
                    fontSize: 12,
                    color: 'var(--muted)',
                    borderBottom: '1px solid var(--line-soft)',
                    width: col.width,
                    cursor: col.sortable ? 'pointer' : undefined,
                    userSelect: col.sortable ? 'none' : undefined,
                  }}
                >
                  {col.header}
                  {isSorted && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: 32,
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: 13,
                }}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, idx) => (
              <tr
                key={rowKey(row)}
                onClick={() => onRowClick?.(row)}
                style={{
                  borderBottom:
                    idx === rows.length - 1 ? 'none' : '1px solid var(--line-soft)',
                  cursor: onRowClick ? 'pointer' : 'default',
                  transition: 'var(--motion-hover)',
                }}
              >
                {columns.map(col => (
                  <td
                    key={String(col.key)}
                    style={{
                      padding: '12px 16px',
                      textAlign: col.align ?? 'start',
                    }}
                  >
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[col.key as string] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
