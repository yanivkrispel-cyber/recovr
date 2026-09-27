import type { QueryClient } from '@tanstack/react-query';
import { sessionQueue } from './sessionQueue';
import { supabase } from './supabase';

export const TODAY_KEY = ['today'] as const;

interface TodayShape {
  session_id: string;
  items: Array<{ id: string; done: boolean }>;
  progress: { done: number; total: number };
}

// The server's `done` flag only flips once a queued log has synced, and the
// service worker may answer from cache while offline. Anything still sitting
// in the local queue for this session has been done too — merge it in, so
// every read of ['today'] (Home, ExerciseFlow, an offline reload) agrees.
function withLocalDone<T extends TodayShape>(today: T, locallyDone: Set<string>): T {
  if (locallyDone.size === 0) return today;
  const items = today.items.map((i) => (i.done || !locallyDone.has(i.id) ? i : { ...i, done: true }));
  return { ...today, items, progress: { ...today.progress, done: items.filter((i) => i.done).length } };
}

export async function fetchToday<T extends TodayShape>(): Promise<T | null> {
  const { data, error } = await supabase.functions.invoke('me-today', { method: 'GET' });
  if (error) throw error;
  if (!data) return null;
  const today = data as T;
  return withLocalDone(today, await sessionQueue.getQueuedPlanExerciseIds(today.session_id));
}

/** Show an exercise as done the moment it's logged, before any sync. */
export function markDoneLocally(queryClient: QueryClient, planExerciseId: string): void {
  queryClient.setQueryData<TodayShape | null>(TODAY_KEY, (prev) =>
    prev ? withLocalDone(prev, new Set([planExerciseId])) : prev,
  );
}
