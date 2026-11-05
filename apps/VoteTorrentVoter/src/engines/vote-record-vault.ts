/**
 * vote-record-vault.ts - envelope vault for the voter's local vote record (D-29, D-13, Phase 63
 * plan 07).
 *
 * Envelope encryption: the record is never plaintext and never in strand LevelDB. The vault
 * performs no persistence; 63-08's store writes the envelope JSON.
 *
 * AAD binding: both the record ciphertext and the wrapped data key are bound to
 * `votetorrent-vote-record-v1:<electionId>`, so another election's envelope never opens.
 *
 * The 32-byte data key and the plaintext record bytes are zero-filled after every seal and open.
 * Honest residual: JSON strings are immutable on Hermes and cannot be zeroed, so only byte buffers
 * are cleared.
 *
 * Fail closed: an unreadable record is a typed reason surfaced to the UI. It is never
 * regenerated, and it never silently re-enables Submit.
 *
 * No logging: the only diagnostic surface is `VoteRecordUnavailableError.reason`.
 *
 * Serialization is `JSON.stringify`, not vote-engine `canonicalJson`. The vault ciphertext is
 * never hashed or signed; the signature covers `voterEntryDigest`, built by vote-engine in 63-11.
 */

import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import {
	SECRET_WRAP_ERROR_CODES,
	SecretWrapError,
	type SecretWrapErrorCode,
	type SecretWrapPrompt,
	type WrappedSecret,
} from '@votetorrent/attestation-native'
import { resolveVoteRecordWrapProvider, VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1 } from './vote-record-wrap'

type Base64GlobalEnv = {
	btoa: (data: string) => string
	atob: (data: string) => string
}
const { btoa: btoaFn, atob: atobFn } = globalThis as unknown as Base64GlobalEnv

type FatalTextDecoderCtor = new (label: string, options: { fatal: boolean }) => { decode(input: Uint8Array): string }
const FatalTextDecoder = (globalThis as unknown as { TextDecoder: FatalTextDecoderCtor }).TextDecoder

function base64FromBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

