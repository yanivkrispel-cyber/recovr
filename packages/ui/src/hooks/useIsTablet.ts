import { useSyncExternalStore } from 'react';

/** Clinician is desktop-first at a 1440px design width and must fully work,
 *  editing included, down to 1024px (SCREENS.md: "must work at 1024").
 *  Below that — an actual tablet viewport — is view-only for v1: the
 *  editing surfaces (plan editor, exercise library management, recording a
 *  measurement) hide rather than render broken. */
export const TABLET_MAX_WIDTH = 1023;

function subscribe(callback: () => void): () => void {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

/** `true` when the viewport is narrower than the 1024px desktop minimum. */
export function useIsTablet(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth <= TABLET_MAX_WIDTH,
    () => false,
  );
}
