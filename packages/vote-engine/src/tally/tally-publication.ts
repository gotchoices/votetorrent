// tally/tally-publication.ts — publish one election revision's tally as a signed ElectionTally row, and read it back.
//
// Role:
//   - `publishElectionTally`: an officer's device writes the R8 tally tree it computed (blocks/tally-tree.ts,
//     normally from the on-demand results engine after the key release) as ONE row, signed with the officer's
//     key (user decision 2026-11-02). The row is the published root anyone can check against the blocks.
//   - `readPublishedTally`: any device reads the row back with three independent verdicts: the officer's
//     signature (the schema's own SignatureValid functions), the tree's internal consistency (verifyTallyTree),
//     and, when the caller passes its own recomputed tree, whether the published roots equal its roots.
//
// Rules:
//   - Never overwrites. An existing row with the same TallyRoot is 'already-published'; a different root for
//     the same revision is 'conflict' and nothing is written (the schema refuses updates as well).
//   - The tree is verified BEFORE signing, so an officer never signs a tree that does not verify.
//   - No transaction is held across sign() (same rule as key-release-engine.ts).
//   - Every outcome is a typed value. The schema's two publisher refusals are typed too ('not-officer' for
//     PublisherIsOfficer / PublisherKeyIsUsers, 'keys-not-released' for KeysReleased), so a screen never reads
//     error text; any other database or signer error is thrown unchanged from the write.

import type { KeyholderDkgSigner } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { verifyTallyTree, type TallyTree, type TallyVerifyResult } from '../blocks/tally-tree.js'
import { digestToBytes } from '../utils.js'

/** The officer's signing identity: a user id, one of its UserKeys, and a signer over a digest. */
export type TallyPublisher = KeyholderDkgSigner

export type PublishTallyOutcome =
  | { outcome: 'published', electionId: string, revision: number, tallyRoot: string, blockRoot: string, publishedAt: string }
  | { outcome: 'already-published', electionId: string, revision: number, tallyRoot: string, publishedAt: string }
  | { outcome: 'conflict', electionId: string, revision: number, publishedRoot: string, ourRoot: string }
  | { outcome: 'invalid-tally', reason: string }
  | { outcome: 'signer-key-mismatch' }
  /** the schema refused the publisher: not a current officer of the election's authority (or not its key) */
  | { outcome: 'not-officer' }
  /** the schema refused the row: the election key's shares are not released (threshold not met) on this device */
  | { outcome: 'keys-not-released' }

export interface PublishedTally {
  electionId: string
  revision: number
  blockRoot: string
  tallyRoot: string
  blockCount: number
  publishedAt: string
  publisherUserId: string
  publisherKey: string
  /** the officer's signature over Digest('ElectionTally', ...) checks out */
  signatureValid: boolean
  /** the stored tree is internally consistent (every hash, histogram and root) */
  treeCheck: TallyVerifyResult
  /** present only when a recomputed tree was passed: its roots equal the published ones */
  matchesRecomputed?: boolean
  tally: TallyTree | null
}

/**
 * What this device holds of a revision's committed vote blocks. `complete` is true when every block's declared
 * EntryCount is matched by VoteBlockVoter rows on this device: a block row that replicated ahead of its voter
 * rows makes it false. It cannot see a block that has not reached this device at all; that is why the
 * officer confirms the block count before publishing.
 */
export interface BlockCoverage {
  blocks: number
  /** sum of VoteBlock.EntryCount */
  declaredEntries: number
  /** VoteBlockVoter rows for those blocks */
  voterRows: number
  complete: boolean
}

type Row = Record<string, unknown>

const SELECT_ROW =
  'select ElectionId, ElectionRevision, BlockRoot, TallyRoot, BlockCount, TallyJson, PublishedAt, PublisherUserId, PublisherKey, Signature, ' +
  "(SignatureValid(Digest('ElectionTally', ElectionId, ElectionRevision, BlockRoot, TallyRoot, BlockCount, PublishedAt, PublisherUserId), Signature, PublisherKey) " +
  " or SignatureValidP256(Digest('ElectionTally', ElectionId, ElectionRevision, BlockRoot, TallyRoot, BlockCount, PublishedAt, PublisherUserId), Signature, PublisherKey)) as SigOk " +
  'from ElectionTally where ElectionId = :electionId and ElectionRevision = :revision'

const toNumber = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v))
const truthy = (v: unknown): boolean => v === true || v === 1 || v === 1n || v === '1'

export class TallyPublicationEngine {
  constructor (private readonly ctx: EngineContext, private readonly now: () => number = Date.now) {}

