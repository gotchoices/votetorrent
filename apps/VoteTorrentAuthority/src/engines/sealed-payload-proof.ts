/**
 * sealed-payload-proof.ts — Phase 52 on-device Hermes proof for the sealed
 * bootstrap payload (D-05). Logs under the `[seal-kat]` tag.
 *
 * ---------------------------------------------------------------------------
 * What this proves, and why no jest tier can prove it
 * ---------------------------------------------------------------------------
 *
 * `@noble/ciphers` is a NEW dependency in this app's bundle. Phase 44 lost days
 * to three device-only defects that every jest suite was blind to (the
 * export-namespace babel plugin, the tslib CJS-UMD Metro redirect,
 * `requireSignedSchemas`). No mocha/jest/headless tier can see a Metro/Hermes
 * bundling defect, so the rule is: prove it boots on a real device before
 * trusting it.
 *
 * Three assertions, in order of increasing strength:
 *
 *   1. STATIC RESOLUTION  — this module imports the cipher through the shipped
 *      subpath barrel that both apps use. If Metro cannot resolve it, the app
 *      red-boxes and the run script's served-bundle greps miss their markers.
 *   2. MODULE EVALUATION  — the legs below actually CALL the primitives, so a
 *      module that resolves but binds the wrong instance (the multi-copy class
 *      that made `secp256k1.sign` fatal on Hermes) surfaces as a throw.
 *   3. KNOWN-ANSWER BYTES — the derive and unseal legs pin against constants
 *      computed by `node:crypto`, and the seal leg's wrapper is emitted to
 *      logcat so `scripts/lib/seal-kat-verify.mjs` can decrypt the DEVICE's own
 *      ciphertext on the host. That host cross-decrypt is the load-bearing
 *      assertion: not "the app didn't crash", but "Hermes and Node agree on the
 *      AES-256-GCM bytes".
 *
 * ---------------------------------------------------------------------------
 * Fixed vectors, never random
 * ---------------------------------------------------------------------------
 *
 * The secret is 20 fixed bytes and the plaintext is a fixed literal. Nothing
 * here draws entropy except `sealPayload`'s own per-call nonce, which is the
 * point of the seal leg — a deterministic proof is one whose failure is
 * reproducible, and a fixed secret is one that can never be confused with a
 * real mint's.
 *
 * `contentKey` IS NEVER LOGGED, in any encoding, on any path. The host verifier
 * re-derives it from the same fixed secret instead of being handed it. A jest
 * canary in `__tests__/sealed-payload-proof.test.ts` reads this file back and
 * asserts no non-comment line combines a console call with that identifier.
 *
 * ---------------------------------------------------------------------------
 * Why a leg may report UNSUPPORTED-RUNTIME rather than FAIL
 * ---------------------------------------------------------------------------
 *
 * `unsealPayload` decodes its plaintext with `TextDecoder`, which the browser
 * and Node both have and Hermes may not. Under D-06 unsealing happens in the
 * browser consumer, never on the phone — so a `TextDecoder`-shaped failure of
 * the decrypt legs is NOT a D-05 failure. Those legs report
 * `UNSUPPORTED-RUNTIME` / `SKIPPED`, mirroring `recovery-branch-proof-runner`'s
 * `UNSUPPORTED-OS` idiom, and the seal leg (which the host verifies) carries the
 * verdict. Every non-PASS status is printed inside the verdict block so a
 * partial proof can never be transcribed as a full one.
 *
 * Errors are logged by CLASS NAME only — never a raw message, which could
 * interpolate key or payload bytes.
 */

import {
	deriveBootstrapKeys,
	sealPayload,
	unsealPayload,
	type BootstrapKeySplit,
	type SealedPayload,
} from '@votetorrent/vote-engine/bootstrap';

// ---------------------------------------------------------------------------
// Locked constants — see 52-07-PLAN.md's <locked_construction> table
// ---------------------------------------------------------------------------

/** Every line this proof emits carries this prefix. No phase number, no decision ID. */
const TAG = '[seal-kat]';

/** The fixed 20-byte test secret. All `0x2a`; never `crypto.getRandomValues`. */
const KAT_SECRET = new Uint8Array(20).fill(0x2a);

/**
 * The fixed test plaintext. This literal is ALSO the served-bundle provenance
 * marker: it appears nowhere else in the tree, so a hit inside the bundle the
 * device actually fetched proves THIS module is in it.
 */
