import { encoder } from "./crypto-utils";
import { MajikSignature } from "@majikah/majik-signature";
import type { MajikKey } from "@majikah/majik-key";
import type {
  VerificationResult,
  MajikSignatureJSON,
} from "@majikah/majik-signature";
import { sha3_512 } from "@noble/hashes/sha3.js";

const MAJIK_SEAL_DOMAIN = "majik-seal-v1:";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSignatureJSON(
  contentBytes: Uint8Array,
  key: MajikKey,
  options?: { timestamp?: string; allowlistHash?: string },
) {
  const sig = await MajikSignature.sign(contentBytes, key, {
    contentType: "majik-invoice",
    timestamp: options?.timestamp,
    allowlistHash: options?.allowlistHash,
  });
  return sig.toJSON();
}

export function verifySignatureJSON(
  sigJSON: MajikSignatureJSON,
  contentBytes: Uint8Array,
): VerificationResult {
  const sig = MajikSignature.fromJSON(sigJSON);
  const publicKeys = sig.extractPublicKeys();
  return MajikSignature.verify(contentBytes, sig, publicKeys);
}

export function computeSealHash(
  signatures: MajikSignatureJSON[],
  sealTimestamp: string,
): string {
  const signatories = [...signatures]
    .sort((a, b) => a.signerId.localeCompare(b.signerId))
    .map((s) => ({
      signerId: s.signerId,
      edPublicKey: s.signerEdPublicKey,
      mlDsaPublicKey: s.signerMlDsaPublicKey,
    }));

  const body = JSON.stringify({ ts: sealTimestamp, signatories });
  const domainBytes = encoder.encode(MAJIK_SEAL_DOMAIN);
  const bodyBytes = encoder.encode(body);

  const input = new Uint8Array(domainBytes.length + bodyBytes.length);
  input.set(domainBytes, 0);
  input.set(bodyBytes, domainBytes.length);

  const hashBytes = sha3_512(input);
  return bytesToHex(hashBytes);
}

export async function computeSealHashAsync(
  signatures: MajikSignatureJSON[],
  sealTimestamp: string,
): Promise<string> {
  // synchronous implementation is fine; keep async API for parity with prior code
  return computeSealHash(signatures, sealTimestamp);
}
