import { useSyncExternalStore } from 'react';

/** Phone layout applies below 768px. Must match the breakpoint in the
 *  clinician app's mobile.css — the two switch together. Desktop (≥1024) and
 *  the tablet band (768–1023, see useIsTablet) never see phone layout. */
export const PHONE_MAX_WIDTH = 767;

const QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

/** `true` on a phone-width viewport. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
