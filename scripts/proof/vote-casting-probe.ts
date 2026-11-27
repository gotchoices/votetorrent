// vote-casting-probe.ts - the in-app device probe for the Phase 63 vote-casting proof (D-30).
//
// It drives the SHIPPED castVote, receipt, vault and store code, not spike copies (63-RESEARCH
// Device proof). castVote is called with NO producer override, so the shipped
// resolveVoteSigningProducer path is the one under proof (D-08).
//
// Dormant unless launched by scripts/run-vote-casting-proof.sh with a VIEW intent
// `vcp://<mode>/<runId>`. Three modes, one per launch:
//   cast     launch 1: preflight, Submit, receipt windows, sweep, guard, tamper
//   restart  launch 2 (no pm clear): persist across a restart, guard, stale re-cast
//   cleared  launch 3 (after pm clear): the store is empty again
//
// In-app legs emitted as `[vcp] leg <name> PASS|FAIL <json>`: leg producer-real, leg fixture-real-key,
// leg sweep-js, leg guard (cast launch), leg tamper, leg persist, leg guard-restart, leg stale
// (restart launch) and leg clear (cleared launch). The host adds signature, prompts, sweep, not-sent.
//
// One string per log line (spike 099 run 3): `L` is the only logging call and it takes ONE
// string, because a multi-argument console log prints quoted fragments that no host pattern
// matches. Every JSON payload is stringified into that one string.
//
// Gate K1 (63-08) covers only src/, and this file is outside it. The probe reads the vote
// AsyncStorage keys ONLY to SWEEP them (the sweep and clear legs). It never writes, edits or
// deletes a vote key: vote state is written only by castVote through the store. Its single
// AsyncStorage write is its own state key, which holds ids and sha256 hashes, never a nonce,
// an answer or a signature.
//
// The nonces and the signature ARE written to logcat (an isolated dev emulator, proof only) so
// the host can sweep for them and verify the signature. The probe never persists them.
//
// This file is never part of a shipped bundle: it exists inside the app only between the
// script's staging and its restore trap. It is copied to apps/VoteTorrentVoter/__voteproof__/,
// so every relative import below is written for THAT location.

import React, { useEffect, useRef, useState } from 'react'
import { AppRegistry, Linking, Text } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { SecretWrapPrompt } from '@votetorrent/attestation-native'
import type { IAssociationEngine, IElectionsEngine, IRegistrationEngine } from '@votetorrent/vote-core'
import { canonicalJson, checkVotingKey, p256KeyToCompressedHex, voterEntryDigest } from '@votetorrent/vote-engine/rn'
import type { VoterEntryUnsigned } from '@votetorrent/vote-engine/rn'
import { name as appName } from '../app.json'
import '../src/i18n'
import { CadreNodeProvider } from '../src/providers/CadreNodeProvider'
import { VoterAppProvider, useVoterApp } from '../src/providers/VoterAppProvider'
import { readVoteContext, toVoterBallot } from '../src/engines/election-read'
import type { ElectionReadDeps, VoteContext } from '../src/engines/election-read'
import { castVote, evaluateVoteEligibility } from '../src/engines/vote-casting'
import type { CastVoteDeps, CastVoteResult } from '../src/engines/vote-casting'
import { loadVoteReceipt, revealVoteReceipt } from '../src/engines/vote-receipt'
import { openVoteRecord, VoteRecordUnavailableError } from '../src/engines/vote-record-vault'
import type { VoteRecord, VoteRecordEnvelope } from '../src/engines/vote-record-vault'
import { guard, readSavedVote, readVoteMarker, VOTE_MARKER_KEY_PREFIX, VOTE_RECORD_KEY_PREFIX } from '../src/engines/vote-record-store'
import * as voteRecordWrap from '../src/engines/vote-record-wrap'
import { resolveAttestationProducer, resolveVoteSigningProducer, StubAttestationProducer } from '../src/engines/attestation-producer'
import { VOTE_PROOF_BUNDLE_NEEDLE, VOTE_PROOF_RUN_ID } from './vote-casting-probe.run'

// One string per line. This is the ONLY logging call in the file.
function L (line: string): void {
	console.log('[vcp] ' + line)
}

const STUB_PREFIX = 'STUB_'
const MARKER_NAMES = ['ballotIds', 'electionId', 'electionRevision', 'savedAt', 'status', 'v']
const STATE_KEY = 'votetorrent.voteProof.' + VOTE_PROOF_RUN_ID

