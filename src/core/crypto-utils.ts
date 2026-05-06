import { hash } from "@stablelib/sha256";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function sha256Hex(bytes: Uint8Array): string {
  const hashed = hash(bytes);
  return Array.from(hashed)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function canonicalBytesForSigning(
  contentHash: string,
  invoiceId: string,
): Promise<Uint8Array> {
  const canonical = `majik-invoice-v1:${JSON.stringify({ contentHash, invoiceId })}`;
  return encoder.encode(canonical);
}

export function toUtf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8Bytes(b: Uint8Array): string {
  return decoder.decode(b);
}
