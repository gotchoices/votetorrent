// test/fixtures/dkg-keyholders.ts — 62-17 Task 2 test fixture: seeds a
// multi-keyholder election through the REAL D-21/D-26 invite+accept pipeline
// (`ElectionEngine.inviteKeyholder` + `InvitationEngine.respondToInvite` with
// `KeyholderAcceptProvisioning`), then constructs one `KeyholderDkgEngine`
// per participant over its OWN `InMemoryTestKeyVault` but the SAME shared DB
// — mirroring how independent keyholder devices share one replicated strand.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import {
  UserKeyType,
  type KeyholderAcceptProvisioning,
  type KeyholderDkgSigner,
  type KeyholderInvite,
  type Signature
} from '@votetorrent/vote-core'
import { ElectionsEngine, peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { InvitationEngine } from '../../src/invite/invitation-engine.js'
import { generateDkgReceivingKey } from '../../src/crypto/dkg.js'
import { InMemoryTestKeyVault, KEYHOLDER_DKG_RECEIVING_KEY_POLICY, keyholderDkgReceivingKeyAlias } from '../../src/crypto/vault.js'
import { KeyholderDkgEngine } from '../../src/keyholder/keyholder-dkg-engine.js'
import { decodeDkgRoundVaultRecord, keyholderDkgRoundSecretAlias, type DkgRoundVaultRecord } from '../../src/keyholder/dkg-vault.js'
import { digestToBytes } from '../../src/utils.js'
import { randomTestKeyPair } from './keys.js'
import { inviteeContext, mintInviteKeyPair } from './invite-keys.js'
import { addTestAuthority, createTestNetwork, makeElectionInit, makeTestSignCallback, type TestAuthorityContext } from './test-context.js'
import type { IElectionEngine } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// setKeyholderThreshold — DEVIATION recorded in the SUMMARY: the plan's
// prose names this `setKeyholderThreshold(elec, k)`, implying an in-place
// update on an already-built `TestElectionContext`. No such update path
// exists — `ElectionRevision.RevisionMonotonic` forbids an UPDATE that does
// not also bump `Revision`, which would defeat "keyholders bind to revision
// 0". The ONLY precedent (`keyholder-dkg-schema.spec.ts`'s
// `seedElectionWithThreshold`) instead builds the whole election chain with
// the chosen threshold baked into the ORIGINAL signed revision-0 insert.
// That body is copied here (not imported — it lives in a spec file) under
// the name `setKeyholderThreshold`, taking the threshold alone and
// returning a fresh election context, which is what `seedDkgElection` below
// actually needs.
// ---------------------------------------------------------------------------

async function setKeyholderThreshold (threshold: number): Promise<{ auth: TestAuthorityContext, electionsEngine: ElectionsEngine, electionEngine: IElectionEngine, electionId: string }> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const electionsEngine = new ElectionsEngine(auth.ctx)
  const init = makeElectionInit({ authorityId: auth.authority.id })
  init.revision.keyholderThreshold = threshold
  const { election: e } = init
  const pastRevTimestamp = Date.now() - 1000
  const electionFields = {
    id: e.id, authorityId: e.authorityId, title: e.title, date: e.date,
    revisionDeadline: e.revisionDeadline, ballotDeadline: e.ballotDeadline, type: e.type
  }
  const sign = makeTestSignCallback(auth.user)
  const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)
  const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as unknown as {
    seedElectionRevisionSigning (
      electionId: string, authorityId: string,
      revision: { revision: number, revisionTimestamp: number, tags: string[], instructions: string, timeline: Record<string, number>, keyholderThreshold: number },
      tid: number, sign: (digest: Uint8Array) => Promise<Signature>
    ): Promise<string>
  }).seedElectionRevisionSigning(
    e.id, e.authorityId,
    {
      revision: 0, revisionTimestamp: pastRevTimestamp, tags: init.revision.tags, instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>, keyholderThreshold: threshold
    },
    revTid, sign
  )
  const initWithPastTs = { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } }
  await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })
  const electionEngine = await electionsEngine.openElection(e.id)
  return { auth, electionsEngine, electionEngine, electionId: e.id }
}

