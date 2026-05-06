import type { MajikKey } from "@majikah/majik-key";
import { MajikEnvelope, type MajikRecipient } from "@majikah/majik-envelope";
import { MajikInvoiceEncryptionError } from "./errors";
import type { EncryptedPayload } from "./types";

export async function buildEncryptedPayload(
  invoice: any,
  recipients: MajikRecipient[],
  _signerKey?: MajikKey,
): Promise<EncryptedPayload> {
  if (!recipients || recipients.length === 0) {
    throw new MajikInvoiceEncryptionError(
      "At least one recipient is required for encryption.",
    );
  }

  const plaintext = JSON.stringify(invoice.toJSON ? invoice.toJSON() : invoice);
  const senderFingerprint =
    recipients.length > 1 ? (recipients[0]?.fingerprint ?? "") : undefined;

  try {
    const envelope = await MajikEnvelope.encrypt({
      plaintext,
      recipients,
      senderFingerprint,
      compress: true,
    });

    return {
      kind: "encrypted-and-signed",
      envelopeString: envelope.toScannerString(),
      algorithm: "ML-KEM-768 + AES-256-GCM",
      recipientFingerprints: recipients.map((r) => r.fingerprint),
    } satisfies EncryptedPayload;
  } catch (err) {
    throw new MajikInvoiceEncryptionError(
      "Failed to encrypt invoice payload.",
      err,
    );
  }
}
