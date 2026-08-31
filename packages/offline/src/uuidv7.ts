// UUIDv7 — time-ordered UUID.
// Used for client-generated session_item.id so that the server can dedupe
// on the same id and the queue can be replayed safely (RULES §6).

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit timestamp (ms since epoch) into the first 6 bytes
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version 7 in the high nibble of byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant 10xx in the high bits of byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
