import type { KeyboardEvent } from 'react';

/**
 * Spread onto a `<div>` (or any non-native-interactive element) that has an
 * `onClick` acting as a button/link, to make it keyboard-reachable (T-22):
 * focusable via Tab, and activatable with Enter or Space. Prefer a real
 * `<button>`/`<a>` when the markup allows it — this is for cases (a table
 * row, a card with a complex grid layout) where swapping the element would
 * mean re-fighting its layout.
 */
export function clickableDivProps(onClick: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
  };
}