// ---------------------------------------------------------------------------
// seedDkgElection
// ---------------------------------------------------------------------------

export interface DkgTestParticipant {
  name: string
  userId: string
  signer: KeyholderDkgSigner
  vault: InMemoryTestKeyVault
  engine: KeyholderDkgEngine
  receivingPrivateKey: Uint8Array
}

export interface SeedDkgElectionResult {
  auth: TestAuthorityContext
  electionsEngine: ElectionsEngine
  electionEngine: IElectionEngine
  electionId: string
  revision: number
  participants: DkgTestParticipant[]
}

/**
 * Invite (if not already invited) and accept a Type 'k' keyholder slot by
 * `name`, through the real D-21/D-26 pipeline, returning its
 * `DkgTestParticipant`. Factored out of `seedDkgElection` so a caller (e.g.
 * scenario G's pending-invite unblock) can accept a keyholder invite
 * AFTER the election is already seeded.
 */
/** Slot Cid -> the invite private key its slot was created with. */
const inviteKeysBySlot = new Map<string, string>()

export async function inviteAndAcceptKeyholder (auth: TestAuthorityContext, electionEngine: IElectionEngine, electionId: string, name: string): Promise<DkgTestParticipant> {
  let slotRow = await auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  if (!slotRow) {
    const kp = mintInviteKeyPair()
    const invite: KeyholderInvite = {
      name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey: kp.inviteKey, inviteSignature: ''
    }
    await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(auth.user))
    slotRow = await auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
    if (slotRow) inviteKeysBySlot.set(slotRow.Cid as string, kp.invitePrivate)
  }
  if (!slotRow) throw new Error(`inviteAndAcceptKeyholder: no InviteSlot found for ${name}`)
  const slotCid = slotRow.Cid as string
  const invitePrivate = inviteKeysBySlot.get(slotCid)
  if (!invitePrivate) throw new Error(`inviteAndAcceptKeyholder: slot for ${name} has no known invite key (fixture never accepts keyless)`)

  const { privateHex: signingPrivateHex, publicHex: signingPublicHex } = randomTestKeyPair()
  const recv = generateDkgReceivingKey()
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, hexToBytes(signingPrivateHex))
    return { signature: bytesToHex(sig), signerKey: signingPublicHex, signerUserId: '' }
  }
  const provisioning: KeyholderAcceptProvisioning = {
    signingKey: { key: signingPublicHex, type: UserKeyType.mobile, expiration: Date.now() + 10 * 365 * 86_400_000 },
    dkgPublicKey: recv.publicKey,
    sign
  }
  const invitationEngine = new InvitationEngine(inviteeContext(auth.ctx))
  await invitationEngine.respondToInvite(slotCid, true, invitePrivate, undefined, undefined, provisioning)

  const resultRow = await auth.ctx.db.prepare('select InvokedId from InviteResult where SlotCid = :cid').get({ cid: slotCid })
  const userId = resultRow?.InvokedId as string | undefined
  if (!userId) throw new Error(`inviteAndAcceptKeyholder: no InviteResult.InvokedId for ${name}`)

  const vault = new InMemoryTestKeyVault()
  await vault.putSecret(keyholderDkgReceivingKeyAlias(userId), recv.privateKey, KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
  const engine = new KeyholderDkgEngine(auth.ctx, { vault })
  const signer: KeyholderDkgSigner = { userId, signingPublicKey: signingPublicHex, sign }
  return { name, userId, signer, vault, engine, receivingPrivateKey: recv.privateKey }
}

