// Q-01 (QA_PLAN.md) [auto]: replaying the same offline queue twice must not
// create duplicate session_item rows. The server enforces this via
// `ON CONFLICT (session_id, id) DO NOTHING` (see write_session_items in
// 0001_initial_schema.sql); this test simulates that same dedupe contract
// against a fake server so a regression in the queue's replay/id handling
// is caught without spinning up Postgres.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineQueue, type QueueEntry } from './queue';
import { uuidv7 } from './uuidv7';

function makeItem(id: string) {
  return {
    id,
    plan_exercise_id: uuidv7(),
    sets_done: 3,
    reps_done: 10,
    pain_score: 2,
    difficulty: 'easy' as const,
    skipped: false,
    logged_at: new Date().toISOString(),
  };
}

// A fake server enforcing the same dedupe-by-id contract as
// app.write_session_items' ON CONFLICT (session_id, id) DO NOTHING.
function makeFakeServer() {
  const stored = new Map<string, unknown>();
  return {
    stored,
    handleFlush: async (entries: QueueEntry[]) => {
      for (const e of entries) {
        if (!stored.has(e.id)) stored.set(e.id, e.item);
      }
    },
  };
}

describe('OfflineQueue', () => {
  beforeEach(async () => {
    // Each test gets a clean slate — drop any IndexedDB state from a prior test.
    indexedDB.deleteDatabase('recoveryos-offline');
    await new Promise((r) => setTimeout(r, 0));
  });

  it('flushes enqueued items to the server and clears the local queue', async () => {
    const server = makeFakeServer();
    const queue = new OfflineQueue(server.handleFlush, { retryDelayMs: 30_000 });

    const item = makeItem(uuidv7());
    await queue.enqueue('session-1', item);

    await vi.waitFor(
      async () => {
        expect(await queue.size()).toBe(0);
      },
      { timeout: 3000 },
    );

    expect(server.stored.size).toBe(1);
    expect(server.stored.get(item.id)).toEqual(item);
  });

  it('replaying the same queue twice creates no duplicate session_item', async () => {
    const server = makeFakeServer();
    const items = [makeItem(uuidv7()), makeItem(uuidv7()), makeItem(uuidv7())];

    // First pass: a full offline session queues 3 items, then syncs.
    const queue = new OfflineQueue(server.handleFlush, { retryDelayMs: 30_000 });
    for (const item of items) {
      await queue.enqueue('session-1', item);
    }
    await vi.waitFor(
      async () => {
        expect(await queue.size()).toBe(0);
      },
      { timeout: 3000 },
    );
    expect(server.stored.size).toBe(3);

    // Replay: the same client-generated ids are flushed again (e.g. a retry
    // after a crash before the local queue was cleared, or the queue was
    // never cleared server-side). The server must dedupe by id.
    const entries: QueueEntry[] = items.map((item) => ({
      id: item.id,
      session_id: 'session-1',
      item,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    }));
    await server.handleFlush(entries);
    await server.handleFlush(entries); // twice, per the QA scenario

    expect(server.stored.size).toBe(3);
    for (const item of items) {
      expect(server.stored.get(item.id)).toEqual(item);
    }
  });

  it('retries on the next online event after a failed flush', async () => {
    let shouldFail = true;
    const delivered: QueueEntry[] = [];
    const flush = vi.fn(async (entries: QueueEntry[]) => {
      if (shouldFail) throw new Error('offline');
      delivered.push(...entries);
    });
    const queue = new OfflineQueue(flush, { retryDelayMs: 30_000, maxAttempts: 5 });

    const item = makeItem(uuidv7());
    await queue.enqueue('session-1', item);

    await vi.waitFor(
      () => {
        expect(flush).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );
    expect(await queue.size()).toBe(1); // still queued — flush failed

    shouldFail = false;
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(
      async () => {
        expect(await queue.size()).toBe(0);
      },
      { timeout: 3000 },
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].id).toBe(item.id);
  });
});
