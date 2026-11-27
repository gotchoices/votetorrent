// make-dkg-kat-vector.ts - host-only generator, verifier and mutation controls for dkg-kat-vector.json.
//
// Run from packages/vote-engine with the ts-node runner:
//   FORCE_COLOR=0 TS_NODE_PROJECT=./tsconfig.test.json node --import ./register-ts-node.mjs \
//     --experimental-specifier-resolution=node <abs path of this file> <mode> <vector path>
//
// Modes:
//   --write <path> [--force]   generate one vector from a live 2-of-2 DKG, cross-check it, self-replay it, and
//                              write it (refuses to overwrite without --force)
//   --verify <path>            replay the vector and run one live DKG; prints a RESULT line
//   --controls <path>          three in-memory mutations that the replay must detect; prints KAT-CONTROLS
//
// It prints only the lines named above. It never prints a secret, a share or a key.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
	DKG_KAT_PROBE_VERSION,
	KAT_CHECK_NAMES,
	closedJson,
	computeKatCheck,
	flipLastNibble,
	bytesToHex,
	replayDkgKat,
	runLiveDkg,
} from './dkg-kat-probe.js'
import {
	dkgIdentifierForUser,
	dkgRound1,
	commitRound1,
	dkgRound2,
	dkgRound3,
	serializeDkgSecret,
	generateDkgReceivingKey,
	encryptShare,
	reconstructGroupSecret,
} from '../../packages/vote-engine/dist/crypto/dkg.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const SAFETY = 'Throwaway 2-of-2 DKG transcript for the Hermes known-answer test (PD-14). Its keys were drawn at random for ' +
	'the reserved election id vt64-kat-election, protect nothing, and are never used by any network, strand or ElectionKey row.'

