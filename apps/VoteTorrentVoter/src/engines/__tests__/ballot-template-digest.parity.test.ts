/**
 * ballot-template-digest.parity.test.ts - A8 (63-RESEARCH Assumptions): is the D-24 template digest
 * the same for a ballot's proposed read and its confirmed read? There is no Ballot CID column, so
 * the D-24 field order is a contract the future vote schema must reproduce. Submit hashes only the
 * confirmed read, so this phase is unaffected either way; a mismatch would be a contract finding,
 * not a fix.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Ballot } from '@votetorrent/vote-core'
import { ElectionsEngine, LocalStorageReact, NetworksEngine, ballotTemplateDigest } from '@votetorrent/vote-engine/rn'
import { seedDevNetwork, confirmDevBallot, DEV_SEED_BALLOT_QUESTIONS } from '../dev-seed'
import { readVoteContext } from '../election-read'
import { setDeviceKeyWrapProviderForTests } from '../device-key-wrap'
import { createInMemoryKeyWrapProviderForTests } from '../__fixtures__/in-memory-key-wrap-provider'

const keyWrap = createInMemoryKeyWrapProviderForTests()

beforeEach(async () => {
	await AsyncStorage.clear()
	setDeviceKeyWrapProviderForTests(keyWrap)
})
afterAll(() => setDeviceKeyWrapProviderForTests(undefined))

function templateDiff (a: Ballot, b: Ballot): string[] {
	const out: string[] = []
	for (const f of ['id', 'electionId', 'authorityId', 'description'] as const) {
		if (a[f] !== b[f]) out.push(f)
	}
	if (JSON.stringify([...(a.districts ?? [])].sort()) !== JSON.stringify([...(b.districts ?? [])].sort())) out.push('districts')
	const qa = new Map(a.questions.map(q => [q.code, q]))
	const qb = new Map(b.questions.map(q => [q.code, q]))
	for (const code of [...new Set([...qa.keys(), ...qb.keys()])].sort()) {
		const x = qa.get(code)
		const y = qb.get(code)
		const base = `questions.${code}`
		if (x === undefined || y === undefined) { out.push(base); continue }
		if (x.title !== y.title) out.push(`${base}.title`)
		if ((x.type ?? 'select') !== (y.type ?? 'select')) out.push(`${base}.type`)
		const ra = x.optionRange ? [x.optionRange.min, x.optionRange.max] : null
		const rb = y.optionRange ? [y.optionRange.min, y.optionRange.max] : null
		if (JSON.stringify(ra) !== JSON.stringify(rb)) out.push(`${base}.optionRange`)
		if (JSON.stringify(x.dependsOn ?? null) !== JSON.stringify(y.dependsOn ?? null)) out.push(`${base}.dependsOn`)
		const oa = new Map(x.options.map(o => [o.code, o]))
		const ob = new Map(y.options.map(o => [o.code, o]))
		for (const oc of [...new Set([...oa.keys(), ...ob.keys()])].sort()) {
			const p = oa.get(oc)
			const q = ob.get(oc)
			const ob2 = `${base}.options.${oc}`
			if (p === undefined || q === undefined) { out.push(ob2); continue }
			if (p.title !== q.title) out.push(`${ob2}.title`)
			if ((p.details ?? null) !== (q.details ?? null)) out.push(`${ob2}.details`)
		}
	}
	return out.sort()
}

async function setup () {
	const networksEngine = new NetworksEngine(new LocalStorageReact())
	const seeded = await seedDevNetwork(networksEngine, { registeredStateFixture: false })
	const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)!
	const electionEngine = await new ElectionsEngine(ctx).openElection(seeded.electionId)
	const details = await electionEngine.getElectionDetails()
	const openAt = details.current.timeline.votingStarts + 60_000
	const getEngine = (async (name: string) => {
		if (name === 'elections') return new ElectionsEngine(ctx)
		throw new Error(`unexpected engine "${name}"`)
	}) as never
	const context = await readVoteContext({ getEngine, fallbackElectionId: seeded.electionId }, openAt)
	return { ctx, seeded, electionEngine, context, revision: context.revision }
}

describe('A8 proposed vs confirmed template digest', () => {
	// seed runs the ballot confirmation
	it('P1 a probe ballot has the same digest before and after confirmation', async () => {
		const s = await setup()
		const dev = s.context.ballots[0]!
		const id = globalThis.crypto.randomUUID()
		await s.electionEngine.proposeBallot({
			id,
			electionId: s.seeded.electionId,
			authorityId: dev.authorityId,
			description: dev.description,
			districts: dev.districts,
			questions: DEV_SEED_BALLOT_QUESTIONS,
		} as Ballot)
		expect((await s.electionEngine.getBallotConfirmationState(id)).confirmed).toBe(false)
		const proposed = (await s.electionEngine.getBallotDetails(id)).ballot
		await confirmDevBallot(s.ctx, s.seeded.networkReference, s.seeded.electionId, id, s.seeded.sign)
		expect((await s.electionEngine.getBallotConfirmationState(id)).confirmed).toBe(true)
		const confirmed = (await s.electionEngine.getBallotDetails(id)).ballot
		expect({
			digestEqual: ballotTemplateDigest(proposed, s.revision) === ballotTemplateDigest(confirmed, s.revision),
			diff: templateDiff(proposed, confirmed),
		}).toEqual({ digestEqual: true, diff: [] })
	}, 30_000)

	it('P2 the dev ballot digest equals the digest of the questions the seed proposed', async () => {
		const s = await setup()
		const dev = s.context.ballots[0]!
		expect(ballotTemplateDigest(dev, s.revision)).toBe(
			ballotTemplateDigest({ ...dev, questions: DEV_SEED_BALLOT_QUESTIONS } as Ballot, s.revision),
		)
	}, 30_000)

	it('P3 the confirmed read carries the same questions as the seed, in any order', async () => {
		const s = await setup()
		const dev = s.context.ballots[0]!
		expect(dev.questions.map(q => q.code).slice().sort()).toEqual(DEV_SEED_BALLOT_QUESTIONS.map(q => q.code).slice().sort())
	}, 30_000)
})
