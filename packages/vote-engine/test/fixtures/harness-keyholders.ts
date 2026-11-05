/**
 * harness-keyholders.ts — Phase 62 Plan 24 (D-13, D-19, D-23): cross-node keyholder seeding and
 * the cross-node DKG driver.
 *
 * Mirrors 62-17's `test/fixtures/dkg-keyholders.ts` (`seedDkgElection` / `inviteAndAcceptKeyholder`
 * / `runDkgToQuiescence`) exactly in shape, adapted so the election lives on the ALREADY-BOOTED
 * harness network (`HarnessWorkflowNetwork`) instead of a fresh `createTestNetwork()`, and so each
 * participant's accept runs on its OWN node (`ctxA` or `ctxB`) while the officer's invite always
 * runs on node-A. Every EXPORTED 62-17 helper is reused by name; only the unexported
 * `setKeyholderThreshold` body is copied (62-17's own SUMMARY records why no in-place
 * threshold-update path exists — `ElectionRevision.RevisionMonotonic` forbids it).
 *
 * TEST-ONLY. Node two-node evidence, code-complete and unverified on devices (P2P-11 debt).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  UserKeyType,
  type IElectionEngine,
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
import type { EngineContext } from '../../src/types.js'
import { randomTestKeyPair } from './keys.js'
import { inviteeContext, mintInviteKeyPair } from './invite-keys.js'
import { makeElectionInit, makeTestSignCallback } from './test-context.js'
import { HARNESS_TIMEOUTS, pollUntil } from '../harness/two-node-strand.js'
import type { HarnessWorkflowNetwork, HarnessNodeName } from './harness-workflows.js'

export interface HarnessDkgParticipant {
  name: string
  userId: string
  node: HarnessNodeName
  ctx: EngineContext
  signer: KeyholderDkgSigner
  vault: InMemoryTestKeyVault
  engine: KeyholderDkgEngine
  receivingPrivateKey: Uint8Array
}

export interface SeedHarnessDkgElectionResult {
  electionsEngine: ElectionsEngine
  electionEngine: IElectionEngine
  electionId: string
  revision: number
  participants: HarnessDkgParticipant[]
}

/**
 * `setKeyholderThreshold` DEVIATION (same class 62-17 already recorded): bakes the threshold into
 * the ORIGINAL signed revision-0 insert — the only path that exists — but on `auth` (the harness
 * network's node-A authority context), never a fresh `createTestNetwork()`.
 */
async function setHarnessKeyholderThreshold (
  auth: { ctx: EngineContext, user: Parameters<typeof makeTestSignCallback>[0], authority: { id: string } },
  threshold: number
): Promise<{ electionsEngine: ElectionsEngine, electionEngine: IElectionEngine, electionId: string }> {
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
  const revisionSigningNonce = await electionsEngine.seedElectionRevisionSigning(
    e.id,
    e.authorityId,
    {
      revision: 0,
      revisionTimestamp: pastRevTimestamp,
      tags: init.revision.tags,
      instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>,
      keyholderThreshold: threshold
    },
    revTid,
    sign
  )
  const initWithPastTs = { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } }
  await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })
  const electionEngine = await electionsEngine.openElection(e.id)
  return { electionsEngine, electionEngine, electionId: e.id }
}

/**
 * Invite (officer action, always node-A) and accept (on the participant's OWN node) a Type 'k'
 * keyholder slot by `name`. For a node-B participant, polls until the InviteSlot row is readable
 * on dbB before looking up its Cid there.
 */
/** Slot Cid -> the invite private key its slot was created with. */
const harnessInviteKeysBySlot = new Map<string, string>()

async function inviteAndAcceptOnHarness (
  network: HarnessWorkflowNetwork,
  electionEngine: IElectionEngine,
  electionId: string,
  name: string,
  node: HarnessNodeName
): Promise<HarnessDkgParticipant> {
  let slotRowA = await network.dbA.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  if (!slotRowA) {
    const kp = mintInviteKeyPair()
    const invite: KeyholderInvite = {
      name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey: kp.inviteKey, inviteSignature: ''
    }
    await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(network.net.user))
    slotRowA = await network.dbA.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
    if (slotRowA) harnessInviteKeysBySlot.set(slotRowA.Cid as string, kp.invitePrivate)
  }
  if (!slotRowA) throw new Error(`inviteAndAcceptOnHarness: no InviteSlot found for ${name}`)
  const slotCid = slotRowA.Cid as string
  const invitePrivate = harnessInviteKeysBySlot.get(slotCid)
  if (!invitePrivate) throw new Error(`inviteAndAcceptOnHarness: slot for ${name} has no known invite key (fixture never accepts keyless)`)

  const acceptCtx = node === 'node-A' ? network.ctxA : network.ctxB
  const acceptDb = node === 'node-A' ? network.dbA : network.dbB

  if (node === 'node-B') {
    await pollUntil(
      async () => acceptDb.prepare('select Cid from InviteSlot where Cid = :cid').get({ cid: slotCid }),
      (r) => r != null,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: `inviteAndAcceptOnHarness: InviteSlot ${name} reaches node-B` }
    )
  }

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
  const invitationEngine = new InvitationEngine(inviteeContext(acceptCtx))
  await invitationEngine.respondToInvite(slotCid, true, invitePrivate, undefined, undefined, provisioning)

  const resultRow = await acceptDb.prepare('select InvokedId from InviteResult where SlotCid = :cid').get({ cid: slotCid })
  const userId = resultRow?.InvokedId as string | undefined
  if (!userId) throw new Error(`inviteAndAcceptOnHarness: no InviteResult.InvokedId for ${name}`)

  const vault = new InMemoryTestKeyVault()
  await vault.putSecret(keyholderDkgReceivingKeyAlias(userId), recv.privateKey, KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
  const engine = new KeyholderDkgEngine(acceptCtx, { vault })
  const signer: KeyholderDkgSigner = { userId, signingPublicKey: signingPublicHex, sign }
  return { name, userId, node, ctx: acceptCtx, signer, vault, engine, receivingPrivateKey: recv.privateKey }
}