const signPrompt: SecretWrapPrompt = { title: 'Vote proof sign', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const savePrompt: SecretWrapPrompt = { title: 'Vote proof save', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const viewNow: SecretWrapPrompt = { title: 'Vote proof view now', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const viewLater: SecretWrapPrompt = { title: 'Vote proof view later', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const reopenPrompt: SecretWrapPrompt = { title: 'Vote proof reopen', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const tamperCt: SecretWrapPrompt = { title: 'Vote proof tamper ct', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const tamperAad: SecretWrapPrompt = { title: 'Vote proof tamper aad', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }
const staleView: SecretWrapPrompt = { title: 'Vote proof stale view', subtitle: 'vote-casting proof', negativeButton: 'Cancel' }

type Mode = 'cast' | 'restart' | 'cleared'

interface ProbeState {
	electionId: string
	revision: number
	recordSha: string
	envelopeSha: string
}

let currentStep = 'boot'
let setStepText: ((text: string) => void) | undefined
let started = false

function step (name: string): void {
	currentStep = name
	if (setStepText !== undefined) setStepText(name)
}

function sleep (ms: number): Promise<void> {
	return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

function sha (text: string): string {
	return bytesToHex(sha256(utf8ToBytes(text)))
}

function fatal (where: string, err: unknown): void {
	const e = err as { name?: unknown, code?: unknown, message?: unknown } | null
	const detail = {
		errorClass: typeof e?.name === 'string' ? e.name : typeof err,
		code: typeof e?.code === 'string' ? e.code : null,
		message: typeof e?.message === 'string' ? e.message.slice(0, 200) : '',
	}
	L('FATAL ' + where + ' ' + JSON.stringify(detail))
}

async function windowed<T> (name: string, body: () => Promise<T>, detail?: (r: T) => unknown): Promise<T> {
	L('window-begin ' + name)
	let result: T
	try {
		result = await body()
	} catch (err) {
		L('window-end ' + name + ' ' + JSON.stringify({ threw: true }))
		throw err
	}
	L('window-end ' + name + ' ' + JSON.stringify(detail === undefined ? {} : detail(result)))
	return result
}

function leg (name: string, pass: boolean, detail: unknown): void {
	L('leg ' + name + ' ' + (pass ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(detail))
}

const b64Globals = globalThis as unknown as { atob: (s: string) => string, btoa: (s: string) => string }

function bytesFromB64 (value: string): Uint8Array {
	const binary = b64Globals.atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

function b64FromBytes (bytes: Uint8Array): string {
	let s = ''
	for (const b of bytes) s += String.fromCharCode(b)
	return b64Globals.btoa(s)
}

/** Resolves to the rejection reason, or 'ACCEPTED' when the call unexpectedly succeeded. */
async function rejectionOf (body: () => Promise<unknown>): Promise<string> {
	try {
		await body()
		return 'ACCEPTED'
	} catch (err) {
		return err instanceof VoteRecordUnavailableError ? err.reason : 'other'
	}
}

function rawKeyForm (key: string): string {
	if (/^0[23][0-9a-f]{64}$/.test(key)) return 'compressed-hex'
	if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length === 124) return 'spki-base64'
	return 'other'
}

interface ProbeEnv {
	getEngine: CastVoteDeps['getEngine']
	seededElectionId: string
	setClockOffsetMs: (ms: number) => void
}

async function openingClock (env: ProbeEnv): Promise<{ nowAt: () => number }> {
	const elections = await env.getEngine<IElectionsEngine>('elections')
	const details = await (await elections.openElection(env.seededElectionId)).getElectionDetails()
	const votingStarts = Number(details.current.timeline.votingStarts)
	const openAt = votingStarts + 60_000
	const offset = openAt - Date.now()
	env.setClockOffsetMs(offset)
	return { nowAt: () => Date.now() + offset }
}

async function runProbe (env: ProbeEnv): Promise<void> {
	const url = await Linking.getInitialURL()
	const m = url == null ? null : /^vcp:\/\/(cast|restart|cleared)\/([0-9a-f]{16})$/.exec(url)
	if (m === null) {
		L('dormant')
		return
	}
	const mode = m[1] as Mode
	if (m[2] !== VOTE_PROOF_RUN_ID) {
		L('FATAL launch-bundle-mismatch ' + JSON.stringify({ launch: m[2], bundle: VOTE_PROOF_RUN_ID }))
		return
	}
	L('boot mode=' + mode + ' run=' + VOTE_PROOF_RUN_ID + ' needle=' + VOTE_PROOF_BUNDLE_NEEDLE + ' election=' + env.seededElectionId)

	const { nowAt } = await openingClock(env)
	const getEngine = env.getEngine
	const fallbackElectionId = env.seededElectionId
	const readDeps: ElectionReadDeps = { getEngine, fallbackElectionId }
	const ctx = await readVoteContext(readDeps, nowAt())
	const offices = toVoterBallot(ctx.electionId, ctx.ballots).offices
	const selectionMap: Record<string, string[]> = {}
	for (const office of offices) {
		if (office.required && office.candidates.length > 0) selectionMap[office.id] = [office.candidates[0]!.id]
	}
	L('context open=' + String(ctx.open) + ' revision=' + ctx.revision + ' ballots=' + ctx.ballots.length + ' unconfirmed=' + ctx.unconfirmedBallotIds.length + ' unsupported=' + ctx.unsupportedQuestionCount)
	if (!(ctx.open && ctx.unconfirmedBallotIds.length === 0)) {
		L('FATAL context-not-open ' + JSON.stringify({ open: ctx.open, lifecycleState: ctx.lifecycleState }))
		return
	}
	const electionId = ctx.electionId
	const revision = ctx.revision

	// No producer override is ever passed: the shipped resolveVoteSigningProducer path is proven.
	const baseDeps = (): CastVoteDeps => ({ getEngine, fallbackElectionId, nowMs: nowAt(), selectionMap, signPrompt, recordPrompt: savePrompt })
	const summarize = (r: CastVoteResult): Record<string, unknown> => {
		if (r.ok) return { ok: true, electionRevision: r.electionRevision, ballotCount: r.ballotIds.length, replacedStale: r.replacedStale }
		if (r.stage === 'ineligible') return { ok: false, stage: r.stage, reason: r.eligibility.reason }
		return { ok: false, stage: r.stage, reason: r.reason }
	}

	if (mode === 'cast') await runCast()
	else if (mode === 'restart') await runRestart()
	else await runCleared()

	async function runCast (): Promise<void> {
		step('preflight')
		let publicKey = ''
		await windowed('preflight', async () => {
			const stubOk = resolveVoteSigningProducer() !== StubAttestationProducer && resolveAttestationProducer() !== StubAttestationProducer
			const p = resolveVoteSigningProducer()
			publicKey = (await p.getCurrentDeviceKey()).publicKey
			L('raw-key form=' + rawKeyForm(publicKey) + ' len=' + publicKey.length)
			const rows = await (await getEngine<IAssociationEngine>('association')).getAssociationsByDeviceKey(publicKey)
			const registrant = rows.length > 0 ? await (await getEngine<IRegistrationEngine>('registration')).getRegistrant(rows[0]!.registrantId) : undefined
			const keyCheck = rows.length > 0 ? checkVotingKey(publicKey, rows[0]!.deviceKey) : { ok: false }
			const eligibility = await evaluateVoteEligibility(baseDeps())
			const eligible = eligibility.eligible
				&& eligibility.voter.compressedDeviceKey === p256KeyToCompressedHex(publicKey)
				&& eligibility.producer !== StubAttestationProducer
			const pass = stubOk && rows.length === 1 && registrant?.status === 'a' && keyCheck.ok === true && eligible
			leg('fixture-real-key', pass, { rows: rows.length, registrantStatus: registrant?.status ?? null, keyCheck: keyCheck.ok, eligible, notStub: stubOk })
		})

		L('snapshot pre-a')
		await sleep(12_000)
		L('snapshot pre-b')
		await sleep(8_000)

		step('submit')
		const result = await windowed('submit', () => castVote(baseDeps()), summarize)
		L('cast-result ' + JSON.stringify(summarize(result)))

		step('receipt-now')
		let load = await loadVoteReceipt(electionId, revision)
		let record: VoteRecord | undefined
		let envelope: VoteRecordEnvelope | undefined
		await windowed('receipt-now', async () => {
			load = await loadVoteReceipt(electionId, revision)
			if (load.kind !== 'saved') return
			envelope = load.envelope
			const reveal = await revealVoteReceipt(electionId, load.envelope, viewNow)
			L('receipt-now kind=' + reveal.kind)
			if (reveal.kind === 'ok') record = reveal.record
		})
		const receiptEndedAt = Date.now()
		if (record === undefined || envelope === undefined) {
			L('FATAL receipt-now-unreadable ' + JSON.stringify({ load: load.kind }))
			return
		}
		const { signature, ...unsigned } = record.voter
		const signed = JSON.stringify({ v: 1, digest: voterEntryDigest(unsigned as VoterEntryUnsigned), signature, deviceKey: record.voter.deviceKey, rawKey: publicKey, voter: unsigned })
		if (signed.length >= 3500) {
			L('FATAL signed-line-too-long ' + JSON.stringify({ length: signed.length }))
			return
		}
		const nonces = record.votes.map(v => v.nonce)
		L('signed ' + signed)
		L('needles ' + JSON.stringify({ nonces }))
		L('persist-save ' + JSON.stringify({ record: sha(canonicalJson(record)), envelope: sha(JSON.stringify(envelope)) }))
		const sigOk = /^[0-9a-f]{128}$/.test(signature) && !signature.includes(STUB_PREFIX) && result.ok
		leg('producer-real', sigOk, { signatureShape: /^[0-9a-f]{128}$/.test(signature), castOk: result.ok })

		L('snapshot post')
		await sleep(8_000)

		const configured = (voteRecordWrap as unknown as Record<string, unknown>).VOTE_RECORD_AUTH_WINDOW_SECONDS
		const seconds = typeof configured === 'number' ? configured : undefined
		L('auth-window seconds=' + (seconds === undefined ? 'absent' : String(seconds)))
		const lapseMs = (Math.max(seconds ?? 10, 10) + 10) * 1000
		await sleep(Math.max(0, lapseMs - (Date.now() - receiptEndedAt)))

		step('receipt-later')
		await windowed('receipt-later', async () => {
			const reveal = await revealVoteReceipt(electionId, envelope!, viewLater)
			L('receipt-later kind=' + reveal.kind)
			return reveal.kind
		})

		step('sweep')
		const keys = await AsyncStorage.getAllKeys()
		const pairs = await AsyncStorage.multiGet(keys)
		const voteKeys = keys.filter(k => k.startsWith(VOTE_MARKER_KEY_PREFIX) || k.startsWith(VOTE_RECORD_KEY_PREFIX))
		let hits = 0
		for (const [, value] of pairs) {
			if (value === null) continue
			if (nonces.some(n => value.includes(n)) || value.includes(signature)) hits++
		}
		const markerRead = await readVoteMarker(electionId)
		const markerShape = markerRead.kind === 'ok' && Object.keys(markerRead.marker).sort().join(',') === MARKER_NAMES.join(',')
		const markerClean = markerRead.kind === 'ok' && !nonces.some(n => JSON.stringify(markerRead.marker).includes(n))
		leg('sweep-js', voteKeys.length === 2 && hits === 0 && markerShape && markerClean, { keys: keys.length, voteKeys: voteKeys.length, hits, markerShape, markerClean })

		step('guard')
		await windowed('guard', async () => {
			const again = await castVote(baseDeps())
			const refused = !again.ok && again.stage === 'ineligible' && again.eligibility.reason === 'already-saved'
			const g = await guard(electionId, revision)
			const markerRevisionOk = markerRead.kind === 'ok' && markerRead.marker.electionRevision === revision
			leg('guard', refused && g === 'already-saved' && markerRevisionOk, { second: summarize(again), guard: g, markerRevisionOk })
		})

		step('tamper')
		const tamperedCt = bytesFromB64(envelope.ct)
		tamperedCt[0] = tamperedCt[0]! ^ 0x01
		const tamperedEnvelope: VoteRecordEnvelope = { ...envelope, ct: b64FromBytes(tamperedCt) }
		const ctReason = await windowed('tamper-ct', () => rejectionOf(() => openVoteRecord(electionId, tamperedEnvelope, { prompt: tamperCt })), r => ({ reason: r }))
		const aadReason = await windowed('tamper-aad', () => rejectionOf(() => openVoteRecord('vcp-other-' + electionId, envelope!, { prompt: tamperAad })), r => ({ reason: r }))
		leg('tamper', ctReason !== 'ACCEPTED' && ctReason !== 'other' && aadReason !== 'ACCEPTED' && aadReason !== 'other', { ctReason, aadReason })

		const state: ProbeState = { electionId, revision, recordSha: sha(canonicalJson(record)), envelopeSha: sha(JSON.stringify(envelope)) }
		await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state))
		L('phase1-done')
	}

	async function runRestart (): Promise<void> {
		const raw = await AsyncStorage.getItem(STATE_KEY)
		if (raw === null) {
			L('FATAL restart-without-phase1')
			return
		}
		const state = JSON.parse(raw) as ProbeState

		step('persist')
		const read = await readSavedVote(state.electionId, state.revision)
		const envelopeSha = read.envelope === null ? '' : sha(JSON.stringify(read.envelope))
		let recordSha = ''
		await windowed('persist-open', async () => {
			if (read.envelope === null) return
			const reveal = await revealVoteReceipt(state.electionId, read.envelope, reopenPrompt)
			L('persist-open kind=' + reveal.kind)
			if (reveal.kind === 'ok') recordSha = sha(canonicalJson(reveal.record))
		})
		leg('persist', read.state === 'saved' && read.envelopeState === 'ok' && envelopeSha === state.envelopeSha && recordSha === state.recordSha, { state: read.state, envelopeState: read.envelopeState, envelopeMatch: envelopeSha === state.envelopeSha, recordMatch: recordSha === state.recordSha })

		step('guard-restart')
		await windowed('guard-restart', async () => {
			const again = await castVote(baseDeps())
			const refused = !again.ok && again.stage === 'ineligible' && again.eligibility.reason === 'already-saved'
			leg('guard-restart', refused, summarize(again))
		})

		step('stale')
		const staleRead = async (deps: ElectionReadDeps, nowMs: number): Promise<VoteContext> => {
			const c = await readVoteContext(deps, nowMs)
			return { ...c, revision: c.revision + 1 }
		}
		const staleGuard = await guard(state.electionId, state.revision + 1)
		const staleEligibility = await evaluateVoteEligibility({ ...baseDeps(), readContext: staleRead })
		const reEnabled = staleEligibility.eligible && staleEligibility.replacesStale === true
		const staleResult = await windowed('stale-submit', () => castVote({ ...baseDeps(), readContext: staleRead }), summarize)
		const newRead = await readSavedVote(state.electionId, state.revision + 1)
		const oldRead = await readSavedVote(state.electionId, state.revision)
		let revisionOk = false
		let freshNonces: string[] = []
		await windowed('stale-open', async () => {
			const loaded = await loadVoteReceipt(state.electionId, state.revision + 1)
			if (loaded.kind !== 'saved') return
			const reveal = await revealVoteReceipt(state.electionId, loaded.envelope, staleView)
			L('stale-open kind=' + reveal.kind)
			if (reveal.kind !== 'ok') return
			revisionOk = reveal.record.electionRevision === state.revision + 1 && reveal.record.votes.every(v => v.electionRevision === state.revision + 1)
			freshNonces = reveal.record.votes.map(v => v.nonce)
		})
		L('needles ' + JSON.stringify({ nonces: freshNonces }))
		leg('stale', staleGuard === 'stale' && reEnabled && staleResult.ok && staleResult.replacedStale === true && newRead.state === 'saved' && oldRead.state === 'stale' && revisionOk, {
			'stale-mode': 'injected-readContext',
			guard: staleGuard,
			reEnabled,
			cast: summarize(staleResult),
			newState: newRead.state,
			oldState: oldRead.state,
			revisionOk,
		})
		L('phase2-done')
	}

	async function runCleared (): Promise<void> {
		step('cleared')
		await windowed('cleared', async () => {
			const keys = await AsyncStorage.getAllKeys()
			const voteKeys = keys.filter(k => k.startsWith(VOTE_MARKER_KEY_PREFIX) || k.startsWith(VOTE_RECORD_KEY_PREFIX)).length
			const marker = await readVoteMarker(electionId)
			const g = await guard(electionId, revision)
			leg('clear', voteKeys === 0 && marker.kind === 'absent' && g === 'ok', { voteKeys, marker: marker.kind, guard: g })
		})
		L('phase3-done')
	}
}

function VoteProofDriver (): React.ReactElement {
	const app = useVoterApp()
	const [text, setText] = useState('boot')
	const ran = useRef(false)
	setStepText = setText
	useEffect(() => {
		if (ran.current) return
		if (!(app.isInitialized && app.hasNetwork && app.seededElectionId !== undefined)) return
		ran.current = true
		started = true
		const seeded = app.seededElectionId
		const env: ProbeEnv = { getEngine: app.getEngine, seededElectionId: seeded, setClockOffsetMs: app.setClockOffsetMs }
		setTimeout(() => {
			runProbe(env).catch(err => fatal(currentStep, err))
		}, 0)
	}, [app.isInitialized, app.hasNetwork, app.seededElectionId, app.getEngine, app.setClockOffsetMs])
	return React.createElement(Text, null, 'vote proof: ' + text)
}

function VoteProofRoot (): React.ReactElement {
	useEffect(() => {
		const timer = setTimeout(() => {
			if (!started) L('FATAL app-not-ready ' + JSON.stringify({ step: currentStep }))
		}, 300_000)
		return () => clearTimeout(timer)
	}, [])
	return React.createElement(
		SafeAreaProvider,
		null,
		React.createElement(CadreNodeProvider, null, React.createElement(VoterAppProvider, null, React.createElement(VoteProofDriver))),
	)
}

AppRegistry.registerComponent(appName, () => VoteProofRoot)
