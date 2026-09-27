import { OfflineQueue, type QueueEntry } from 'offline';
import { supabase } from './supabase';

type Listener = () => void;
const flushedListeners = new Set<Listener>();

/** Called after queued session items have reached the server. */
export function onQueueFlushed(fn: Listener): () => void {
  flushedListeners.add(fn);
  return () => {
    flushedListeners.delete(fn);
  };
}

// supabase.functions.invoke resolves with { error } rather than throwing, so
// the error has to be rethrown here — otherwise a 4xx/5xx counts as a
// successful flush and the queue deletes items the server never stored.
// Entries are posted per session: a queue holding yesterday's offline logs
// plus today's must not file them all under one session.
async function flushEntries(entries: QueueEntry[]): Promise<void> {
  const bySession = new Map<string, QueueEntry[]>();
  for (const e of entries) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }
  let firstError: unknown = null;
  for (const [sessionId, list] of bySession) {
    const { error } = await supabase.functions.invoke(`me-sessions-items/${sessionId}/items`, {
      method: 'POST',
      body: { items: list.map((e) => e.item) },
    });
    // Keep going so other sessions still land; the server dedupes by item id,
    // so re-sending the ones that succeeded on the retry is harmless.
    if (error && !firstError) firstError = error;
  }
  if (firstError) throw firstError;
  for (const fn of flushedListeners) fn();
}

// One queue for the whole app (not per ExerciseFlow mount), so items left
// over from a previous run flush on startup, not only once an exercise is
// opened again.
export const sessionQueue = new OfflineQueue(flushEntries, { retryDelayMs: 30_000, maxAttempts: 5 });
