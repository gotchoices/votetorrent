// Synthetic Google Play Integrity classic-API token builder (JWE-of-JWS,
// Phase 43 D-09). Module pattern mirrors `test/fixtures/keys.ts`: top-level
// named exports only, no class wrapper, no default export.
//
// Builds the exact decrypted-payload shape RESEARCH.md's Pattern 1 documents
// (`requestDetails.nonce` — the classic API's anti-relay field; NEVER
// `requestHash`, which belongs to the standard/Google-managed API D-04
// rejected) and produces a real, decryptable/verifiable compact JWE (A256KW
// key-wrap / A256GCM content-encryption / ES256 inner JWS) via `jose` — no
// hand-rolled AES-GCM/AES-KW/ECDSA framing (Don't Hand-Roll, RESEARCH.md).

import { CompactEncrypt, CompactSign, compactDecrypt, compactVerify } from 'jose'
import type { CryptoKey } from 'jose'
import { decode as base64urlDecode, encode as base64urlEncode } from 'jose/base64url'

/** The decrypted-and-verified classic-API payload shape (RESEARCH.md Pattern 1). */
export interface SyntheticIntegrityPayload {
  requestDetails: { requestPackageName: string, nonce: string, timestampMillis: string }
  appIntegrity: { appRecognitionVerdict: string, packageName: string, certificateSha256Digest: string[] }
  deviceIntegrity: { deviceRecognitionVerdict: string[] }
  accountDetails: { accountsSignedIn: string[] }
}

export interface SyntheticJwePayloadOverrides {
  requestPackageName?: string
  nonce?: string
  timestampMillis?: string
  appRecognitionVerdict?: string
  /** Defaults to `requestPackageName` — override independently to exercise the wrong-package negative branch. */
  appPackageName?: string
  deviceRecognitionVerdict?: string[]
}

const DEFAULT_PACKAGE_NAME = 'org.votetorrent.authority'

/** Build a PASS-shaped decrypted payload with sensible defaults, overridable per field for D-09 negative fixtures. */
export function buildDefaultSyntheticPayload (overrides?: SyntheticJwePayloadOverrides): SyntheticIntegrityPayload {
  const requestPackageName = overrides?.requestPackageName ?? DEFAULT_PACKAGE_NAME
  return {
    requestDetails: {
      requestPackageName,
      nonce: overrides?.nonce ?? 'synthetic-default-nonce',
      timestampMillis: overrides?.timestampMillis ?? String(Date.now())
    },
    appIntegrity: {
      appRecognitionVerdict: overrides?.appRecognitionVerdict ?? 'PLAY_RECOGNIZED',
      packageName: overrides?.appPackageName ?? requestPackageName,
      certificateSha256Digest: ['synthetic-cert-sha256-digest']
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: overrides?.deviceRecognitionVerdict ?? ['MEETS_DEVICE_INTEGRITY']
    },
    accountDetails: { accountsSignedIn: [] }
  }
}

/** The controllable test key material — an authority verifier under test is pointed at these instead of real Play Console keys. */
export interface SyntheticJweKeyMaterial {
  /** Raw A256KW/A256GCM symmetric key bytes (32 bytes). */
  decryptionKey: Uint8Array
  /** ES256 private key used to sign the inner JWS. */
  signingPrivateKey: CryptoKey
  /** ES256 public key a verifier checks the inner JWS against. */
  verificationPublicKey: CryptoKey
}

/** Generate a fresh, random A256KW key + ES256 signing keypair for one test's synthetic tokens. */
export async function generateSyntheticJweKeyMaterial (): Promise<SyntheticJweKeyMaterial> {
  const decryptionKey = crypto.getRandomValues(new Uint8Array(32))
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return { decryptionKey, signingPrivateKey: privateKey, verificationPublicKey: publicKey }
}

export interface BuildSyntheticJweOverrides {
  /** Sign the inner JWS with a DIFFERENT key than `keys.signingPrivateKey` — simulates a wrong-key negative. */
  signingKey?: CryptoKey
  /** Encrypt with a DIFFERENT key than `keys.decryptionKey` — simulates a wrong decryption-key negative. */
  encryptionKey?: Uint8Array
  /** Flip a byte in the JWE ciphertext AFTER encryption — simulates a tampered-token negative (fails GCM auth). */
  tamperCiphertext?: boolean
}

/**
 * Build a real, decryptable/verifiable compact JWE-of-JWS token: sign
 * `payload` as an ES256 compact JWS, then encrypt that compact JWS as an
 * A256KW/A256GCM compact JWE — the exact classic-API wire shape
 * (RESEARCH.md Pattern 1).
 */
export async function buildSyntheticJwe (
  payload: SyntheticIntegrityPayload,
  keys: SyntheticJweKeyMaterial,
  overrides?: BuildSyntheticJweOverrides
): Promise<string> {
  const innerJws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'ES256' })
    .sign(overrides?.signingKey ?? keys.signingPrivateKey)

  const compactJwe = await new CompactEncrypt(new TextEncoder().encode(innerJws))
    .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
    .encrypt(overrides?.encryptionKey ?? keys.decryptionKey)

  return overrides?.tamperCiphertext === true ? tamperCompactJweCiphertext(compactJwe) : compactJwe
}

/**
 * Build an ALGORITHM-CONFUSION attack token (CR-01 regression): the inner JWS
 * is HMAC-signed (`alg: HS256`) using `hmacSecretBytes` — the exact raw bytes a
 * naive verifier would hand `jose` as an "ES256 public key" — then wrapped in a
 * normal A256KW/A256GCM compact JWE under `decryptionKey`. A correct verifier
 * (real EC public key + `{ algorithms: ['ES256'] }`) MUST reject it; a verifier
 * that omits the algorithm allowlist and passes a raw `Uint8Array` key treats
 * those bytes as an HMAC secret and ACCEPTS the forgery.
 */
export async function buildForgedHs256Jwe (
  payload: SyntheticIntegrityPayload,
  decryptionKey: Uint8Array,
  hmacSecretBytes: Uint8Array
): Promise<string> {
  const innerJws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'HS256' })
    .sign(hmacSecretBytes)

  return new CompactEncrypt(new TextEncoder().encode(innerJws))
    .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
    .encrypt(decryptionKey)
}

/** Flip a byte in a compact JWE's ciphertext segment (index 3 of the 5 dot-separated parts) — breaks A256GCM's auth tag, so decryption must fail. */
function tamperCompactJweCiphertext (compactJwe: string): string {
  const parts = compactJwe.split('.')
  if (parts.length !== 5) {
    throw new Error(`tamperCompactJweCiphertext: expected a 5-part compact JWE, got ${parts.length} parts`)
  }
  const ciphertextBytes = base64urlDecode(parts[3]!)
  ciphertextBytes[0] = (ciphertextBytes[0] ?? 0) ^ 0xff
  parts[3] = base64urlEncode(ciphertextBytes)
  return parts.join('.')
}

/** Decrypt + verify a synthetic JWE with the SAME key material it was built with — used by `fixtures.spec.ts`'s round-trip structural-sanity assertion. */
export async function decodeSyntheticJwe (compactJwe: string, keys: SyntheticJweKeyMaterial): Promise<SyntheticIntegrityPayload> {
  const { plaintext } = await compactDecrypt(compactJwe, keys.decryptionKey)
  const innerJws = new TextDecoder().decode(plaintext)
  const { payload } = await compactVerify(innerJws, keys.verificationPublicKey)
  return JSON.parse(new TextDecoder().decode(payload)) as SyntheticIntegrityPayload
}
