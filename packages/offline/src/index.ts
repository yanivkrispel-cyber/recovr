// Offline queue for the patient PWA.
// Session items are written to IndexedDB with a client-generated UUIDv7,
// then flushed on reconnect. Server is authoritative for plan content,
// client for logs. Server dedupes on session_item.id (RULES §6).

export { OfflineQueue, type QueueEntry } from './queue';
export { uuidv7 } from './uuidv7';
