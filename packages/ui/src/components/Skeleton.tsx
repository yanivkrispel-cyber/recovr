import React from 'react';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  count?: number;
}

export function Skeleton({ width = '100%', height = 16, radius = 'var(--radius-button)', count = 1 }: SkeletonProps) {
  if (count === 1) {
    return (
      <span
        aria-hidden
        className="shimmer"
        style={{
          display: 'inline-block',
          width,
          height,
          borderRadius: radius,
          background: 'var(--line-soft)',
        }}
      />
    );
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          className="shimmer"
          style={{
            display: 'inline-block',
            width,
            height,
            borderRadius: radius,
            background: 'var(--line-soft)',
          }}
        />
      ))}
    </span>
  );
}
