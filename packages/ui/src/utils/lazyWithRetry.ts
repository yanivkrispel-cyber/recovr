import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_FLAG = 'recovr:chunk-reload-attempted';

/**
 * Wraps `React.lazy(factory)` with one retry and, failing that, a one-time
 * hard reload. A lazy chunk fetch can fail on nothing more than a transient
 * network blip (a reset connection, a dropped packet) as easily as on a
 * stale build after a deploy — in production this surfaced as
 * "Failed to fetch dynamically imported module" with no way for the user to
 * recover short of manually refreshing. sessionStorage guards against a
 * reload loop if the chunk is genuinely gone.
 *
 * Typed to mirror `React.lazy` itself (factory returns `{ default: T }`,
 * `T` used directly rather than folded into a constraint) so the wrapped
 * component keeps its real prop types instead of widening to `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy's own signature
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await factory();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        return await factory();
      } catch (secondError) {
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, '1');
          location.reload();
          // Reload is in flight; never resolve so this render just waits for it.
          return new Promise<{ default: T }>(() => {});
        }
        throw secondError;
      }
    }
  });
}