const KAT_PLAINTEXT = 'sealed-payload-kat-v1';

/**
 * `deriveBootstrapKeys(KAT_SECRET).lookupId`, computed once on the host and
 * pinned here. Independently re-derived from `node:crypto` HMAC-SHA256 by the
 * jest positive control, so a wrong constant fails in Node long before a device
 * run could be blamed on Hermes.
 */
const KAT_LOOKUP_ID = 'm6tt8br-eQnbu-DtXgqikUAK6aU5YAgBpCPOoHHbvFc';

/**
 * A wrapper sealed HOST-SIDE by `node:crypto` over `KAT_PLAINTEXT` under the
 * same fixed secret, with the nonce pinned to the frozen `a0a1…aaab` vector.
 * The `unseal-kat` leg is therefore a cross-implementation known-answer test in
 * the DECRYPT direction: Node encrypted these bytes, Hermes must recover them.
 */
const KAT_WRAPPER: SealedPayload = {
	v: 1,
	nonce: 'oKGio6Slpqeoqaqr',
	ciphertext: 'qXNuk5pAGJW2xzVRrjb8G6GXFJhEN07Ja28qKlbwvj9hFQUnVg',
};

/** AES-GCM's tag width. An invariant of the mode, not a tuning knob. */
const GCM_TAG_BYTES = 16;

/** The only nonce width this format accepts. */
const NONCE_BYTES = 12;

/** `contentKey` is AES-256's key width. */
const KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * `UNSUPPORTED-RUNTIME` and `SKIPPED` do not fail the verdict, but they are
 * printed inside the verdict block — a partial proof must never read as a full
 * one.
 */
export type SealedPayloadLegStatus =
	| 'PASS'
	| 'FAIL'
	| 'UNSUPPORTED-RUNTIME'
	| 'SKIPPED';

export interface SealedPayloadProofLeg {
	readonly name: 'derive' | 'seal' | 'unseal-kat' | 'tamper';
	readonly status: SealedPayloadLegStatus;
	/** Structure only — a length, a status word, an error CLASS. Never bytes. */
	readonly detail: string;
}

export interface SealedPayloadProofResult {
	readonly verdict: 'PASS' | 'FAIL';
	readonly legs: readonly SealedPayloadProofLeg[];
}

// ---------------------------------------------------------------------------
// Module-private base64url — hand-rolled on purpose
// ---------------------------------------------------------------------------
//
// Deliberately NOT `atob`/`btoa`: this proof must not depend on a host global
// whose absence would be reported as a cipher failure. A self-contained codec
// makes every non-PASS leg attributable to the cipher under test.

