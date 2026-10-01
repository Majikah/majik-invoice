/**
 * @file crypto-utils.ts
 * @description Shared cryptographic and UTF-8 encoding utilities used by the
 * MajikInvoice signing and integrity layers.
 *
 * This module provides four small primitives:
 *
 * - `sha256Hex()` — hashes arbitrary bytes with SHA-256 and returns the
 *   digest as lowercase hexadecimal.
 * - `canonicalBytesForSigning()` — constructs the deterministic
 *   `majik-invoice-v1` signing preimage from an invoice content hash and ID.
 * - `toUtf8Bytes()` — encodes a string as UTF-8 bytes.
 * - `fromUtf8Bytes()` — decodes UTF-8 bytes back into a string.
 *
 * A shared `TextEncoder` and `TextDecoder` instance are exported so callers
 * can reuse the same encoding primitives throughout the package.
 */

import { hash } from "@stablelib/sha256";

/**
 * Shared UTF-8 text encoder.
 *
 * Used to convert JavaScript strings into `Uint8Array` byte sequences for
 * hashing, signing, serialization, and other binary operations.
 */
export const encoder = new TextEncoder();

/**
 * Shared UTF-8 text decoder.
 *
 * Used to reconstruct JavaScript strings from UTF-8 encoded byte sequences.
 */
export const decoder = new TextDecoder();

/**
 * Compute the SHA-256 digest of a byte sequence and return it as lowercase
 * hexadecimal.
 *
 * The function accepts raw bytes rather than strings so callers are
 * responsible for choosing the exact byte representation that should be
 * hashed. This makes the operation suitable for canonicalized content,
 * serialized payloads, and other binary data.
 *
 * @param bytes Input data to hash.
 * @returns A 64-character lowercase hexadecimal SHA-256 digest.
 *
 * @example
 * const digest = sha256Hex(encoder.encode("hello"));
 * // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 */
export function sha256Hex(bytes: Uint8Array): string {
  const hashed = hash(bytes);

  return Array.from(hashed)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Construct the canonical byte representation used for MajikInvoice signing.
 *
 * The signing preimage is defined by the `majik-invoice-v1` domain-separation
 * prefix followed by a JSON object containing exactly the invoice content hash
 * and invoice ID:
 *
 * `majik-invoice-v1:{"contentHash":"...","invoiceId":"..."}`
 *
 * The resulting canonical string is UTF-8 encoded and returned as raw bytes
 * so it can be passed directly to a signing primitive.
 *
 * Keeping this construction centralized ensures that signing and verification
 * can use the same deterministic byte representation.
 *
 * @param contentHash Canonical hash representing the invoice content being
 * signed.
 * @param invoiceId Stable MajikInvoice identifier bound to the signature.
 * @returns The UTF-8 encoded canonical signing preimage.
 *
 * @example
 * const bytes = await canonicalBytesForSigning(
 *   "aabbcc...",
 *   "invoice-123",
 * );
 */
export async function canonicalBytesForSigning(
  contentHash: string,
  invoiceId: string,
): Promise<Uint8Array> {
  const canonical = `majik-invoice-v1:${JSON.stringify({ contentHash, invoiceId })}`;

  return encoder.encode(canonical);
}

/**
 * Encode a string as UTF-8 bytes.
 *
 * This is a convenience wrapper around the shared `TextEncoder` and is useful
 * when cryptographic APIs or binary serialization require a `Uint8Array`
 * representation of textual data.
 *
 * @param s String to encode.
 * @returns UTF-8 encoded bytes representing the input string.
 */
export function toUtf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/**
 * Decode UTF-8 bytes into a JavaScript string.
 *
 * This is the inverse convenience operation of `toUtf8Bytes()` and uses the
 * shared `TextDecoder` instance.
 *
 * @param b UTF-8 encoded byte sequence.
 * @returns The decoded JavaScript string.
 */
export function fromUtf8Bytes(b: Uint8Array): string {
  return decoder.decode(b);
}