  /** Write `tally` as the election revision's ElectionTally row, signed by `publisher`. */
  async publishElectionTally (tally: TallyTree, publisher: TallyPublisher): Promise<PublishTallyOutcome> {
    const check = verifyTallyTree(tally)
    if (!check.ok) return { outcome: 'invalid-tally', reason: `${check.reason}: ${check.detail}` }
    const electionId = tally.electionId
    const revision = tally.electionRevision

    const existing = await this.row(electionId, revision)
    if (existing !== undefined) {
      const publishedRoot = String(existing.TallyRoot)
      return publishedRoot === tally.root
        ? { outcome: 'already-published', electionId, revision, tallyRoot: publishedRoot, publishedAt: String(existing.PublishedAt) }
        : { outcome: 'conflict', electionId, revision, publishedRoot, ourRoot: tally.root }
    }

    const keyRow = await this.ctx.db
      .prepare('select 1 as ok from UserKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId: publisher.userId, pubKey: publisher.signingPublicKey })
    if (keyRow == null) return { outcome: 'signer-key-mismatch' }

    const publishedAt = new Date(this.now()).toISOString()
    const tallyJson = JSON.stringify(tally)
    const digestRow = await this.ctx.db
      .prepare("select Digest('ElectionTally', :electionId, :revision, :blockRoot, :tallyRoot, :blockCount, :publishedAt, :userId) as d")
      .get({ electionId, revision, blockRoot: tally.blockRoot, tallyRoot: tally.root, blockCount: tally.size, publishedAt, userId: publisher.userId })
    if (digestRow == null || digestRow.d == null) {
      throw new Error('TallyPublicationEngine: Digest() returned null for ElectionTally — crypto plugin not registered?')
    }
    const signature = await publisher.sign(digestToBytes(digestRow.d as string))
    if (signature.signerKey !== publisher.signingPublicKey) return { outcome: 'signer-key-mismatch' }

    try {
      await this.ctx.db.exec(
        'insert into ElectionTally (ElectionId, ElectionRevision, BlockRoot, TallyRoot, BlockCount, TallyJson, PublishedAt, PublisherUserId, PublisherKey, Signature) ' +
        'with context now = :publishedAt ' +
        'values (:electionId, :revision, :blockRoot, :tallyRoot, :blockCount, :tallyJson, :publishedAt, :userId, :publisherKey, :signature)',
        {
          electionId, revision, blockRoot: tally.blockRoot, tallyRoot: tally.root, blockCount: tally.size, tallyJson,
          publishedAt, userId: publisher.userId, publisherKey: signature.signerKey, signature: signature.signature
        }
      )
    } catch (err) {
      // Another officer's device may have published meanwhile: re-read before reporting a failure.
      const raced = await this.row(electionId, revision)
      if (raced !== undefined) {
        const publishedRoot = String(raced.TallyRoot)
        return publishedRoot === tally.root
          ? { outcome: 'already-published', electionId, revision, tallyRoot: publishedRoot, publishedAt: String(raced.PublishedAt) }
          : { outcome: 'conflict', electionId, revision, publishedRoot, ourRoot: tally.root }
      }
      const message = err instanceof Error ? err.message : String(err)
      if (/\b(PublisherIsOfficer|PublisherKeyIsUsers)\b/.test(message)) return { outcome: 'not-officer' }
      if (/\bKeysReleased\b/.test(message)) return { outcome: 'keys-not-released' }
      throw err
    }
    return { outcome: 'published', electionId, revision, tallyRoot: tally.root, blockRoot: tally.blockRoot, publishedAt }
  }

  /** This device's copy of the revision's committed blocks (see BlockCoverage). */
  async blockCoverage (electionId: string, revision: number): Promise<BlockCoverage> {
    const blocks = await this.ctx.db
      .prepare('select count(*) as n, coalesce(sum(EntryCount), 0) as e from VoteBlock where ElectionId = :electionId and ElectionRevision = :revision')
      .get({ electionId, revision })
    const voters = await this.ctx.db
      .prepare('select count(*) as n from VoteBlockVoter v join VoteBlock b on b.Cid = v.BlockCid where b.ElectionId = :electionId and b.ElectionRevision = :revision')
      .get({ electionId, revision })
    const n = toNumber(blocks?.n ?? 0)
    const declaredEntries = toNumber(blocks?.e ?? 0)
    const voterRows = toNumber(voters?.n ?? 0)
    return { blocks: n, declaredEntries, voterRows, complete: declaredEntries === voterRows }
  }

  /** The published tally of `electionId` at `revision`, or null when none is published. */
  async readPublishedTally (electionId: string, revision: number, recomputed?: TallyTree): Promise<PublishedTally | null> {
    const row = await this.row(electionId, revision)
    if (row === undefined) return null
    let tally: TallyTree | null = null
    try { tally = JSON.parse(String(row.TallyJson)) as TallyTree } catch { tally = null }
    const treeCheck: TallyVerifyResult = tally === null
      ? { ok: false, reason: 'malformed-tally', detail: 'TallyJson is not JSON' }
      : verifyTallyTree(tally)
    const published: PublishedTally = {
      electionId,
      revision,
      blockRoot: String(row.BlockRoot),
      tallyRoot: String(row.TallyRoot),
      blockCount: toNumber(row.BlockCount),
      publishedAt: String(row.PublishedAt),
      publisherUserId: String(row.PublisherUserId),
      publisherKey: String(row.PublisherKey),
      signatureValid: truthy(row.SigOk),
      treeCheck,
      tally
    }
    if (recomputed !== undefined) {
      published.matchesRecomputed = recomputed.root === published.tallyRoot && recomputed.blockRoot === published.blockRoot
    }
    return published
  }

  private async row (electionId: string, revision: number): Promise<Row | undefined> {
    for await (const r of this.ctx.db.eval(SELECT_ROW, { electionId, revision })) return r as Row
    return undefined
  }
}
