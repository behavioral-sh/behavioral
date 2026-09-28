/**
 * RFC 9562 UUIDv7 over `crypto.getRandomValues` (cryptographically secure).
 *
 * Layout: 48-bit big-endian millisecond timestamp, version nibble `7`, variant
 * bits `10x`, 36-char 8-4-4-4-12 lowercase hex encoding, with an optional
 * string prefix in front.
 *
 * The 12 `rand_a` bits (between version and variant) carry a same-millisecond
 * monotonic counter: ids minted within one millisecond never invert in
 * lexicographic order — trace joins rely on that ordering.
 *
 * Good for: protocol message ids, event correlation, trace lineage keys.
 *
 * @param prefix - Optional prefix prepended to the 36-char form
 * @returns 36-char UUIDv7 (+ prefix) with the mint time embedded
 * @public
 */

let lastMs = -1
let counter = 0

export const uuid = (prefix = '') => {
  const now = Date.now()
  // Across different milliseconds the timestamp itself orders the ids; the
  // counter only has to be monotonic within one ms.
  counter = now === lastMs ? (counter + 1) & 0xfff : 0
  lastMs = now

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // 48-bit big-endian ms timestamp over bytes 0-5.
  bytes[0] = (now / 2 ** 40) & 0xff
  bytes[1] = (now / 2 ** 32) & 0xff
  bytes[2] = (now / 2 ** 24) & 0xff
  bytes[3] = (now / 2 ** 16) & 0xff
  bytes[4] = (now / 2 ** 8) & 0xff
  bytes[5] = now & 0xff
  // Version 7 in the high nibble of byte 6; the low nibble + byte 7 are
  // `rand_a` — the same-ms monotonic counter.
  bytes[6] = 0x70 | (counter >> 8)
  bytes[7] = counter & 0xff
  // Variant `10x` in the top bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${prefix}${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