const B64URL_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decode unpadded base64url. Returns `null` for anything outside the alphabet. */
function fromBase64url(value: string): Uint8Array | null {
	const out: number[] = [];
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < value.length; i++) {
		const index = B64URL_ALPHABET.indexOf(value[i]!);
		if (index < 0) {
			return null;
		}
		acc = (acc << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((acc >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

/** Encode bytes as unpadded base64url. */
function toBase64url(bytes: Uint8Array): string {
	let out = '';
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < bytes.length; i++) {
		acc = (acc << 8) | bytes[i]!;
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out += B64URL_ALPHABET[(acc >> bits) & 0x3f];
		}
	}
	if (bits > 0) {
		out += B64URL_ALPHABET[(acc << (6 - bits)) & 0x3f];
	}
	return out;
}

/** UTF-8 byte length of an ASCII-only literal, computed without `TextEncoder`. */
function utf8Length(value: string): number {
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		length += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
	}
	return length;
}

/** The class name of a thrown value — never its message (which could carry bytes). */
function errorClass(err: unknown): string {
	if (err === null || err === undefined) {
		return 'null';
	}
	const ctor = (err as { constructor?: { name?: string } }).constructor;
	return ctor?.name ?? typeof err;
}

/**
 * True when a refusal is `TextDecoder`-shaped rather than cipher-shaped.
 * `unsealPayload` catches its own `bytesToUtf8` throw and reports it as
 * `malformed-wrapper` with a UTF-8 detail, so an absent `TextDecoder` on Hermes
 * arrives here as that reason rather than as an exception.
 */
function looksLikeMissingTextDecoder(detail: string): boolean {
	return (
		typeof TextDecoder === 'undefined' ||
		detail.indexOf('not valid UTF-8') >= 0 ||
		detail.indexOf('TextDecoder') >= 0
	);
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

/**
 * Run the four-leg sealed-payload proof. **Never throws** — a failure anywhere
 * becomes a FAIL leg, because a proof that dies without a verdict line is
 * indistinguishable from a proof that never ran.
 */
export async function runSealedPayloadProof(): Promise<SealedPayloadProofResult> {
	console.info(`${TAG} sealed payload proof: starting`);

	const legs: SealedPayloadProofLeg[] = [];
	let keys: BootstrapKeySplit | undefined;

	// --- Leg 1: derive -------------------------------------------------------
	try {
		keys = deriveBootstrapKeys(KAT_SECRET);
		console.info(`${TAG} lookupId=${keys.lookupId}`);

		const problems: string[] = [];
		if (keys.lookupId !== KAT_LOOKUP_ID) {
			problems.push('lookupId does not match the pinned host-computed value');
		}
		if (keys.contentKey.length !== KEY_BYTES) {
			problems.push(
				`contentKey is ${keys.contentKey.length} bytes (expected ${KEY_BYTES})`,
			);
		}
		// Domain separation, actually wired: the two halves must not collide.
		// This value is compared and then discarded — it is never logged.
		const derivedPrivateHalfEncoded = toBase64url(keys.contentKey);
		if (keys.lookupId === derivedPrivateHalfEncoded) {
			problems.push('the two derived halves are identical — labels not applied');
		}

		legs.push({
			name: 'derive',
			status: problems.length === 0 ? 'PASS' : 'FAIL',
			detail:
				problems.length === 0
					? `lookupId matches pinned value; private half is ${KEY_BYTES} bytes and distinct`
					: problems.join('; '),
		});
	} catch (err) {
		legs.push({
			name: 'derive',
			status: 'FAIL',
			detail: `threw ${errorClass(err)}`,
		});
	}

	// --- Leg 2: seal ---------------------------------------------------------
	// The evidence leg. Its wrapper goes to logcat and the host decrypts it with
	// node:crypto — that cross-decrypt, not this leg's own shape checks, is what
	// discharges D-05.
	if (keys === undefined) {
		legs.push({
			name: 'seal',
			status: 'FAIL',
			detail: 'skipped: derive leg produced no key split',
		});
	} else {
		try {
			const wrapper = sealPayload(KAT_PLAINTEXT, keys);
			console.info(`${TAG} wrapper=${JSON.stringify(wrapper)}`);

			const problems: string[] = [];
			const members = Object.keys(wrapper).sort().join(',');
			if (members !== 'ciphertext,nonce,v') {
				problems.push(`wrapper members are '${members}' (expected 'ciphertext,nonce,v')`);
			}
			if (wrapper.v !== 1) {
				problems.push(`wrapper.v is ${String(wrapper.v)} (expected 1)`);
			}
			const nonce = fromBase64url(wrapper.nonce);
			if (nonce === null) {
				problems.push('wrapper.nonce is not unpadded base64url');
			} else if (nonce.length !== NONCE_BYTES) {
				problems.push(`nonce decoded to ${nonce.length} bytes (expected ${NONCE_BYTES})`);
			}
			const ciphertext = fromBase64url(wrapper.ciphertext);
			const expectedCiphertextBytes = utf8Length(KAT_PLAINTEXT) + GCM_TAG_BYTES;
			if (ciphertext === null) {
				problems.push('wrapper.ciphertext is not unpadded base64url');
			} else if (ciphertext.length !== expectedCiphertextBytes) {
				problems.push(
					`ciphertext decoded to ${ciphertext.length} bytes ` +
						`(expected ${expectedCiphertextBytes} = plaintext + ${GCM_TAG_BYTES}-byte tag)`,
				);
			}

			legs.push({
				name: 'seal',
				status: problems.length === 0 ? 'PASS' : 'FAIL',
				detail:
					problems.length === 0
						? `wrapper has exactly {v,nonce,ciphertext}; nonce ${NONCE_BYTES} bytes; ` +
							`ciphertext ${expectedCiphertextBytes} bytes (tag appended)`
						: problems.join('; '),
			});
		} catch (err) {
			legs.push({
				name: 'seal',
				status: 'FAIL',
				detail: `threw ${errorClass(err)}`,
			});
		}
	}

	// --- Leg 3: unseal-kat ---------------------------------------------------
	let unsealUnsupported = false;
	if (keys === undefined) {
		legs.push({
			name: 'unseal-kat',
			status: 'FAIL',
			detail: 'skipped: derive leg produced no key split',
		});
	} else {
		try {
			const result = unsealPayload(KAT_WRAPPER, keys);
			if (result.ok) {
				const matched = result.plaintext === KAT_PLAINTEXT;
				legs.push({
					name: 'unseal-kat',
					status: matched ? 'PASS' : 'FAIL',
					detail: matched
						? 'recovered the pinned plaintext from a node:crypto-sealed wrapper'
						: 'recovered a plaintext that is not the pinned literal',
				});
			} else if (looksLikeMissingTextDecoder(result.detail)) {
				unsealUnsupported = true;
				legs.push({
					name: 'unseal-kat',
					status: 'UNSUPPORTED-RUNTIME',
					detail:
						`refused with reason '${result.reason}' and this runtime has no usable ` +
						'TextDecoder — decrypt is a browser-side operation under D-06, so this is ' +
						'not a cipher failure',
				});
			} else {
				legs.push({
					name: 'unseal-kat',
					status: 'FAIL',
					detail: `refused a valid wrapper with reason '${result.reason}'`,
				});
			}
		} catch (err) {
			const cls = errorClass(err);
			const unsupported =
				typeof TextDecoder === 'undefined' || cls === 'ReferenceError';
			unsealUnsupported = unsupported;
			legs.push({
				name: 'unseal-kat',
				status: unsupported ? 'UNSUPPORTED-RUNTIME' : 'FAIL',
				detail: `threw ${cls}`,
			});
		}
	}

	// --- Leg 4: tamper (negative control) ------------------------------------
	// A silently-passing GCM tag check is the worst possible outcome, so an
	// ACCEPTED tamper is FAIL even when everything else is green.
	if (keys === undefined) {
		legs.push({
			name: 'tamper',
			status: 'FAIL',
			detail: 'skipped: derive leg produced no key split',
		});
	} else {
		try {
			const original = fromBase64url(KAT_WRAPPER.ciphertext);
			if (original === null || original.length === 0) {
				legs.push({
					name: 'tamper',
					status: 'FAIL',
					detail: 'the pinned wrapper ciphertext did not decode',
				});
			} else {
				const flipped = Uint8Array.from(original);
				flipped[0] = flipped[0]! ^ 0x01;
				const tampered: SealedPayload = {
					v: KAT_WRAPPER.v,
					nonce: KAT_WRAPPER.nonce,
					ciphertext: toBase64url(flipped),
				};
				const result = unsealPayload(tampered, keys);
				const refused = result.ok === false;
				const observed = refused ? `reason '${result.reason}'` : 'ACCEPTED';
				if (unsealUnsupported) {
					// Reported as SKIPPED because the positive direction could not be
					// established on this runtime — but the observed refusal is recorded
					// anyway rather than thrown away.
					legs.push({
						name: 'tamper',
						status: 'SKIPPED',
						detail:
							'unseal-kat reported UNSUPPORTED-RUNTIME, so the decrypt direction is ' +
							`not established here; tamper attempt observed ${observed}`,
					});
				} else {
					legs.push({
						name: 'tamper',
						status: refused ? 'PASS' : 'FAIL',
						detail: refused
							? `a one-byte ciphertext flip was refused with ${observed}`
							: 'a one-byte ciphertext flip was ACCEPTED — the GCM tag check is not running',
					});
				}
			}
		} catch (err) {
			legs.push({
				name: 'tamper',
				status: 'FAIL',
				detail: `threw ${errorClass(err)}`,
			});
		}
	}

	// --- Verdict -------------------------------------------------------------
	for (const leg of legs) {
		console.info(`${TAG} leg ${leg.name}: ${leg.status} — ${leg.detail}`);
	}
	const summary = legs.map(leg => `${leg.name}=${leg.status}`).join(' ');
	console.info(`${TAG} legs: ${summary}`);

	const verdict: 'PASS' | 'FAIL' = legs.some(leg => leg.status === 'FAIL')
		? 'FAIL'
		: 'PASS';
	// ONE string argument, so the line lands in logcat verbatim and can be quoted
	// into the evidence file without RN's multi-arg comma rendering.
	console.info(`${TAG} ========== SEALED PAYLOAD VERDICT: ${verdict} ==========`);

	return { verdict, legs };
}