function sha256File (p: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function nobleVersion (pkg: string): string {
	const p = path.join(REPO, 'packages', 'vote-engine', 'node_modules', '@noble', pkg, 'package.json')
	return JSON.parse(fs.readFileSync(p, 'utf8')).version
}

function buildInputs (params: any): any {
	const ids = [dkgIdentifierForUser(params.users[0]), dkgIdentifierForUser(params.users[1])]
	const a = dkgRound1(ids[0], params.threshold, params.participants)
	const b = dkgRound1(ids[1], params.threshold, params.participants)
	const secretsStep1 = [serializeDkgSecret(a.secret), serializeDkgSecret(b.secret)]
	const commits = [commitRound1(params.ctx, a.public), commitRound1(params.ctx, b.public)]
	const ka = generateDkgReceivingKey()
	const kb = generateDkgReceivingKey()
	const outA = dkgRound2(a.secret, [b.public])
	const outB = dkgRound2(b.secret, [a.public])
	const secretsStep2 = [serializeDkgSecret(a.secret), serializeDkgSecret(b.secret)]
	const shareAB = outA[ids[1]]
	const shareBA = outB[ids[0]]
	if (shareAB === undefined || shareBA === undefined) throw new Error('round2-keying')
	const encAB = encryptShare(params.ctx, ids[0], ids[1], kb.publicKey, shareAB)
	const encBA = encryptShare(params.ctx, ids[1], ids[0], ka.publicKey, shareBA)
	const kmA = dkgRound3(a.secret, [b.public], [{ dealer: ids[1], share: shareBA }])
	const kmB = dkgRound3(b.secret, [a.public], [{ dealer: ids[0], share: shareAB }])
	const rec = reconstructGroupSecret({
		threshold: params.threshold,
		participants: params.participants,
		groupPublicKey: kmA.groupPublicKey,
		groupCommitments: kmA.groupCommitments,
		shares: [
			{ identifier: ids[0], signingShare: bytesToHex(kmA.signingShare) },
			{ identifier: ids[1], signingShare: bytesToHex(kmB.signingShare) },
		],
	})
	const live = {
		recHex: bytesToHex(rec.secretKey),
		signingShareA: bytesToHex(kmA.signingShare),
		groupCommitmentsA: kmA.groupCommitments,
		aToB: bytesToHex(shareAB),
		bToA: bytesToHex(shareBA),
		groupKeyB: kmB.groupPublicKey,
	}
	const inputs = {
		identifiers: ids,
		secretsStep1,
		secretsStep2,
		round1: [a.public, b.public],
		commits,
		receivingKeys: [
			{ privateKey: bytesToHex(ka.privateKey), publicKey: ka.publicKey },
			{ privateKey: bytesToHex(kb.privateKey), publicKey: kb.publicKey },
		],
		round2: { aToB: live.aToB, bToA: live.bToA },
		encryptedShares: { aToB: encAB, bToA: encBA },
		round3: {
			a: { signingShare: bytesToHex(kmA.signingShare), groupPublicKey: kmA.groupPublicKey, groupCommitments: kmA.groupCommitments },
			b: { signingShare: bytesToHex(kmB.signingShare), groupPublicKey: kmB.groupPublicKey, groupCommitments: kmB.groupCommitments },
		},
	}
	return { inputs, live }
}

function crossCheck (outs: string[], inputs: any, live: any): string | null {
	const n = (i: number): string => KAT_CHECK_NAMES[i]
	const eq = (i: number, expected: string): string | null => (outs[i] === expected ? null : n(i))
	const checks: Array<string | null> = [
		eq(2, inputs.commits[0]),
		eq(3, inputs.commits[1]),
		eq(10, live.aToB),
		eq(11, live.bToA),
		eq(15, live.aToB),
		eq(16, live.bToA),
		eq(19, JSON.stringify(live.groupCommitmentsA)),
		eq(23, JSON.stringify([live.recHex, [inputs.identifiers[0], inputs.identifiers[1]].sort(), []])),
		eq(24, inputs.secretsStep1[0]),
		eq(25, inputs.secretsStep1[1]),
		eq(26, inputs.secretsStep2[0]),
		eq(27, inputs.secretsStep2[1]),
		inputs.round3.a.groupPublicKey === inputs.round3.b.groupPublicKey ? null : n(17),
		JSON.parse(outs[17])[0] === live.signingShareA ? null : n(17),
		JSON.parse(outs[17])[1] === JSON.parse(outs[18])[1] ? null : n(18),
	]
	const trues = [4, 5, 7, 8, 12, 13, 20, 21]
	const falses = [6, 9, 14, 22]
	for (const i of trues) checks.push(eq(i, 'true'))
	for (const i of falses) checks.push(eq(i, 'false'))
	const bad = checks.find(c => c !== null)
	return bad === undefined ? null : bad
}

function computeAll (params: any, inputs: any): string[] {
	const outs: string[] = []
	for (let i = 0; i < KAT_CHECK_NAMES.length; i++) outs.push(computeKatCheck(i, params, inputs))
	return outs
}

async function verifyVector (vector: any): Promise<{ line: string, pass: boolean }> {
	const t0 = Date.now()
	const kat = await replayDkgKat(vector)
	const live = await runLiveDkg(vector, 1)
	const pass = kat.mismatches === 0 && live.livePass !== false
	const line = closedJson({
		v: 1,
		probe: DKG_KAT_PROBE_VERSION,
		state: 'done',
		pass,
		rounds: kat.rounds,
		checks: kat.checks,
		mismatches: kat.mismatches,
		mismatchIndex: kat.mismatchIndex,
		mismatchName: kat.mismatchName,
		katMs: kat.katMs,
		liveRuns: live.liveRuns,
		livePass: live.livePass,
		liveMs: live.liveMs,
		ms: Date.now() - t0,
		vectorId: vector.vectorId,
		ignoredStarts: 0,
	})
	return { line, pass }
}

async function modeWrite (outPath: string, force: boolean): Promise<number> {
	if (!force && fs.existsSync(outPath)) {
		console.error('KAT-VECTOR REFUSED exists')
		return 2
	}
	const params = {
		threshold: 2,
		participants: 2,
		ctx: { electionId: 'vt64-kat-election', revision: 1, attempt: 1 },
		users: ['vt64-kat-keyholder-a', 'vt64-kat-keyholder-b'],
	}
	const { inputs, live } = buildInputs(params)
	const outs = computeAll(params, inputs)
	const bad = crossCheck(outs, inputs, live)
	if (bad !== null) {
		console.log('KAT-VECTOR FAIL ' + bad)
		return 1
	}
	const tmp = { v: 1, kind: 'vt64-dkg-kat', vectorId: '0000000000000000', params, inputs, checks: KAT_CHECK_NAMES.map((name, i) => ({ name, expect: outs[i] })) }
	const timing = { kat: (await replayDkgKat(tmp)).katMs, live: (await runLiveDkg(tmp, 1)).liveMs }
	const distPath = path.join(REPO, 'packages', 'vote-engine', 'dist', 'crypto', 'dkg.js')
	const srcPath = path.join(REPO, 'packages', 'vote-engine', 'src', 'crypto', 'dkg.ts')
	const vector = {
		v: 1,
		kind: 'vt64-dkg-kat',
		vectorId: crypto.randomBytes(8).toString('hex'),
		safety: SAFETY,
		provenance: {
			generator: 'scripts/proof/make-dkg-kat-vector.ts',
			generatedAt: new Date().toISOString(),
			node: process.version,
			outerCommit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).toString().trim(),
			noble: { curves: nobleVersion('curves'), hashes: nobleVersion('hashes'), ciphers: nobleVersion('ciphers') },
			distDkgSha256: sha256File(distPath),
			srcDkgSha256: sha256File(srcPath),
			nodeTimingMs: timing,
		},
		params,
		inputs,
		checks: tmp.checks,
	}
	const first = await verifyVector(vector)
	if (!first.pass) {
		console.log('KAT-VECTOR FAIL self-replay')
		return 1
	}
	fs.writeFileSync(outPath, JSON.stringify(vector, null, 2) + '\n', { flag: force ? 'w' : 'wx' })
	const again = await verifyVector(JSON.parse(fs.readFileSync(outPath, 'utf8')))
	if (!again.pass) {
		console.log('KAT-VECTOR FAIL reread')
		return 1
	}
	console.log('KAT-VECTOR ' + JSON.stringify({ vectorId: vector.vectorId, checks: 28, selfReplay: 'pass' }))
	return 0
}

