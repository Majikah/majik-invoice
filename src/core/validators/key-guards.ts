import type { MajikKey } from "@majikah/majik-key";
import { MajikInvoiceKeyError } from "../errors";

export function assertKeyUnlocked(key: MajikKey, operation: string): void {
  if (key.isLocked) {
    throw new MajikInvoiceKeyError(
      `Cannot ${operation}: MajikKey is locked. Call key.unlock(passphrase) first.`,
    );
  }
}

export function assertKeyHasSigningKeys(
  key: MajikKey,
  operation: string,
): void {
  if (!key.hasSigningKeys) {
    throw new MajikInvoiceKeyError(
      `Cannot ${operation}: MajikKey has no signing keys. ` +
        `Re-import via key.importFromMnemonicBackup() to enable signing.`,
    );
  }
}

export function assertKeyHasMlKem(key: MajikKey, operation: string): void {
  if (!key.hasMlKem) {
    throw new MajikInvoiceKeyError(
      `Cannot ${operation}: MajikKey has no ML-KEM keys. ` +
        `Re-import via key.importFromMnemonicBackup() to enable decryption.`,
    );
  }
}
