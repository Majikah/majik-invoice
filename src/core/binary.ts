// ─── .mjki Format Constants ───────────────────────────────────────────────────

/** Current .mjki binary format version. */
export const MJKI_VERSION = 1 as const;

/**
 * .mjki magic bytes: ASCII "MJKI" (0x4D 0x4A 0x4B 0x49).
 * Present at the very start of every .mjki file for format identification.
 */
export const MJKI_MAGIC = new Uint8Array([0x4d, 0x4a, 0x4b, 0x49]);

/**
 * Fixed header size before the variable-length JSON payload:
 *
 *   4    magic "MJKI"
 *   1    version
 *   3    reserved (flags / future use)
 *   4    payload JSON length (uint32 big-endian)
 *
 * = 12 bytes total header
 */
export const MJKI_HEADER_SIZE = 4 + 1 + 3 + 4; // 12 bytes