async function modeVerify (p: string): Promise<number> {
	const r = await verifyVector(JSON.parse(fs.readFileSync(p, 'utf8')))
	console.log('RESULT ' + r.line)
	return r.pass ? 0 : 1
}

function summary (r: any): any {
	return { pass: r.mismatches === 0, mismatches: r.mismatches, mismatchIndex: r.mismatchIndex, mismatchName: r.mismatchName }
}

async function modeControls (p: string): Promise<number> {
	const base = JSON.parse(fs.readFileSync(p, 'utf8'))
	const ctlA = JSON.parse(JSON.stringify(base))
	ctlA.checks[10].expect = flipLastNibble(ctlA.checks[10].expect)
	const ctlB = JSON.parse(JSON.stringify(base))
	ctlB.inputs.round1[1].commitment[0] = flipLastNibble(ctlB.inputs.round1[1].commitment[0])
	const ctlC = JSON.parse(JSON.stringify(base))
	ctlC.checks[3].name = ctlC.checks[3].name + '-renamed'
	const a = summary(await replayDkgKat(ctlA))
	const b = summary(await replayDkgKat(ctlB))
	const c = summary(await replayDkgKat(ctlC))
	const detectedA = a.mismatchIndex === 10 && a.mismatches === 1 && a.mismatchName === 'round2:a-to-b'
	const detectedB = b.mismatches >= 1
	const detectedC = c.mismatchIndex === 3
	const detected = (detectedA ? 1 : 0) + (detectedB ? 1 : 0) + (detectedC ? 1 : 0)
	console.log('KAT-CONTROLS ' + JSON.stringify({ a, b, c, detected }))
	return detected === 3 ? 0 : 1
}

async function main (): Promise<number> {
	const args = process.argv.slice(2)
	const mode = args[0]
	const target = args[1]
	if (target === undefined || !path.isAbsolute(target)) {
		console.error('usage: --write <abs path> [--force] | --verify <abs path> | --controls <abs path>')
		return 5
	}
	if (mode === '--write') return await modeWrite(target, args.includes('--force'))
	if (mode === '--verify') return await modeVerify(target)
	if (mode === '--controls') return await modeControls(target)
	console.error('usage: --write <abs path> [--force] | --verify <abs path> | --controls <abs path>')
	return 5
}

main().then(code => { process.exit(code) }, () => {
	console.error('KAT-VECTOR ERROR')
	process.exit(4)
})
