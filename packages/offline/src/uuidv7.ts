// UUIDv7 — time-ordered UUID.
// Used for client-generated session_item.id so that the server can dedupe
// on the same id and the queue can be replayed safely (RULES §6).

export function uuidv7(): string {
  // 48-bit timestamp in ms
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0'); // 12 hex chars

  // 80 random bits
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let randHex = '';
  for (const b of rand) randHex += b.toString(16).padStart(2, '0');

  // Build the UUID structure:
  //   time_hi(4) | time_mid(2) | time_low(2) |
  //   version(2) | rand_a(2) | variant(2) | rand_b(14)
  const tHi = tsHex.slice(0, 4);
  const tMid = tsHex.slice(4, 8);
  const tLow = tsHex.slice(8, 12);

  // Version 7 → set high nibble of next byte to 7
  const versionByte = `7${randHex.slice(0, 1)}`;
  // Variant → 10xx
  const variantByte = ((0b10 << 2) | (parseInt(randHex.slice(1, 2), 16) & 0b11))
    .toString(16)
    .padStart(2, '0');

  const rest = randHex.slice(2, 14);

  return [
    tHi, tMid, tLow,
    versionByte,
    variantByte + randHex.slice(0, 0) + randHex.slice(0, 0) + rest.slice(0, 0),
  ].join('-');
}
