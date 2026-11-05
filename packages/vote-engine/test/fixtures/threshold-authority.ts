// 62-07 (D-08..D-12): a reusable multi-holder authority fixture for threshold co-signing
// tests, reused by 62-11 (ceb/vrg end-to-end) and 62-13 (rad fan-out + D-12 producer audit).
//
// 62-03 (D-48): the founder is the network's FIRST (and, until promotion, ONLY) unsigned
// Admin/Officer — formulation A admits exactly one unsigned Admin and one unsigned Officer
// per Authority. Every additional holder, the nonHolder and the outsider therefore enter
// through a REAL signed `proposeAdmin` promotion (the founder alone, at a founding
// threshold of 1, promotes the full target roster — including itself — in one call), never
// a raw unsigned insert. See the header comment on `createThresholdAuthority` below for the
// exact shape. This is a BEHAVIOR change from 62-07's original unsigned-insert shape, not
// merely an internal implementation swap: `adminEffectiveAt` now names the PROMOTED
// generation, never the founding one.
//
// The fixture never logs keys or signatures (T-62-07-08).

import type { Database } from '@quereus/quereus'
import type { AdminInit, OfficerSelection, Proposal, Scope, Signature, ThresholdPolicy, User } from '@votetorrent/vote-core'
import { BALLOT_HEADER_TID } from '../../src/election/election-engine.js'
import { nowCanonicalDatetime, toCanonicalDatetime } from '../../src/utils.js'
import {
  addTestAuthority,
  addTestElection,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  signTestDigest,
  createTestNetwork,
  type TestAuthorityContext,
  type TestElectionContext,
} from './test-context.js'

export interface ThresholdOfficer {
  user: User
  scopes: Scope[]
  sign: (digest: Uint8Array) => Promise<Signature>
}

export interface ThresholdAuthorityOptions {
  holderCount?: number
  holderScopes?: Scope[]
  thresholdPolicies?: ThresholdPolicy[]
  nonHolderScopes?: Scope[]
}

export interface ThresholdAuthorityFixture {
  /** Founder context; ctx.user has holders[0].user's id (holders[0].user.name is the DB User.Name). */
  elec: TestElectionContext
  authorityId: string
  adminEffectiveAt: string | number
  /** holders[0] is the founder; every holder holds every `holderScopes` entry. */
  holders: ThresholdOfficer[]
  /** A CURRENT officer holding only `nonHolderScopes`. */
  nonHolder: ThresholdOfficer
  /** A User row that is NOT an Officer. */
  outsider: User
}

const DEFAULT_HOLDER_SCOPES: Scope[] = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb']
const DEFAULT_THRESHOLD_POLICIES: ThresholdPolicy[] = [
  { policy: 'rad', threshold: 1 },
  { policy: 'ceb', threshold: 2 },
  { policy: 'vrg', threshold: 2 },
]
const DEFAULT_NON_HOLDER_SCOPES: Scope[] = ['mel']

/** Insert a User row via the invite-bound InsertValid arm (seedUserInvite + raw insert), mirroring
 *  authority.spec.ts's `seedExtraUser` shape, then register the user's fixture key as its FIRST
 *  UserKey (UserKey.InsertValid's first-key arm). Without that key every signature this user
 *  produces is refused by AdminSigning/OfficerSignature.SignerKeyValid — the engine now checks the
 *  signer key is a registered, unexpired UserKey of the signer instead of binding `true`. */
