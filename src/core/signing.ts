import { encoder } from "./crypto-utils";
import type { ExpectedSigner } from "@majikah/majik-signature";
import { hash } from "@stablelib/sha256";
import { bytesToBase64 } from "./encoding-utils";

/**
 * Compute allowlistHash: base64(SHA-256(canonicalAllowlistJSON))
 */
export function computeAllowlistHash(signers: ExpectedSigner[]): string {
  const canonicalAllowlist = JSON.stringify(
    [...signers].sort((a, b) => a.signerId.localeCompare(b.signerId)),
  );
  const allowlistBytes = encoder.encode(canonicalAllowlist);
  const hashed = hash(allowlistBytes);
  return bytesToBase64(hashed);
}