/**
 * `seedHarnessDkgElection(network, { placement, threshold })` — `placement` names one
 * `'node-A' | 'node-B'` entry per keyholder (e.g. `['node-A', 'node-A', 'node-B']`). Each
 * participant's signer/vault/engine are bound to ONE node and never used against the other
 * node's db.
 */
export async function seedHarnessDkgElection (
  network: HarnessWorkflowNetwork,
  options: { placement: HarnessNodeName[], threshold: number }
): Promise<SeedHarnessDkgElectionResult> {
  const { electionsEngine, electionEngine, electionId } = await setHarnessKeyholderThreshold(network.auth, options.threshold)

  const participants: HarnessDkgParticipant[] = []
  for (let i = 0; i < options.placement.length; i++) {
    const node = options.placement[i]!
    const name = `harness-kh-${i + 1}`
    participants.push(await inviteAndAcceptOnHarness(network, electionEngine, electionId, name, node))
  }

  const revRow = await network.dbA.prepare('select Revision from ElectionRevision where ElectionId = :id').get({ id: electionId })
  const revision = revRow?.Revision as number
  return { electionsEngine, electionEngine, electionId, revision, participants }
}

export interface RunDkgAcrossNodesOptions {
  maxPasses?: number
}

/**
 * `runDkgAcrossNodes(network, participants, electionId, { maxPasses })` — each pass advances
 * every participant on its OWN node, then `pollUntil`s both nodes show the same
 * `KeyholderDkgMessage` row count AND the same `ElectionKey` row count for `electionId`, within
 * `replicationMs`, before the next pass — so no participant ever acts on a stale cross-peer view.
 * Stops when every participant's own status is `'complete'`.
 *
 * DEVIATION (same class 62-17 already recorded for `runDkgToQuiescence`): the plan's 2-arg prose
 * (`network, participants`) omits `electionId`, but `KeyholderDkgEngine.advanceDkg`/`getDkgStatus`
 * (locked `<interfaces>`) both need it, and `HarnessDkgParticipant` carries no electionId field
 * (mirrors 62-17's own `DkgTestParticipant`) — added as an explicit third positional parameter.
 */
export async function runDkgAcrossNodes (
  network: HarnessWorkflowNetwork,
  participants: HarnessDkgParticipant[],
  electionId: string,
  options: RunDkgAcrossNodesOptions = {}
): Promise<void> {
  const { maxPasses = 30 } = options

  let passes = 0
  let lastPhases: Record<string, string> = {}
  while (passes < maxPasses) {
    for (const p of participants) {
      await p.engine.advanceDkg(electionId, p.signer)
    }

    await pollUntil(
      async () => {
        const aRow = await network.dbA.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :id').get({ id: electionId })
        const bRow = await network.dbB.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :id').get({ id: electionId })
        const aKey = await network.dbA.prepare('select count(*) as n from ElectionKey where ElectionId = :id').get({ id: electionId })
        const bKey = await network.dbB.prepare('select count(*) as n from ElectionKey where ElectionId = :id').get({ id: electionId })
        return { aMsg: aRow?.n as number, bMsg: bRow?.n as number, aKey: aKey?.n as number, bKey: bKey?.n as number }
      },
      (v) => v.aMsg === v.bMsg && v.aKey === v.bKey,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'runDkgAcrossNodes: both nodes converge on KeyholderDkgMessage/ElectionKey counts' }
    )

    let allComplete = true
    lastPhases = {}
    for (const p of participants) {
      const status = await p.engine.getDkgStatus(electionId, p.userId)
      lastPhases[p.userId] = status.phase
      if (status.phase !== 'complete') allComplete = false
    }
    if (allComplete) return
    passes++
  }
  throw new Error(`dkg did not complete in ${maxPasses} passes; last=${JSON.stringify(lastPhases)}`)
}