async function insertFixtureUser (auth: TestAuthorityContext, user: User): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature,
    }
  )
  const key = user.activeKeys[0]
  if (key) {
    await auth.ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = null, Signature = null, Tid = ${tid + 1}, now = :now, IsSignatureValid = true
       values (:userId, :type, :pubKey, :expiration)`,
      {
        userId: user.id,
        type: key.type,
        pubKey: key.key,
        expiration: toCanonicalDatetime(key.expiration),
        now: nowCanonicalDatetime(),
      }
    )
  }
}

/**
 * Build a multi-holder authority: a founding officer (holders[0]) plus `holderCount - 1`
 * additional officers who ALL hold `holderScopes`, one officer holding only `nonHolderScopes`,
 * and one plain User who is not an officer at all.
 *
 * 62-03 (D-48): the founder is minted unsigned by `createTestNetwork` (the network's FIRST
 * and only Admin/Officer), at an EMPTY founding `thresholdPolicies` (so `rad` defaults to
 * threshold 1, and the founder ALONE can complete the promotion below, regardless of what
 * `opts.thresholdPolicies` asks for — `readSessionThreshold` resolves the threshold off the
 * CURRENT (founding) Admin row the signer belongs to, never the proposed one, so this is
 * genuinely safe even when `opts.thresholdPolicies` sets `rad` to 2+). Every additional
 * holder, the nonHolder and the outsider get their `User` rows seeded via the ordinary
 * invite-bound arm (unaffected by D-48), and the founder then calls `proposeAdmin` with the
 * FULL target roster — every holder (itself included) plus the nonHolder, as `.existing`
 * entries — at an `effectiveAt` strictly between founding and now. Threshold 1 means Trigger
 * A auto-promotes inside that single call; `lastPromotionOutcome.status` is asserted
 * `'promoted'`, and `adminEffectiveAt` returned to the caller is this PROMOTED generation's
 * EffectiveAt (read back from `CurrentAdmin`), never the founding one.
 *
 * Defaults: holderCount 4 (founder + 3), holderScopes the full 7-scope set, thresholdPolicies
 * `{rad:1, ceb:2, vrg:2}`, nonHolderScopes `['mel']`.
 */
export async function createThresholdAuthority (opts?: ThresholdAuthorityOptions): Promise<ThresholdAuthorityFixture> {
  const holderCount = opts?.holderCount ?? 4
  const holderScopes = opts?.holderScopes ?? DEFAULT_HOLDER_SCOPES
  const thresholdPolicies = opts?.thresholdPolicies ?? DEFAULT_THRESHOLD_POLICIES
  const nonHolderScopes = opts?.nonHolderScopes ?? DEFAULT_NON_HOLDER_SCOPES
  // The founder must hold 'rad' to be able to propose/promote the roster below, even if
  // the caller's holderScopes omits it.
  const founderScopes: Scope[] = holderScopes.includes('rad' as Scope) ? holderScopes : [...holderScopes, 'rad' as Scope]

  const foundingEffectiveAt = Date.now() - 120_000
  const net = await createTestNetwork({
    network: {
      admin: {
        officers: [
          {
            init: {
              name: 'Admin A',
              title: 'Chair',
              scopes: founderScopes,
            },
          },
        ],
        effectiveAt: foundingEffectiveAt,
        // Founding threshold policies are EMPTY — see the method doc comment above for why
        // this is load-bearing (the promotion signer threshold is read off THIS row).
        thresholdPolicies: [],
      },
    },
  })
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  const authorityId = elec.authority.id

  // 62-65: the founder's `User.Name` is the ENTERED admin name ('Admin A' above), not the
  // device user's name — and `.existing` roster entries resolve ProposedName from that DB
  // row. Carry the DB name on `founder.user` so `holders[i].user.name` is each officer's
  // `User.Name` for every holder, founder included (identity stays `elec.user.id`).
  const founderRow = await elec.ctx.db
    .prepare('select Name from User where Id = :id')
    .get({ id: elec.user.id })
  if (!founderRow) throw new Error('createThresholdAuthority: founder User row missing')
  const founderUser: User = { ...elec.user, name: founderRow.Name as string }
  const founder: ThresholdOfficer = { user: founderUser, scopes: holderScopes, sign: makeTestSignCallback(elec.user) }
  const holders: ThresholdOfficer[] = [founder]

  // 62-03: `makeDistinctTestUser()` gives every call the SAME literal `name` ('Distinct
  // Test User') — only `id` differs. `ProposedOfficer`'s PK is (AuthorityId,
  // AdminEffectiveAt, ProposedName), and `.existing` entries resolve their ProposedName
  // from the DB's `User.Name`, so leaving every extra holder with that same shared name
  // would collide at the FIRST ProposedOfficer insert (`UNIQUE constraint failed`) the
  // moment there are 2+ of them. Each gets an explicit, distinct name.
  for (let i = 1; i < holderCount; i++) {
    const user: User = { ...makeDistinctTestUser(), name: `Officer ${i}` }
    await insertFixtureUser(auth, user)
    holders.push({ user, scopes: holderScopes, sign: makeTestSignCallback(user) })
  }

  const nonHolderUser: User = { ...makeDistinctTestUser(), name: 'Non-holder Officer' }
  await insertFixtureUser(auth, nonHolderUser)
  const nonHolder: ThresholdOfficer = {
    user: nonHolderUser,
    scopes: nonHolderScopes,
    sign: makeTestSignCallback(nonHolderUser),
  }

  const outsider: User = { ...makeDistinctTestUser(), name: 'Outsider' }
  await insertFixtureUser(auth, outsider)

  // Promote the full target roster (every holder including the founder, plus the
  // nonHolder) in ONE real, signed proposeAdmin call.
  const promotionEffectiveAt = Date.now() - 60_000
  const officers: OfficerSelection[] = [
    ...holders.map((h, i) => ({
      existing: { userId: h.user.id, authorityId, title: i === 0 ? 'Chair' : `Officer ${i}`, scopes: h.scopes },
    })),
    { existing: { userId: nonHolder.user.id, authorityId, title: 'Non-holder Officer', scopes: nonHolder.scopes } },
  ]
  const proposal: Proposal<AdminInit> = {
    proposed: { officers, effectiveAt: promotionEffectiveAt, thresholdPolicies },
    signers: [founder.user.id],
  }
  await elec.authorityEngine.proposeAdmin(proposal, founder.sign)
  const outcome = (elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } })
    .lastPromotionOutcome
  if (outcome?.status !== 'promoted') {
    throw new Error(
      `createThresholdAuthority: founder promotion did not complete — status=${String(outcome?.status)} reason=${String(outcome?.reason)}`
    )
  }

  const adminRow = await elec.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('createThresholdAuthority: CurrentAdmin not found after promotion')
  const adminEffectiveAt = adminRow.EffectiveAt as string | number

  // Post-state proof: the promoted Officer roster is EXACTLY the holders plus the nonHolder.
  const expectedUserIds = new Set([...holders.map((h) => h.user.id), nonHolder.user.id])
  const actualUserIds = new Set<string>()
  for await (const row of elec.ctx.db.eval(
    'select UserId from Officer where AuthorityId = :authorityId and AdminEffectiveAt = :e',
    { authorityId, e: adminEffectiveAt }
  )) {
    actualUserIds.add(row.UserId as string)
  }
  const matches = actualUserIds.size === expectedUserIds.size && [...expectedUserIds].every((id) => actualUserIds.has(id))
  if (!matches) {
    throw new Error(
      `createThresholdAuthority: promoted Officer roster mismatch — expected ${[...expectedUserIds].join(',')}, got ${[...actualUserIds].join(',')}`
    )
  }

  return { elec, authorityId, adminEffectiveAt, holders, nonHolder, outsider }
}

/** Read AdminSigning.Digest for `nonce` and sign it for real with `user`'s fixture private key. */
export async function signSessionDigest (db: Database, nonce: string, user: User): Promise<Signature> {
  const row = await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
  if (!row || row.Digest == null) {
    throw new Error(`signSessionDigest: no AdminSigning.Digest for nonce ${nonce}`)
  }
  return signTestDigest(user, row.Digest as string)
}

/**
 * Insert an UNSIGNED placeholder AdminSigning('ceb') header row for `ballotId`, mirroring
 * `ElectionEngine.submitBallotForConfirmation`'s Step 4 exactly (election-engine.ts:897-921) —
 * same Digest field order, same BALLOT_HEADER_TID constant. Creates NO Task.
 */
export async function insertBallotHeaderSession (
  fx: ThresholdAuthorityFixture,
  ballotId: string,
  initiatorUserId: string
): Promise<{ nonce: string }> {
  const db = fx.elec.ctx.db
  const ballotRow = await db
    .prepare('select ElectionId, AuthorityId, Description, Districts from ProposedBallot where Id = :ballotId')
    .get({ ballotId }) as { ElectionId: string, AuthorityId: string, Description: string, Districts: string } | undefined
  if (!ballotRow) throw new Error(`insertBallotHeaderSession: ProposedBallot not found: ${ballotId}`)

  const nonce = crypto.randomUUID()
  const now = nowCanonicalDatetime()
  const signerKey = '0'.repeat(66)
  const placeholderSig = '0'.repeat(128)

  await db.exec(
    `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
     with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
     values (:nonce, :authorityId, :adminEffectiveAt, 'ceb',
             Digest(:headerTid, :id, :electionId, :authorityId, :description, :districts),
             :userId, :signerKey, :signature)`,
    {
      nonce,
      authorityId: fx.authorityId,
      adminEffectiveAt: fx.adminEffectiveAt,
      headerTid: BALLOT_HEADER_TID,
      id: ballotId,
      electionId: ballotRow.ElectionId,
      description: ballotRow.Description,
      districts: ballotRow.Districts,
      userId: initiatorUserId,
      signerKey,
      signature: placeholderSig,
      now,
    }
  )

  return { nonce }
}

/** A `BallotSignatureTaskExtension` insert callback shaped for `fanOutSignatureTasks`'s
 *  `insertExtension` contract — `(taskId, recipientUserId) => Promise<void>`. */
export function ballotExtensionInserter (db: Database, ballotId: string): (taskId: string, recipientUserId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    await db.exec(
      `insert into BallotSignatureTaskExtension (TaskId, BallotId) with context Tid = :tid values (:taskId, :ballotId)`,
      { taskId, ballotId, tid: BALLOT_HEADER_TID }
    )
  }
}
