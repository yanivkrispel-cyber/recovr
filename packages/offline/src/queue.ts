// IndexedDB-backed offline queue for session_item writes.
// Spec per RULES §6:
//  - Client-generated id (UUIDv7) and logged_at
//  - Queue flushes on reconnect within 30s
//  - Replay the same queue twice → server dedupes by id → no duplicate rows

import { openDB, type IDBPDatabase } from 'idb';
import type { SessionItemInput } from 'shared';

const DB_NAME = 'recoveryos-offline';
const DB_VERSION = 1;
const STORE = 'session_item_queue';

export interface QueueEntry {
  id: string; // UUIDv7, server dedupe key
  session_id: string;
  item: SessionItemInput;
  enqueued_at: string;
  attempts: number;
  last_error?: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export class OfflineQueue {
  private flushInFlight = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (entries: QueueEntry[]) => Promise<void>,
    private readonly options: { retryDelayMs?: number; maxAttempts?: number } = {},
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.scheduleFlush(0));
    }
  }

  async enqueue(session_id: string, item: SessionItemInput): Promise<void> {
    const db = await getDb();
    const entry: QueueEntry = {
      id: item.id,
      session_id,
      item,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    };
    await db.put(STORE, entry);
    this.scheduleFlush();
  }

  async size(): Promise<number> {
    const db = await getDb();
    return db.count(STORE);
  }

  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear(STORE);
  }

  scheduleFlush(delayMs = 1000) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.runFlush();
    }, delayMs);
  }

  private async runFlush(): Promise<void> {
    if (this.flushInFlight) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    this.flushInFlight = true;
    try {
      const db = await getDb();
      const all = (await db.getAll(STORE)) as QueueEntry[];
      if (all.length === 0) return;
      try {
        await this.flush(all);
        // All succeeded — clear the queue
        const tx = db.transaction(STORE, 'readwrite');
        for (const e of all) await tx.store.delete(e.id);
        await tx.done;
      } catch (err) {
        const max = this.options.maxAttempts ?? 5;
        const tx = db.transaction(STORE, 'readwrite');
        for (const e of all) {
          if (e.attempts < max) {
            e.attempts += 1;
            e.last_error = String(err);
            await tx.store.put(e);
          }
        }
        await tx.done;
        this.scheduleFlush(this.options.retryDelayMs ?? 30_000);
      }
    } finally {
      this.flushInFlight = false;
    }
  }
}