function bytesFromBase64(value: string): Uint8Array {
	const binary = atobFn(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

export interface VoteRecordAnswer {
	questionCode: string
	optionCodes: string[]
}

export interface VoteRecordVoteEntry {
	v: 1
	electionId: string
	electionRevision: number
	ballotId: string
	templateDigest: string
	answers: VoteRecordAnswer[]
	nonce: string
}

export interface VoteRecordVoterEntry {
	v: 1
	electionId: string
	electionRevision: number
	registrantId: string
	privateCid: string
	publicCid: string | null
	deviceKey: string
	attestationCid: string | null
	ballots: Array<{ ballotId: string; templateDigest: string }>
	signature: string
}

export interface VoteRecord {
	v: 1
	electionId: string
	electionRevision: number
	savedAt: string
	votes: VoteRecordVoteEntry[]
	voter: VoteRecordVoterEntry
}

export interface VoteRecordEnvelope {
	v: 1
	wrappedKey: WrappedSecret
	/** Standard base64, 12 bytes. */
	iv: string
	/** Standard base64, includes the 16-byte GCM tag. */
	ct: string
}

export const VOTE_RECORD_AAD_PREFIX = 'votetorrent-vote-record-v1:'

export function buildVoteRecordAad(electionId: string): Uint8Array {
	if (typeof electionId !== 'string' || electionId.length === 0) {
		throw new TypeError('vote record electionId must be a non-empty string')
	}
	return utf8ToBytes(VOTE_RECORD_AAD_PREFIX + electionId)
}

export type VoteRecordUnavailableReason =
	| 'canceled'
	| 'biometric-unavailable'
	| 'key-invalidated'
	| 'no-wrap-key'
	| 'policy-mismatch'
	| 'tag-mismatch'
	| 'malformed'
	| 'native-error'

export class VoteRecordUnavailableError extends Error {
	readonly reason: VoteRecordUnavailableReason

	constructor(reason: VoteRecordUnavailableReason) {
		super(`vote record unavailable (${reason})`)
		this.name = 'VoteRecordUnavailableError'
		this.reason = reason
	}
}

const REASON_BY_WRAP_CODE: Record<SecretWrapErrorCode, VoteRecordUnavailableReason> = {
	CANCELED: 'canceled',
	NO_BIOMETRICS_ENROLLED: 'biometric-unavailable',
	LOCKOUT: 'biometric-unavailable',
	LOCKOUT_PERMANENT: 'biometric-unavailable',
	BIOMETRIC_ERROR: 'biometric-unavailable',
	DEVICE_LOCKED: 'biometric-unavailable',
	NO_ACTIVITY: 'biometric-unavailable',
	KEY_INVALIDATED: 'key-invalidated',
	NO_WRAP_KEY: 'no-wrap-key',
	// The 63-17 alias-policy hazard, surfaced honestly.
	WRAP_KEY_POLICY_MISMATCH: 'policy-mismatch',
	UNWRAP_TAG_MISMATCH: 'tag-mismatch',
	INVALID_ARGUMENT: 'malformed',
	INVALID_ENCODING: 'malformed',
	MALFORMED_NATIVE_RESULT: 'malformed',
	WRAP_FAILED: 'native-error',
	UNWRAP_FAILED: 'native-error',
	NATIVE_UNAVAILABLE: 'native-error',
}

const KNOWN_CODES: ReadonlySet<string> = new Set(SECRET_WRAP_ERROR_CODES)

/** Never copies `err.message`: native error text must not reach the UI or logs. */
function toUnavailable(err: unknown): VoteRecordUnavailableError {
	if (err instanceof VoteRecordUnavailableError) return err
	if (err instanceof SecretWrapError && KNOWN_CODES.has(err.code)) {
		return new VoteRecordUnavailableError(REASON_BY_WRAP_CODE[err.code])
	}
	return new VoteRecordUnavailableError('native-error')
}

const NONCE_PATTERN = /^[0-9a-f]{64}$/

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null
}
function isStr(v: unknown): v is string {
	return typeof v === 'string'
}
function isStrOrNull(v: unknown): boolean {
	return v === null || typeof v === 'string'
}

export function isVoteRecord(value: unknown): value is VoteRecord {
	try {
		if (!isObj(value) || value.v !== 1) return false
		const { electionId, electionRevision } = value
		if (!isStr(electionId) || electionId.length === 0) return false
		if (typeof electionRevision !== 'number' || !Number.isInteger(electionRevision) || electionRevision < 0) return false
		if (!isStr(value.savedAt)) return false
		const votes = value.votes
		if (!Array.isArray(votes) || votes.length === 0) return false
		for (const e of votes as unknown[]) {
			if (!isObj(e) || e.v !== 1) return false
			if (e.electionId !== electionId || e.electionRevision !== electionRevision) return false
			if (!isStr(e.ballotId) || !isStr(e.templateDigest)) return false
			if (!Array.isArray(e.answers)) return false
			for (const a of e.answers as unknown[]) {
				if (!isObj(a) || !isStr(a.questionCode) || !Array.isArray(a.optionCodes)) return false
				if (!(a.optionCodes as unknown[]).every(isStr)) return false
			}
			if (!isStr(e.nonce) || !NONCE_PATTERN.test(e.nonce)) return false
		}
		const voter = value.voter
		if (!isObj(voter) || voter.v !== 1) return false
		if (voter.electionId !== electionId || voter.electionRevision !== electionRevision) return false
		if (!isStr(voter.registrantId) || !isStr(voter.privateCid) || !isStr(voter.deviceKey) || !isStr(voter.signature)) return false
		if (!isStrOrNull(voter.publicCid) || !isStrOrNull(voter.attestationCid)) return false
		if (!Array.isArray(voter.ballots)) return false
		for (const b of voter.ballots as unknown[]) {
			if (!isObj(b) || !isStr(b.ballotId) || !isStr(b.templateDigest)) return false
		}
		return true
	} catch {
		return false
	}
}

export function isVoteRecordEnvelope(value: unknown): value is VoteRecordEnvelope {
	try {
		if (!isObj(value) || value.v !== 1) return false
		if (!isStr(value.iv) || !isStr(value.ct)) return false
		const w = value.wrappedKey
		if (!isObj(w) || w.v !== 1 || w.alg !== 'AES-256-GCM') return false
		return isStr(w.keyAlias) && isStr(w.ivBase64) && isStr(w.ciphertextBase64) && isStr(w.securityLevel)
	} catch {
		return false
	}
}

function guardPrompt(prompt: SecretWrapPrompt): void {
	const ok =
		isObj(prompt) &&
		isStr(prompt.title) &&
		prompt.title.length > 0 &&
		isStr(prompt.subtitle) &&
		prompt.subtitle.length > 0 &&
		isStr(prompt.negativeButton) &&
		prompt.negativeButton.length > 0
	if (!ok) throw new TypeError('vote record prompt copy must be non-empty')
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
	return diff === 0
}

export async function sealVoteRecord(record: VoteRecord, options: { prompt: SecretWrapPrompt }): Promise<VoteRecordEnvelope> {
	guardPrompt(options.prompt)
	if (!isVoteRecord(record)) throw new VoteRecordUnavailableError('malformed')
	const aad = buildVoteRecordAad(record.electionId)
	const plain = utf8ToBytes(JSON.stringify(record))
	const dataKey = randomBytes(32)
	try {
		const iv = randomBytes(12)
		const ct = gcm(dataKey, iv, aad).encrypt(plain)
		// Self-check without any prompt: the sealed bytes must open under the same key.
		let roundTrip: Uint8Array
		try {
			roundTrip = gcm(dataKey, iv, aad).decrypt(ct)
		} catch {
			throw new VoteRecordUnavailableError('native-error')
		}
		const matches = equalBytes(roundTrip, plain)
		roundTrip.fill(0)
		if (!matches) throw new VoteRecordUnavailableError('native-error')
		let wrappedKey: WrappedSecret
		try {
			wrappedKey = await resolveVoteRecordWrapProvider().wrap(dataKey, aad, options.prompt)
		} catch (err) {
			throw toUnavailable(err)
		}
		return { v: 1, wrappedKey, iv: base64FromBytes(iv), ct: base64FromBytes(ct) }
	} finally {
		dataKey.fill(0)
		plain.fill(0)
	}
}

export async function openVoteRecord(
	electionId: string,
	envelope: VoteRecordEnvelope,
	options: { prompt: SecretWrapPrompt },
): Promise<VoteRecord> {
	guardPrompt(options.prompt)
	const aad = buildVoteRecordAad(electionId)
	if (!isVoteRecordEnvelope(envelope)) throw new VoteRecordUnavailableError('malformed')
	if (envelope.wrappedKey.keyAlias !== VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1) throw new VoteRecordUnavailableError('malformed')
	let ivBytes: Uint8Array
	let ctBytes: Uint8Array
	try {
		ivBytes = bytesFromBase64(envelope.iv)
		ctBytes = bytesFromBase64(envelope.ct)
	} catch {
		throw new VoteRecordUnavailableError('malformed')
	}
	if (ivBytes.length !== 12 || ctBytes.length < 17) throw new VoteRecordUnavailableError('malformed')

	let dataKey: Uint8Array
	try {
		dataKey = await resolveVoteRecordWrapProvider().unwrap(envelope.wrappedKey, aad, options.prompt)
	} catch (err) {
		throw toUnavailable(err)
	}
	let plain: Uint8Array | undefined
	try {
		if (dataKey.length !== 32) throw new VoteRecordUnavailableError('malformed')
		try {
			plain = gcm(dataKey, ivBytes, aad).decrypt(ctBytes)
		} catch {
			throw new VoteRecordUnavailableError('tag-mismatch')
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(new FatalTextDecoder('utf-8', { fatal: true }).decode(plain))
		} catch {
			throw new VoteRecordUnavailableError('malformed')
		}
		if (!isVoteRecord(parsed) || parsed.electionId !== electionId) throw new VoteRecordUnavailableError('malformed')
		return parsed
	} finally {
		dataKey.fill(0)
		if (plain) plain.fill(0)
	}
}
