export function bytesToBase64(bytes: Uint8Array): string {
  // Try browser btoa path
  try {
    if (typeof btoa === "function") {
      let binary = "";
      for (let i = 0; i < bytes.length; i++)
        binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
  } catch (e) {
    // fall through to Buffer
  }

  // Node fallback
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  // Last resort: manual base64 encoder (unlikely)
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === "function") return btoa(bin);
  throw new Error("No base64 encoder available in this environment.");
}

export function base64ToBytes(b64: string): Uint8Array {
  // Browser
  if (typeof atob === "function") {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Node
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  throw new Error("No base64 decoder available in this environment.");
}
