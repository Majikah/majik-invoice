
# Security Policy

Thank you for helping keep **Majik Invoice** and the broader Majikah ecosystem secure.

**Majik Invoice** is a TypeScript invoice domain library that combines structured accounting and document modeling with an optional cryptographic envelope for signing, verification, encryption, sealing, serialization, and secure invoice workflows.

Because the library can process financial information and cryptographic material, security issues are taken seriously and investigated carefully.

---

# Reporting Security Vulnerabilities

**Do not create a public GitHub issue for a suspected security vulnerability.**

Public disclosure before a vulnerability has been investigated and addressed may unnecessarily expose users and applications that depend on Majik Invoice.

## Private Vulnerability Reporting

For security vulnerabilities, please use **GitHub's Private Vulnerability Reporting** feature for this repository whenever possible.

This is the preferred channel for reports involving:

* Cryptographic implementation weaknesses
* Signature forgery or signature-verification bypasses
* Incorrect binding between signatures and invoice content
* Content-hash or integrity failures
* Canonical serialization or signing-preimage weaknesses
* Encryption or decryption weaknesses
* Recipient authorization or key-handling weaknesses
* Private-key exposure or unintended key disclosure
* Expected-signer allowlist bypasses
* Multi-signature or sealing bypasses
* Ability to modify a sealed invoice without detection
* Reissue or signature-state inconsistencies that could invalidate document authenticity
* Unauthorized access to encrypted invoice payloads
* Plaintext leakage from encrypted invoice workflows
* Decrypted invoice data being persisted or exposed unexpectedly
* Serialization/deserialization vulnerabilities
* Malformed JSON or binary envelope processing vulnerabilities
* Cloud-envelope authorization or ownership-related weaknesses
* Synchronization/conflict-resolution vulnerabilities that could compromise invoice integrity
* CSV export vulnerabilities that can lead to data exposure or spreadsheet injection
* Injection vulnerabilities through invoice fields or exported values
* Prototype pollution or object-manipulation vulnerabilities
* Denial-of-service conditions caused by malicious invoice input
* Regular-expression or parser denial of service
* Dependency or supply-chain vulnerabilities
* Vulnerabilities in integrations with `@majikah/majik-key`
* Vulnerabilities in integrations with `@majikah/majik-signature`
* Vulnerabilities in integrations with `@majikah/majik-envelope`
* Any issue that could compromise the **confidentiality, integrity, authenticity, or availability** of invoice data

When reporting a vulnerability involving a third-party dependency, please include the dependency name and affected version when known.

---

# Email

Security reports may also be submitted privately to:

**[business@majikah.solutions](mailto:business@majikah.solutions)**

Please include **SECURITY** in the subject line.

For example:

```text
SECURITY: MajikInvoice signature verification bypass
````

Do not include private keys, recovery phrases, passwords, authentication credentials, confidential invoices, or other sensitive information in an email report unless it is absolutely necessary.

When possible, provide a minimal reproduction that demonstrates the issue without exposing real user data.

---

# Application, API, Accounting & General Bugs

For issues that are **not security vulnerabilities**, please use the repository's public GitHub Issues.

This includes:

* Invoice calculation bugs
* Incorrect tax calculations
* Incorrect withholding calculations
* Line-item calculation errors
* Lifecycle transition problems
* Serialization bugs without a security impact
* CSV formatting issues
* Incorrect dashboard statistics
* Accounting projection issues
* API or developer-experience problems
* TypeScript type problems
* Documentation issues
* Unexpected but non-security-related behavior
* Performance problems that do not create a security impact

When reporting a normal bug, provide enough information for the issue to be reproduced and diagnosed.

When uncertain whether an issue has security implications, use **Private Vulnerability Reporting** or the security email address instead.

---

# 🧾 Bug Report Template

For a public, non-security issue, please copy and complete the following template.

````markdown
## Bug Summary

<!-- Give us a concise description of the problem. -->

### What happened?

<!-- Describe exactly what went wrong. -->

### What did you expect to happen?

<!-- Describe the expected behavior. -->

### Steps to reproduce

1.
2.
3.
4.

### Package Information

- `@majikah/majik-invoice` version:
- Node.js version:
- TypeScript version:
- Package manager:
- Runtime / environment:
- Operating system:

### Feature / Component

- [ ] GeneralInvoice
- [ ] MajikInvoice
- [ ] LineItem
- [ ] InvoiceTotals
- [ ] TaxManager
- [ ] Tax calculations
- [ ] Accounting projection
- [ ] Signing
- [ ] Signature verification
- [ ] Encryption
- [ ] Decryption
- [ ] Expected signers / multi-signature
- [ ] Sealing
- [ ] Reissue
- [ ] JSON serialization
- [ ] Binary serialization
- [ ] Canonical serialization
- [ ] Cloud envelope
- [ ] Batch operations
- [ ] CSV export
- [ ] Dashboard statistics
- [ ] Synchronization / conflict handling
- [ ] Other:

### Error message

<!-- Copy the exact error message. -->

```text
Paste error message here
```

### Stack trace

<!--
If the error includes a stack trace, please include the complete stack trace.
Remove only secrets or sensitive data.
-->

```text
Paste stack trace here
```

### Input / Reproduction Data

<!--
Provide the smallest possible reproducible invoice/input.

Do NOT include real private invoices, private keys, passwords,
recovery phrases, access tokens, or other secrets.
-->

```ts
Paste minimal reproduction here
```

### Expected Result

<!-- What should have happened? -->

### Actual Result

<!-- What actually happened? -->

### Additional Context

<!--
Include relevant dependency versions, serialized data shape,
operating environment, or other diagnostic information.
-->

````

---

# 🔐 Cryptographic Issue Reports

Security reports involving cryptographic behavior should include enough information to reproduce the issue without exposing actual secrets.

Where applicable, please include:

````text
Invoice mode:
Signature state:
Seal state:
Number of expected signers:
Number of collected signatures:
Encryption enabled:
Number of recipients:
Serialization format:
Package versions:
````


For cryptographic vulnerabilities, please describe the security property that fails.

Examples include:

* a signature verifies after invoice content has changed;
* a signature can be associated with the wrong invoice ID;
* a non-authorized signer can satisfy an expected-signer requirement;
* a sealed invoice can be modified without detection;
* encrypted invoice data becomes accessible without an authorized recipient key;
* malformed serialized data bypasses integrity validation.

Do **not** provide private keys or recovery phrases unless specifically requested through a controlled disclosure process.

---

# 🧩 MajikInvoice Security Model

Majik Invoice separates the **business document** from its **cryptographic envelope**.

### `GeneralInvoice`

`GeneralInvoice` represents the invoice itself, including:

* issuer and recipient information;
* line items;
* taxes and withholding;
* discounts;
* totals;
* payment information;
* accounting metadata;
* lifecycle state.

### `MajikInvoice`

`MajikInvoice` adds security and transport concerns such as:

* content hashing;
* digital signatures;
* signature verification;
* encryption;
* recipient handling;
* expected signers;
* sealing;
* public summaries;
* encrypted payloads;
* serialization;
* cloud envelopes.

Security reports should identify which layer is affected when possible.

---

# Cryptographic Components

Majik Invoice relies on dedicated Majikah cryptographic libraries rather than implementing all cryptographic primitives directly in the invoice domain layer.

## Signing

Signing and verification are provided through:

````text
@majikah/majik-signature
````

The current Majikah signing model combines:

````text
Ed25519
+
ML-DSA-87 (FIPS 204)
````

Issues involving signing, verification, signature metadata, expected signers, or sealing should identify the relevant package and version where possible.

## Encryption

Encrypted invoice payloads use:

````text
@majikah/majik-envelope
````

The envelope construction uses:

````text
ML-KEM-768
+
AES-256-GCM
````

Reports involving recipient access, decryption, ciphertext handling, or encrypted payload confidentiality should identify the affected operation.

## Key Material

Cryptographic keys are provided through:

````text
@majikah/majik-key
````

Never submit an actual private key, recovery phrase, or password in a public issue.

---

# Integrity & Authenticity

MajikInvoice maintains an integrity block containing information such as:

* content hash;
* hash algorithm;
* signatures;
* expected signers;
* signer allowlist information;
* seal information;
* sealing state.

Security reports should distinguish between:

**Integrity failures**

The invoice content can be modified without detection.

**Authenticity failures**

An unauthorized or forged signature is accepted as valid.

**Authorization failures**

A signer or recipient without the required authority can perform an operation.

**Confidentiality failures**

Encrypted invoice content can be recovered without appropriate authorization.

---

# Canonical Signing

MajikInvoice uses a deterministic, versioned signing context that binds the invoice content hash to the invoice ID.

The signing context is domain-separated using:

````text
majik-invoice-v1
````

Security issues involving canonicalization should explain whether the problem is related to:

* inconsistent serialization;
* ambiguous encoding;
* content-hash calculation;
* invoice-ID binding;
* signature verification;
* cross-format interpretation.

A canonicalization vulnerability may have security consequences even when the underlying signature algorithm itself is functioning correctly.

---

# Encryption & Decryption

Encrypted invoices contain an encrypted payload rather than exposing their complete `GeneralInvoice` contents.

MajikInvoice also maintains a runtime decrypted representation when an authorized decryption operation succeeds.

A security report should distinguish between:

* encrypted persisted data;
* public invoice summary data;
* runtime decrypted invoice data;
* serialized invoice data.

Potential confidentiality issues include unintended plaintext persistence, leakage through logs or errors, incorrect recipient authorization, or access to decrypted data after it should no longer be available.

---

# Public Invoice Summary

Encrypted invoices expose a `PublicInvoiceSummary` containing intentionally accessible information such as:

* issuer name;
* recipient name;
* currency;
* total amount when available;
* formatted total;
* invoice type;
* issue date;
* due date;
* invoice number;
* invoice status;
* payment status.

The existence of public summary data is therefore **not itself a confidentiality vulnerability**.

Please report an issue when information outside the intended public summary becomes accessible without authorization.

---

# Signatures, Expected Signers & Sealing

MajikInvoice supports multiple signatures and expected-signer allowlists.

Security reports are particularly important when a malicious party can:

* bypass an expected-signer requirement;
* impersonate another signer;
* insert an unauthorized signature;
* remove or replace a required signature;
* make an invalid signature appear valid;
* seal an invoice without satisfying required conditions;
* continue modifying or signing an invoice after sealing;
* preserve a valid signature after changing the signed business content.

When reporting such an issue, include the sequence of operations that leads to the unexpected state.

---

# Reissue & Document Changes

Changing a signed invoice must not cause an old signature to be incorrectly treated as proof of the modified document.

Security reports involving `reissue()` should explain:

* the original invoice state;
* the modified invoice state;
* the original signatures;
* the resulting signatures;
* whether the changed invoice was accepted as authentic.

A signature remaining valid after a materially different invoice is introduced may represent a serious integrity issue.

---

# Serialization & Parsing

MajikInvoice supports structured representations for persistence and transport.

Security-sensitive reports may involve:

* malformed JSON;
* maliciously crafted envelope data;
* unexpected object shapes;
* inconsistent versions;
* invalid signatures;
* invalid content hashes;
* recipient manipulation;
* integrity metadata tampering;
* unsafe deserialization behavior;
* denial of service caused by specially crafted input.

Please include the smallest serialized reproduction possible.

Do not submit real confidential invoices.

---

# Cloud Envelope & Synchronization

MajikInvoice includes cloud-oriented structures and synchronization primitives.

Security issues may involve:

* incorrect ownership association;
* unauthorized account access;
* invoice mix-ups;
* remote/local state confusion;
* malicious conflict manipulation;
* accepting stale or tampered remote data;
* incorrect conflict resolution;
* integrity loss during synchronization.

When reporting synchronization vulnerabilities, provide the local state, remote state, and resulting state where possible, using synthetic data.

---

# CSV Export Security

CSV export accepts invoice fields and custom column resolvers and therefore crosses a boundary into formats commonly consumed by spreadsheet software.

Potential security issues include:

* spreadsheet formula injection;
* unintended data exposure;
* unsafe value transformation;
* malicious custom column behavior;
* incorrect escaping;
* CSV row/column injection;
* export of data that should remain inaccessible from encrypted invoices.

Majik Invoice's CSV layer includes escaping and spreadsheet-injection handling, but vulnerabilities in that protection should still be reported privately when they can result in code execution, unauthorized formula execution, or sensitive-data disclosure.

Do not attach real confidential invoices to a public issue.

---

# Denial of Service

Majik Invoice may process application-controlled or externally supplied invoice data.

Security reports should be submitted privately when specially crafted inputs can cause:

* unbounded memory consumption;
* excessive CPU usage;
* stack exhaustion;
* pathological parsing behavior;
* repeated cryptographic work that can be abused remotely;
* application-wide denial of service.

Please provide the smallest input that reproduces the issue.

---

# Dependency & Supply-Chain Security

Majik Invoice depends on external packages, including cryptographic and monetary libraries.

Security reports should include dependency information when relevant, especially for vulnerabilities affecting:

````text
@majikah/majik-key
@majikah/majik-signature
@majikah/majik-envelope
@thezelijah/majik-money
````

Also report vulnerabilities caused by:

* compromised dependencies;
* malicious package updates;
* unexpected transitive dependencies;
* dependency confusion;
* package namespace attacks;
* compromised build artifacts.

---

# What Not to Include

Never publicly post:

* Private keys
* BIP-39 recovery phrases
* Passwords or passphrases
* API keys
* Access tokens
* Session credentials
* Confidential invoices
* Customer financial information
* Personally identifiable information
* Private recipient information
* Private cryptographic material
* Unreleased vulnerability exploit details
* Any other secret or credential

For sensitive reproduction data, use **Private Vulnerability Reporting** or:

**[business@majikah.solutions](mailto:business@majikah.solutions)**

---

# Responsible Disclosure

For valid security vulnerabilities, please allow Majikah reasonable time to:

1. Receive and reproduce the report.
2. Determine the affected security boundary.
3. Assess the severity and impact.
4. Identify affected package versions.
5. Develop and test a fix or mitigation.
6. Publish the appropriate release.
7. Communicate relevant remediation information.

Please avoid publicly publishing exploit details, proof-of-concept attacks, affected confidential data, or other information that could materially increase risk before a fix or mitigation is available.

---

# Security Research Scope

Security research involving Majik Invoice may include, but is not limited to:

* `GeneralInvoice`
* `MajikInvoice`
* invoice validation
* tax and monetary handling where security-relevant
* content hashing
* canonical serialization
* signing
* signature verification
* expected signers
* multi-signature workflows
* sealing
* encryption
* decryption
* recipient handling
* public invoice summaries
* JSON serialization
* binary serialization
* cloud invoice envelopes
* synchronization
* conflict handling
* batch workflows
* CSV export
* custom CSV column resolution
* dependency interactions
* malformed-input handling

For vulnerabilities originating primarily in another Majikah package, please report the issue to the affected project as well, while providing the MajikInvoice integration context when relevant.

---

# Security Severity

When possible, please describe the practical impact of the vulnerability.

Useful categories include:

| Impact          | Example                                                               |
| --------------- | --------------------------------------------------------------------- |
| Confidentiality | Unauthorized access to encrypted invoice contents                     |
| Integrity       | Modified invoice accepted as authentic                                |
| Authenticity    | Forged or unauthorized signature accepted                             |
| Authorization   | Unauthorized signer or recipient action succeeds                      |
| Availability    | Malicious invoice input causes denial of service                      |
| Data exposure   | Sensitive invoice fields leak through serialization, logs, or exports |
| Supply chain    | Compromised dependency affects invoice security                       |

You do not need to assign a formal CVSS score. A clear description of the impact and attack conditions is more useful than an unsupported severity estimate.

---

# Contact

### Security vulnerabilities

**Preferred:** GitHub Private Vulnerability Reporting

**Alternative:**
**[business@majikah.solutions](mailto:business@majikah.solutions)**

Please use **SECURITY** in the email subject.

### General bugs and developer issues

Open a **[GitHub Issue](../../issues/new/choose)** and provide the reproduction information described above.

---

# Thank You

Security is a shared responsibility.

Every responsible disclosure helps improve the confidentiality, integrity, authenticity, and reliability of the invoice workflows built on Majik Invoice.

Thank you for helping make the Majikah ecosystem safer for developers, businesses, and users.