export async function seedDkgElection (options: { keyholders: string[], threshold: number, pendingInvites?: string[] }): Promise<SeedDkgElectionResult> {
  const { auth, electionsEngine, electionEngine, electionId } = await setKeyholderThreshold(options.threshold)
  const participants: DkgTestParticipant[] = []

  for (const name of options.keyholders) {
    participants.push(await inviteAndAcceptKeyholder(auth, electionEngine, electionId, name))
  }

  for (const name of options.pendingInvites ?? []) {
    const kp = mintInviteKeyPair()
    const invite: KeyholderInvite = {
      name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey: kp.inviteKey, inviteSignature: ''
    }
    await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(auth.user))
    const pendingRow = await auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
    if (pendingRow) inviteKeysBySlot.set(pendingRow.Cid as string, kp.invitePrivate)
  }

  const revRow = await auth.ctx.db.prepare('select Revision from ElectionRevision where ElectionId = :id').get({ id: electionId })
  const revision = revRow?.Revision as number
  return { auth, electionsEngine, electionEngine, electionId, revision, participants }
}

// ---------------------------------------------------------------------------
// runDkgToQuiescence
// ---------------------------------------------------------------------------

export interface RunDkgOptions {
  skip?: string[]
  stopWhen?: () => boolean | Promise<boolean>
  maxPasses?: number
}

/**
 * DEVIATION recorded in the SUMMARY: the plan's prose signature is
 * `runDkgToQuiescence(participants, { skip?, stopWhen?, maxPasses })` with
 * no `electionId` — but `IKeyholderDkgEngine.advanceDkg` (locked,
 * `<interfaces>`) takes `electionId` as its first argument, so the driver
 * must be told which election to advance. `electionId` is added as the
 * second positional parameter.
 */
export async function runDkgToQuiescence (participants: DkgTestParticipant[], electionId: string, options: RunDkgOptions = {}): Promise<void> {
  const { skip = [], stopWhen, maxPasses = 60 } = options
  let passes = 0
  while (passes < maxPasses) {
    let anyAction = false
    for (const p of participants) {
      if (skip.includes(p.userId)) continue
      const result = await p.engine.advanceDkg(electionId, p.signer)
      if (result.actions.length > 0) anyAction = true
      if (stopWhen && (await stopWhen())) return
    }
    if (!anyAction) return
    passes++
  }
  throw new Error(`runDkgToQuiescence: exceeded maxPasses (${maxPasses})`)
}

// ---------------------------------------------------------------------------
// postSignedDkgMessage — raw strand-row injection for misbehavior scenarios
// ---------------------------------------------------------------------------

export async function postSignedDkgMessage (db: Database, participant: DkgTestParticipant, params: {
  electionId: string, revision: number, attempt: number, dkgRound: number, payload: string, resultKey: string | null
}): Promise<void> {
  const { electionId, revision, attempt, dkgRound, payload, resultKey } = params
  const sentAt = new Date().toISOString()
  const digestRow = await db
    .prepare("select Digest('KeyholderDkgMessage', :electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt) as d")
    .get({ electionId, revision, attempt, dkgRound, senderUserId: participant.userId, payload, resultKey, sentAt })
  if (!digestRow || digestRow.d == null) throw new Error('postSignedDkgMessage: Digest() returned null')
  const signature = await participant.signer.sign(digestToBytes(digestRow.d as string))
  await db.exec(
    `insert into KeyholderDkgMessage (ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt, SenderKey, Signature)
     values (:electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt, :senderKey, :signature)`,
    { electionId, revision, attempt, dkgRound, senderUserId: participant.userId, payload, resultKey, sentAt, senderKey: signature.signerKey, signature: signature.signature }
  )
}

// ---------------------------------------------------------------------------
// readRoundRecord — test introspection of a participant's own vault
// ---------------------------------------------------------------------------

export async function readRoundRecord (
  participant: DkgTestParticipant, electionId: string, revision: number, attempt: number, step: 1 | 2
): Promise<DkgRoundVaultRecord | null> {
  const alias = keyholderDkgRoundSecretAlias(electionId, revision, attempt, step, participant.userId)
  const bytes = await participant.vault.getSecret(alias)
  if (bytes === null) return null
  return decodeDkgRoundVaultRecord(bytes)
}
