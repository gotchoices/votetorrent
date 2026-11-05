// `@peculiar/x509`'s internal DI container (tsyringe) requires this polyfill
// to be loaded before any of its exports are used — must be the first import.
import 'reflect-metadata'
import { X509Certificate } from '@peculiar/x509'
import { AsnConvert } from '@peculiar/asn1-schema'
import { KeyDescription, KeyMintKeyDescription, SecurityLevel } from '@peculiar/asn1-android'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync, appendFileSync } from 'node:fs'

/**
 * decode-attestation-leaf.mjs — 45-11 Leg 4. Derives the D-07 verdict by DECODING the
 * captured attestation certificate chain, rather than reading a claim out of a proof log
 * the reporting agent also authors.
 *
 * Mirrors `packages/vote-engine/src/association/verifiers/key-attestation.ts:130-173`
 * (the shipped Phase 43 verifier) rather than re-inventing a parse: same OID, same
 * `AsnConvert.parse(ext.value, KeyDescription)` with the
 * `KeyMintKeyDescription().toLegacyKeyDescription()` fallback, same numeric SecurityLevel
 * comparisons, same `timingSafeEqual` challenge byte-compare.
 *
 * Lives under `packages/vote-engine/` so Node resolves `@peculiar/*` and `reflect-metadata`
 * from that package's own `node_modules` (bare specifiers resolve from the SCRIPT's
 * directory upward, not from cwd). That package is `"type": "module"`, so this is `.mjs`-safe.
 *
 * Usage:
 *   node decode-attestation-leaf.mjs <chain.json> <proof-log.md> <BOUND_DIGEST>
 *
 * Exit 0 ONLY if ALL THREE hold:
 *   (i)   attestationSecurityLevel  >= SecurityLevel.trustedEnvironment (1 or 2)
 *   (ii)  keymasterSecurityLevel    >= SecurityLevel.trustedEnvironment (1 or 2)
 *   (iii) attestationChallenge bytes === utf8(BOUND_DIGEST)
 *
 * (i)/(ii) admit BOTH hardware rungs. Whether the StrongBox rung (2) specifically was
 * selected is reported separately as `strongBoxRung` and gated on by the ceremony script's
 * `hw-strongbox-rung` leg — never inferred from this script's exit code.
 *
 * (iii) is INSIDE the exit gate on purpose. (i)+(ii) alone are satisfied by ANY genuinely
 * TEE-backed chain — including one replayed from an unrelated run or a different device.
 * BOUND_DIGEST derives from this ceremony's live single-use nonce, so folding the challenge
 * comparison into the same condition is what ties the machine-checked PASS to THIS attested
 * key. A stale-but-genuine chain MUST fail here.
 *
 * NOTE: `SecurityLevel` is a NUMERIC TS enum (`software = 0`, `trustedEnvironment = 1`,
 * `strongBox = 2`). The capitalized `Software`/`TrustedEnvironment`/`StrongBox` spellings
 * exist only in the ASN.1 grammar comment and have NO runtime form — never gate on them.
 */

const ATTESTATION_EXTENSION_OID = '1.3.6.1.4.1.11129.2.1.17'

const [chainPath, logPath, boundDigest] = process.argv.slice(2)
if (!chainPath || !logPath || !boundDigest) {
	console.error('usage: node decode-attestation-leaf.mjs <chain.json> <proof-log.md> <BOUND_DIGEST>')
	process.exit(2)
}

const chain = JSON.parse(readFileSync(chainPath, 'utf8'))
if (!Array.isArray(chain) || chain.length === 0) {
	console.error(`FAIL: ${chainPath} is not a non-empty JSON array`)
	process.exit(1)
}

// Leaf-first, exactly as KeyStore.getCertificateChain() returns and as the verifier assumes.
// Pitfall 6: parse the LEAF's extension specifically — never search the whole chain.
const leaf = new X509Certificate(Buffer.from(chain[0], 'base64'))
const ext = leaf.getExtension(ATTESTATION_EXTENSION_OID)
if (!ext) {
	console.error('FAIL: leaf carries no KeyDescription attestation extension')
	process.exit(1)
}

let kd
try {
	kd = AsnConvert.parse(ext.value, KeyDescription)
} catch {
	kd = AsnConvert.parse(ext.value, KeyMintKeyDescription).toLegacyKeyDescription()
}

const attestationSecurityLevel = kd.attestationSecurityLevel
const keymasterSecurityLevel = kd.keymasterSecurityLevel
const challengeBytes = new Uint8Array(kd.attestationChallenge.buffer)
const expected = new TextEncoder().encode(boundDigest)
const challengeBound =
	expected.length === challengeBytes.length && timingSafeEqual(expected, challengeBytes)

// D-15b: exported chain is leaf + intermediates with the trailing root DROPPED.
// A self-signed terminal cert (subject === issuer) would mean a root was included.
const last = new X509Certificate(Buffer.from(chain[chain.length - 1], 'base64'))
const rootPresent = last.subject === last.issuer

// Both hardware rungs satisfy D-07: trustedEnvironment (1) and strongBox (2). The gate is
// `>= trustedEnvironment` rather than `=== trustedEnvironment` so a genuine StrongBox chain —
// which reports 2 on both fields — is not scored a FAIL by a decoder written when TEE was the
// only rung this project's fleet could reach. software (0) still fails.
// WHICH rung was selected is a SEPARATE verdict, reported below and gated on by the ceremony
// script's own `hw-strongbox-rung` leg; it is deliberately NOT folded into this exit code.
const TEE = SecurityLevel.trustedEnvironment // === 1
const pass =
	attestationSecurityLevel >= TEE && keymasterSecurityLevel >= TEE && challengeBound
const strongBoxRung =
	attestationSecurityLevel === SecurityLevel.strongBox &&
	keymasterSecurityLevel === SecurityLevel.strongBox

const hex = Buffer.from(challengeBytes).toString('hex')
const utf8 = Buffer.from(challengeBytes).toString('utf8')

const block = `
### Leg 4 — machine-derived decode (emitted by decode-attestation-leaf.mjs, NOT transcribed)

Decoded from \`${chainPath}\` via the same parse path as \`key-attestation.ts:130-173\`.

attestationSecurityLevel: ${attestationSecurityLevel} (${SecurityLevel[attestationSecurityLevel]})
keymasterSecurityLevel: ${keymasterSecurityLevel} (${SecurityLevel[keymasterSecurityLevel]})
attestationChallenge (hex): ${hex}
attestationChallenge (utf8): ${utf8}
expected BOUND_DIGEST: ${boundDigest}
challengeBound: ${challengeBound}
chainLength: ${chain.length}
rootPresent: ${rootPresent}
strongBoxRung: ${strongBoxRung}

**D-07 VERDICT: ${pass ? 'PASS' : 'FAIL'}** (exit ${pass ? 0 : 1}) — requires
attestationSecurityLevel >= 1 AND keymasterSecurityLevel >= 1 AND challengeBound === true,
in one condition (both hardware rungs qualify; software (0) does not).

**Rung selected: ${strongBoxRung ? 'strongBox (2)' : `${SecurityLevel[attestationSecurityLevel]} (${attestationSecurityLevel})`}.** ${
	strongBoxRung
		? 'The StrongBox-primary path executed — this is the D-27 leg 1 reopen condition.'
		: 'NOT StrongBox — a TEE result is the expected fallback on hardware with no StrongBox chip, and it does NOT satisfy the D-27 leg 1 rung, which requires 2 on BOTH fields.'
}
`

appendFileSync(logPath, block)
console.log(block)
process.exit(pass ? 0 : 1)
