/**
 * tally-publication.spec.ts — an officer publishes the tally as ONE signed ElectionTally row (user decision
 * 2026-11-02). Over a real 2-of-3 DKG election on the real schema: the keys are released, the key is rebuilt,
 * the R8 tree is built (no blocks committed, so the empty tree, which is still a full tree with roots), then
 *   P0 the block-coverage read runs over the real VoteBlock / VoteBlockVoter tables;
 *   P1 publishes and reads back with a valid officer signature, a verifying tree and matching recomputed roots;
 *   P2 a second publish of the same tree is 'already-published' and writes nothing;
 *   P3 a tree that does not verify is refused before anything is signed;
 *   P4 the schema refuses a non-officer (a keyholder) as publisher, and refuses any update;
 *   P5 a signer whose key is not one of its UserKeys is refused before signing.
 */

import { expect } from 'chai'
import type { EngineContext } from '../src/types.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { buildTallyTree, type TallyTree } from '../src/blocks/tally-tree.js'
import { TallyPublicationEngine, type TallyPublisher } from '../src/tally/tally-publication.js'
import { digestToBytes } from '../src/utils.js'
import { makeTestSignCallback } from './fixtures/test-context.js'
import { runDkgToQuiescence, seedDkgElection } from './fixtures/dkg-keyholders.js'

describe('tally publication: an officer signs the published tally (ElectionTally)', function () {
  this.timeout(240000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let ctx: EngineContext
  let tally: TallyTree
  let officer: TallyPublisher
  let at: number

  before(async function () {
    this.timeout(240000)
    elec = await seedDkgElection({ keyholders: ['tp-1', 'tp-2', 'tp-3'], threshold: 2 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    ctx = { db: elec.auth.ctx.db }
    const timeline = await ctx.db.prepare('select Timeline from ElectionRevision where ElectionId = :id').get({ id: elec.electionId })
    at = releasingKeysAt(JSON.parse(timeline!.Timeline as string) as Record<string, number>)!
    for (const p of elec.participants.slice(0, 2)) {
      await new KeyReleaseEngine(ctx, { vault: p.vault, now: () => at }).releaseKeyShare(elec.electionId, p.signer)
    }
    const key = await new KeyReleaseEngine(ctx).reconstructElectionKey(elec.electionId)
    const built = buildTallyTree({
      scope: { electionId: elec.electionId, electionRevision: elec.revision },
      rows: [], voterRows: [], ballots: [], registrants: [], associations: [],
      timeline: { votingStarts: 0 },
      release: { secretKey: key.secretKey, jointPublicKey: key.jointPublicKey }
    })
    key.secretKey.fill(0)
    if (!built.ok) throw new Error(`fixture: buildTallyTree refused: ${built.reason} ${built.detail}`)
    tally = built.tally
    const user = elec.auth.user
    officer = { userId: user.id, signingPublicKey: user.activeKeys[0]!.key, sign: makeTestSignCallback(user) }
  })

  const engine = (): TallyPublicationEngine => new TallyPublicationEngine(ctx, () => at + 60_000)

  it('P0 block coverage over the real schema: no committed block is zero declared entries, zero voter rows, complete', async () => {
    expect(await engine().blockCoverage(elec.electionId, elec.revision)).to.deep.equal({ blocks: 0, declaredEntries: 0, voterRows: 0, complete: true })
  })

  it('P3 a tree that does not verify is refused before anything is signed', async () => {
    let signed = 0
    const counting: TallyPublisher = { ...officer, sign: async (d) => { signed++; return await officer.sign(d) } }
    const tampered = { ...tally, root: 'ab'.repeat(32) }
    const r = await engine().publishElectionTally(tampered, counting)
    expect(r.outcome).to.equal('invalid-tally')
    expect(signed).to.equal(0)
    expect(await engine().readPublishedTally(elec.electionId, elec.revision)).to.equal(null)
  })

  it('P5 a signer whose key is not one of its UserKeys is refused before signing', async () => {
    let signed = 0
    const wrong: TallyPublisher = { ...officer, signingPublicKey: '02' + '11'.repeat(32), sign: async (d) => { signed++; return await officer.sign(d) } }
    const r = await engine().publishElectionTally(tally, wrong)
    expect(r.outcome).to.equal('signer-key-mismatch')
    expect(signed).to.equal(0)
  })

  it('P4a the schema refuses a keyholder who is not an officer as publisher (typed not-officer, from PublisherIsOfficer)', async () => {
    const keyholder = elec.participants[2]!
    // The engine's typing rests on the schema's own refusal: record what the real write threw.
    const thrown: unknown[] = []
    const db = ctx.db
    const watched = new Proxy(db, {
      get (target, prop, receiver) {
        if (prop !== 'exec') return Reflect.get(target, prop, receiver)
        return async (...args: unknown[]) => {
          try {
            return await (target.exec as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          } catch (err) {
            thrown.push(err)
            throw err
          }
        }
      }
    })
    const r = await new TallyPublicationEngine({ db: watched }, () => at + 60_000).publishElectionTally(tally, keyholder.signer)
    expect(thrown.map(String).join(' | ')).to.contain('PublisherIsOfficer')
    expect(r.outcome).to.equal('not-officer')
    expect(await engine().readPublishedTally(elec.electionId, elec.revision)).to.equal(null)
  })

  it('P1 the officer publishes; the row reads back signed, verifying, and equal to a recomputation', async () => {
    const r = await engine().publishElectionTally(tally, officer)
    expect(r.outcome).to.equal('published')
    const back = await engine().readPublishedTally(elec.electionId, elec.revision, tally)
    expect(back).to.not.equal(null)
    expect(back!.signatureValid).to.equal(true)
    expect(back!.treeCheck).to.deep.equal({ ok: true })
    expect(back!.matchesRecomputed).to.equal(true)
    expect(back!.tallyRoot).to.equal(tally.root)
    expect(back!.blockRoot).to.equal(tally.blockRoot)
    expect(back!.blockCount).to.equal(0)
    expect(back!.publisherUserId).to.equal(officer.userId)
    expect(back!.tally).to.deep.equal(JSON.parse(JSON.stringify(tally)))
  })

  it('P2 publishing the same tree again is already-published and writes nothing', async () => {
    const before = await engine().readPublishedTally(elec.electionId, elec.revision)
    const r = await engine().publishElectionTally(tally, officer)
    expect(r.outcome).to.equal('already-published')
    const after = await engine().readPublishedTally(elec.electionId, elec.revision)
    expect(after!.publishedAt).to.equal(before!.publishedAt)
  })

  it('P4b the schema refuses any update of a published tally', async () => {
    let thrown: unknown
    try {
      await ctx.db.exec("update ElectionTally set PublishedAt = '2030-01-01T00:00:00.000Z' where ElectionId = :id", { id: elec.electionId })
    } catch (err) {
      thrown = err
    }
    expect(thrown, 'update must be refused').to.not.equal(undefined)
  })

  it('a signature over the stored digest checks out with the publisher key (independent of the engine)', async () => {
    const row = await ctx.db.prepare("select Digest('ElectionTally', ElectionId, ElectionRevision, BlockRoot, TallyRoot, BlockCount, PublishedAt, PublisherUserId) as d, Signature, PublisherKey from ElectionTally where ElectionId = :id").get({ id: elec.electionId })
    expect(row).to.not.equal(undefined)
    const resigned = await officer.sign(digestToBytes(row!.d as string))
    expect(resigned.signerKey).to.equal(row!.PublisherKey)
  })
})
