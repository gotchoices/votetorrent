/**
 * vote-record-move.parity.test.ts (phase 67 plan 30).
 *
 * The Voter's vote record store, record vault, receipt reveal and sent-ballot store now live in
 * `@votetorrent/workflows/voter` as factories over injected ports, and the app paths are bindings. This
 * file is where both sides are in scope, so it pins, at compile time, the shared `SecretWrapErrorCode`
 * EXACTLY equal to the native type and the factories' results assignable to the ports the shared casting
 * and sending consume; any drift fails `yarn typecheck` on this file. The runtime cases pin the stored key
 * constants (through the bindings), the reason map's key set against the native code list, and the error
 * classes' identity across the binding and the shared module.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SECRET_WRAP_ERROR_CODES, type SecretWrapErrorCode as NativeSecretWrapErrorCode } from '@votetorrent/attestation-native'
import type { SecretWrapErrorCode as SharedSecretWrapErrorCode } from '@votetorrent/workflows/platform'
import {
	createVoteRecordStore,
	createVoteRecordVault,
	createVoteSentStore,
	VOTE_RECORD_REASON_BY_WRAP_CODE,
	VoteRecordUnavailableError as SharedVoteRecordUnavailableError,
	VoteStoreWriteError as SharedVoteStoreWriteError,
	type RegistrationStatusResult as SharedRegistrationStatusResult,
	type VoteRecordStorePort,
	type VoteRecordVaultPort,
	type VoterRequestTransportLookup,
	type VoteSentStore,
} from '@votetorrent/workflows/voter'
import type { RegistrationStatusResult as AppRegistrationStatusResult } from '../registration-status'
import type { resolveVoterRequestTransports, VoterRequestTransportDeps } from '../../screens/registration/attach-voter-request-transport'
import { VOTE_MARKER_KEY_PREFIX, VOTE_RECORD_KEY_PREFIX, VoteStoreWriteError } from '../vote-record-store'
import { VOTE_RECORD_AAD_PREFIX, VoteRecordUnavailableError } from '../vote-record-vault'
import { VOTE_SENT_KEY_PREFIX } from '../vote-sent-store'

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

const secretWrapErrorCodeParity: Equal<SharedSecretWrapErrorCode, NativeSecretWrapErrorCode> = true
const appKvIsStoreKv: Assignable<typeof AsyncStorage, Parameters<typeof createVoteRecordStore>[0]> = true
const storeIsStorePort: Assignable<ReturnType<typeof createVoteRecordStore>, VoteRecordStorePort> = true
const vaultIsVaultPort: Assignable<ReturnType<typeof createVoteRecordVault>, VoteRecordVaultPort> = true
const sentStoreIsSentStore: Assignable<ReturnType<typeof createVoteSentStore>, VoteSentStore> = true
const appLookupIsLookup: Assignable<typeof resolveVoterRequestTransports, VoterRequestTransportLookup> = true
const appTransportDepsIsLookupParam: Assignable<VoterRequestTransportDeps, Parameters<VoterRequestTransportLookup>[0]> = true
const registrationStatusResultParity: Equal<SharedRegistrationStatusResult, AppRegistrationStatusResult> = true

const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '')
const count = (text: string, token: string): number => text.split(token).length - 1

describe('vote record move parity (Voter)', () => {
	it('K1 the four stored key constants equal their literals through the bindings', () => {
		expect(VOTE_MARKER_KEY_PREFIX).toBe('votetorrent.vote' + 'Marker.')
		expect(VOTE_RECORD_KEY_PREFIX).toBe('votetorrent.vote' + 'Record.')
		expect(VOTE_SENT_KEY_PREFIX).toBe('votetorrent.vote' + 'Sent.')
		expect(VOTE_RECORD_AAD_PREFIX).toBe('votetorrent-vote-record-v1:')
	})

	it('K2 the shared reason map covers exactly the native code list', () => {
		expect(Object.keys(VOTE_RECORD_REASON_BY_WRAP_CODE).sort()).toEqual([...SECRET_WRAP_ERROR_CODES].sort())
	})

	it('K3 the binding error classes are the shared classes', () => {
		expect(VoteStoreWriteError).toBe(SharedVoteStoreWriteError)
		expect(VoteRecordUnavailableError).toBe(SharedVoteRecordUnavailableError)
	})

	it('P1 the error-code type and the port assignabilities are pinned (compile-time)', () => {
		expect([secretWrapErrorCodeParity, appKvIsStoreKv, storeIsStorePort, vaultIsVaultPort, sentStoreIsSentStore]).toEqual([true, true, true, true, true])
	})

	it('P2 the request-transport and registration-status seams are pinned (compile-time)', () => {
		expect([appLookupIsLookup, appTransportDepsIsLookupParam, registrationStatusResultParity]).toEqual([true, true, true])
	})

	it('P3 the binding routes the REST branch through the app loader only', () => {
		const binding = strip(readFileSync(resolve(__dirname, '..', 'voter-request-transports.ts'), 'utf8'))
		const shared = strip(readFileSync(resolve(__dirname, '../../../../../packages/workflows/src/voter/voter-request-transports.ts'), 'utf8'))
		expect(count(binding, 'require' + '(')).toBe(1)
		expect(count(shared, 'require' + '(')).toBe(0)
	})
})
