/**
 * staging-concurrency.harness.spec.ts — Phase 62 Plan 24 (D-23, deferred from 62-15's single-node
 * race): the cross-peer half of D-05's "no row silently lost or written twice".
 *
 * 62-15's `insertWithCursorRetry` closes the LOCALLY observable cursor race (one process, one
 * port, concurrent callers). This spec forces the race ACROSS two real peers, each with its own
 * production sealer and its own requester signer, holding both first inserts at a shared barrier
 * so the race is PROVEN to have been exercised (both allocate cursor `0000000000000001`), not
 * merely assumed.
 *
 * ============================================================================
 * NODE TWO-NODE EVIDENCE — CODE-COMPLETE, UNVERIFIED ON DEVICES.
 * ============================================================================
 * A true network partition is PROBED and RECORDED (P-OFFLINE), never asserted — this harness has
 * no durable keyStore/joinedStrands store, so a disconnect-and-remesh cycle's precise behavior is
 * evidence, not a pinned contract.
 */

import { expect } from 'chai'
import {
  startTwoNodeHarness,
  describeP2PHarness,
  pollUntil,
  HARNESS_TIMEOUTS
} from './harness/two-node-strand.js'
import type { TwoNodeHarness, HarnessStrandPort } from './harness/two-node-strand.js'
import {
  bootHarnessNetwork,
  assertForeignOrigin,
  createBarrierPort,
  regMakeInit,
  regDigest,
  assocMakeInit,
  assocRequestDigest,
  assocAttestationDigest,
  makeRequesterSigner
} from './fixtures/harness-workflows.js'
import type { HarnessWorkflowNetwork } from './fixtures/harness-workflows.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import { P2pStagingError } from '../src/registration/transport/p2p-staging-seam.js'
import { IntakeEngine, createIntakeSealer, intakeQueryPortFromDb, resolveIntakeRecipients } from '../src/intake/index.js'
import { InMemoryTestKeyVault } from '../src/crypto/vault.js'
import { makeTestSignCallback } from './fixtures/test-context.js'

const ALLOWED_REJECTION_CODES = new Set(['rejected', 'cursor-exhausted', 'duplicate-request-id'])

interface StagingRowShape { RequestId: string, Cursor: string, RequesterKey: string, Digest: string }

async function rawRows (db: HarnessWorkflowNetwork['dbA'], table: string, strandId: string): Promise<StagingRowShape[]> {
  const rows: StagingRowShape[] = []
  for await (const row of db.eval(`select RequestId, Cursor, RequesterKey, Digest from ${table} where StrandId = :strandId`, { strandId } as any)) {
    rows.push(row as unknown as StagingRowShape)
  }
  return rows
}

function tupleKey (r: StagingRowShape): string {
  return `${r.RequestId}|${r.Cursor}|${r.RequesterKey}|${r.Digest}`
}

/** Applies the F-1/F-4 contract once both nodes have converged on an identical row set for
 * `table`. Throws loudly on any violation — never weakened to a soft log. */
async function applyCursorRaceContract (network: HarnessWorkflowNetwork, table: string, strandId: string): Promise<void> {
  await pollUntil(
    async () => {
      const a = await rawRows(network.dbA, table, strandId)
      const b = await rawRows(network.dbB, table, strandId)
      return { a, b }
    },
    (v) => v.a.length >= 2 && v.b.length >= 2,
    { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: `applyCursorRaceContract: ${table} converges to 2 rows on both nodes` }
  )
  const a = await rawRows(network.dbA, table, strandId)
  const b = await rawRows(network.dbB, table, strandId)
  const aKeys = new Set(a.map(tupleKey))
  const bKeys = new Set(b.map(tupleKey))
  expect([...aKeys].sort(), `${table}: node-A and node-B hold identical row sets`).to.deep.equal([...bKeys].sort())

  const cursorsA = a.map((r) => r.Cursor)
  expect(new Set(cursorsA).size, `${table}: no duplicate (StrandId, Cursor) on node-A`).to.equal(cursorsA.length)
  const cursorsB = b.map((r) => r.Cursor)
  expect(new Set(cursorsB).size, `${table}: no duplicate (StrandId, Cursor) on node-B`).to.equal(cursorsB.length)
}

/** One submit attempt, classified. A resolved submit returns `{ok:true}`; a typed
 * `P2pStagingError` whose code is in the allowed set returns `{ok:false, code}`; anything else
 * (an unexpected error type, or a code outside the set) is a FAIL and re-thrown. */
async function attemptSubmit (submit: () => Promise<string>): Promise<{ ok: true } | { ok: false, code: string }> {
  try {
    await submit()
    return { ok: true }
  } catch (err) {
    if (!(err instanceof P2pStagingError)) throw err
    if (!ALLOWED_REJECTION_CODES.has(err.code)) {
      throw new Error(`attemptSubmit: untyped/unexpected P2pStagingError code ${JSON.stringify(err.code)}: ${err.message}`)
    }
    return { ok: false, code: err.code }
  }
}

describeP2PHarness('two-node concurrent staging (D-23, deferred from the single-node race)', function () {
  let harness: TwoNodeHarness | undefined
  let network: HarnessWorkflowNetwork
  let authorityId: string
  const runId = { current: '' }
  const legTimings: Record<string, number> = {}

  function timed<T> (label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    return fn().finally(() => { legTimings[label] = Date.now() - start })
  }

  before(async function () {
    this.timeout(HARNESS_TIMEOUTS.suiteMs)
    harness = await startTwoNodeHarness()
    network = await bootHarnessNetwork(harness)
    authorityId = network.auth.authority.id
    runId.current = harness.runId

    const vaultB = new InMemoryTestKeyVault()
    await new IntakeEngine(network.ctxB).registerOfficerEncryptionKey(authorityId, vaultB, makeTestSignCallback(network.net.user))
    await pollUntil(
      async () => resolveIntakeRecipients(intakeQueryPortFromDb(network.dbA), authorityId),
      (set) => set.recipients.length === 1,
      { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'before: officer encryption key reaches node-A' }
    )
  })

  after(async function () {
    this.timeout(HARNESS_TIMEOUTS.startMs)
    await harness?.stop()
  })

  it('F-1 registration cursor race across peers', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 30_000)
    await timed('F-1', async () => {
      let cursorA: string | undefined
      let cursorB: string | undefined

      const transportA = new P2pRegistrationTransport({
        openStrand: async () => createBarrierPort(await network.portA(), {
          table: 'RegistrationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorA = c }
        }) as unknown as import('../src/registration/transport/p2p-registration-transport.js').RegistrationStrandPort,
        computeDigest: regDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      })
      const transportB = new P2pRegistrationTransport({
        openStrand: async () => createBarrierPort(await network.portB(), {
          table: 'RegistrationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorB = c }
        }) as unknown as import('../src/registration/transport/p2p-registration-transport.js').RegistrationStrandPort,
        computeDigest: regDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbB), authorityId })
      })

      const signerA = makeRequesterSigner()
      const signerB = makeRequesterSigner()
      const initA = regMakeInit(authorityId, { id: `f1-race-a-${runId.current}` })
      const initB = regMakeInit(authorityId, { id: `f1-race-b-${runId.current}` })
      const sigA = await signerA.sign(await regDigest(initA, signerA.publicHex))
      const sigB = await signerB.sign(await regDigest(initB, signerB.publicHex))

      const submitA = async (): Promise<string> => transportA.submitRequest(initA, signerA.publicHex, sigA)
      const submitB = async (): Promise<string> => transportB.submitRequest(initB, signerB.publicHex, sigB)

      const [resultA, resultB] = await Promise.allSettled([submitA(), submitB()])

      expect(cursorA, 'F-1: node-A positive control — first attempt cursor').to.equal('0000000000000001')
      expect(cursorB, 'F-1: node-B positive control — first attempt cursor').to.equal('0000000000000001')
      if (cursorA !== '0000000000000001' || cursorB !== '0000000000000001') {
        throw new Error('race not exercised: both first-attempt cursors must equal 0000000000000001')
      }

      const outcomes: Array<{ ok: boolean, code?: string }> = []
      for (const result of [resultA, resultB]) {
        if (result.status === 'fulfilled') {
          outcomes.push({ ok: true })
        } else {
          const err = result.reason
          if (!(err instanceof P2pStagingError) || !ALLOWED_REJECTION_CODES.has(err.code)) {
            throw new Error(`F-1: untyped/unexpected rejection: ${String(err)}`)
          }
          outcomes.push({ ok: false, code: err.code })
        }
      }

      // Any requester whose submit rejected with 'rejected'/'cursor-exhausted' performs exactly
      // ONE identical re-submit (same init, same pre-resolved Signature), which must resolve.
      async function resubmitIfNeeded (idx: 0 | 1, submit: () => Promise<string>): Promise<void> {
        const o = outcomes[idx]!
        if (o.ok) return
        if (o.code !== 'rejected' && o.code !== 'cursor-exhausted') return // duplicate-request-id not expected here (distinct ids)
        await submit() // must resolve — an unhandled rejection here fails the test
      }
      await resubmitIfNeeded(0, submitA)
      await resubmitIfNeeded(1, submitB)

      await applyCursorRaceContract(network, 'RegistrationRequestStaging', network.hash)

      console.log(`P2P_RACE registration outcome=${outcomes.every((o) => o.ok) ? 'both-resolved' : `typed-reject-then-resubmit:${outcomes.find((o) => !o.ok)?.code}`} cursors=${cursorA},${cursorB}`)
    })
  })

  it('F-2 duplicate RequestId with different content across peers', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 30_000)
    await timed('F-2', async () => {
      const sharedId = `f2-dup-${runId.current}`
      let cursorA: string | undefined
      let cursorB: string | undefined

      const transportA = new P2pRegistrationTransport({
        openStrand: async () => createBarrierPort(await network.portA(), {
          table: 'RegistrationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorA = c }
        }) as unknown as import('../src/registration/transport/p2p-registration-transport.js').RegistrationStrandPort,
        computeDigest: regDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      })
      const transportB = new P2pRegistrationTransport({
        openStrand: async () => createBarrierPort(await network.portB(), {
          table: 'RegistrationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorB = c }
        }) as unknown as import('../src/registration/transport/p2p-registration-transport.js').RegistrationStrandPort,
        computeDigest: regDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbB), authorityId })
      })

      const signerA = makeRequesterSigner()
      const signerB = makeRequesterSigner()
      const initA = regMakeInit(authorityId, { id: sharedId })
      const initB = regMakeInit(authorityId, { id: sharedId, submittedAt: new Date(Date.now() + 1).toISOString() })
      const sigA = await signerA.sign(await regDigest(initA, signerA.publicHex))
      const sigB = await signerB.sign(await regDigest(initB, signerB.publicHex))

      const submitA = async (): Promise<string> => transportA.submitRequest(initA, signerA.publicHex, sigA)
      const submitB = async (): Promise<string> => transportB.submitRequest(initB, signerB.publicHex, sigB)
      const resA = await attemptSubmit(submitA)
      const resB = await attemptSubmit(submitB)

      expect(cursorA ?? cursorB, 'F-2: race was exercised').to.not.equal(undefined)

      await pollUntil(
        async () => {
          const a = await rawRows(network.dbA, 'RegistrationRequestStaging', network.hash)
          const b = await rawRows(network.dbB, 'RegistrationRequestStaging', network.hash)
          return { a: a.filter((r) => r.RequestId === sharedId), b: b.filter((r) => r.RequestId === sharedId) }
        },
        (v) => v.a.length === 1 && v.b.length === 1,
        { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'F-2: both nodes converge to exactly 1 row for the shared RequestId' }
      )
      const aRows = (await rawRows(network.dbA, 'RegistrationRequestStaging', network.hash)).filter((r) => r.RequestId === sharedId)
      const bRows = (await rawRows(network.dbB, 'RegistrationRequestStaging', network.hash)).filter((r) => r.RequestId === sharedId)
      expect(aRows).to.have.lengthOf(1)
      expect(bRows).to.have.lengthOf(1)
      expect(tupleKey(aRows[0]!)).to.equal(tupleKey(bRows[0]!))

      const survivorKey = aRows[0]!.RequesterKey
      const winnerIsA = survivorKey === signerA.publicHex
      const winnerIsB = survivorKey === signerB.publicHex
      expect(winnerIsA || winnerIsB, 'F-2: survivor carries one of the two requester keys').to.equal(true)

      const winnerResult = winnerIsA ? resA : resB
      const loserResult = winnerIsA ? resB : resA
      const winnerSubmit = winnerIsA ? submitA : submitB
      const loserSubmit = winnerIsA ? submitB : submitA

      let winnerFinal = winnerResult
      if (!winnerFinal.ok) {
        if (winnerFinal.code !== 'rejected' && winnerFinal.code !== 'cursor-exhausted') {
          throw new Error(`F-2: survivor's own result rejected with unexpected code ${winnerFinal.code}`)
        }
        const retried = await attemptSubmit(winnerSubmit)
        expect(retried.ok, 'F-2: survivor resolves after its one re-submit').to.equal(true)
        winnerFinal = retried
      }
      expect(winnerFinal.ok, 'F-2: the row survivor ended resolved').to.equal(true)

      let loserFinal = loserResult
      if (loserFinal.ok) {
        throw new Error('F-2: the losing requester must not have resolved — both resolving is a FAIL')
      }
      if (loserFinal.code !== 'duplicate-request-id') {
        const retried = await attemptSubmit(loserSubmit)
        expect(retried.ok, 'F-2: loser re-submit does not resolve').to.equal(false)
        if (!retried.ok) {
          expect(retried.code, "F-2: loser's re-submit settles to duplicate-request-id").to.equal('duplicate-request-id')
          loserFinal = retried
        }
      }
      expect((loserFinal as { ok: false, code: string }).code).to.equal('duplicate-request-id')

      console.log(`P2P_RACE duplicate-request-id outcome=${winnerIsA ? 'node-A' : 'node-B'}:${(loserFinal as { ok: false, code: string }).code}`)
    })
  })

  it('F-4 association request cursor race across peers', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 30_000)
    await timed('F-4', async () => {
      let cursorA: string | undefined
      let cursorB: string | undefined

      const transportA = new P2pAssociationTransport({
        openStrand: async () => createBarrierPort(await network.portA(), {
          table: 'AssociationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorA = c }
        }) as unknown as import('../src/association/transport/p2p-association-transport.js').AssociationStrandPort,
        computeDigest: assocRequestDigest,
        computeAttestationDigest: assocAttestationDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
      })
      const transportB = new P2pAssociationTransport({
        openStrand: async () => createBarrierPort(await network.portB(), {
          table: 'AssociationRequestStaging', parties: 2, timeoutMs: HARNESS_TIMEOUTS.writableMs, onInsert: (c) => { cursorB = c }
        }) as unknown as import('../src/association/transport/p2p-association-transport.js').AssociationStrandPort,
        computeDigest: assocRequestDigest,
        computeAttestationDigest: assocAttestationDigest,
        strandId: network.hash,
        sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbB), authorityId })
      })

      const signerA = makeRequesterSigner()
      const signerB = makeRequesterSigner()
      const initA = assocMakeInit(signerA.publicHex, authorityId, { id: `f4-race-a-${runId.current}` })
      const initB = assocMakeInit(signerB.publicHex, authorityId, { id: `f4-race-b-${runId.current}` })
      const sigA = await signerA.sign(await assocRequestDigest(initA, signerA.publicHex))
      const sigB = await signerB.sign(await assocRequestDigest(initB, signerB.publicHex))

      const submitA = async (): Promise<string> => transportA.submitRequest(initA, signerA.publicHex, sigA)
      const submitB = async (): Promise<string> => transportB.submitRequest(initB, signerB.publicHex, sigB)

      const [resultA, resultB] = await Promise.allSettled([submitA(), submitB()])

      if (cursorA !== '0000000000000001' || cursorB !== '0000000000000001') {
        throw new Error('race not exercised: both first-attempt cursors must equal 0000000000000001')
      }

      const outcomes: Array<{ ok: boolean, code?: string }> = []
      for (const result of [resultA, resultB]) {
        if (result.status === 'fulfilled') {
          outcomes.push({ ok: true })
        } else {
          const err = result.reason
          if (!(err instanceof P2pStagingError) || !ALLOWED_REJECTION_CODES.has(err.code)) {
            throw new Error(`F-4: untyped/unexpected rejection: ${String(err)}`)
          }
          outcomes.push({ ok: false, code: err.code })
        }
      }
      async function resubmitIfNeeded (idx: 0 | 1, submit: () => Promise<string>): Promise<void> {
        const o = outcomes[idx]!
        if (o.ok) return
        if (o.code !== 'rejected' && o.code !== 'cursor-exhausted') return
        await submit()
      }
      await resubmitIfNeeded(0, submitA)
      await resubmitIfNeeded(1, submitB)

      await applyCursorRaceContract(network, 'AssociationRequestStaging', network.hash)

      console.log(`P2P_RACE association outcome=${outcomes.every((o) => o.ok) ? 'both-resolved' : `typed-reject-then-resubmit:${outcomes.find((o) => !o.ok)?.code}`} cursors=${cursorA},${cursorB}`)
    })
  })

  it('P-OFFLINE partition probe (recorded, never asserted)', async function () {
    this.timeout(HARNESS_TIMEOUTS.replicationMs + 15_000)
    await timed('P-OFFLINE', async () => {
      try {
        const nodeA = network.harness.nodeA.node as { getControlNode?: () => { hangUp?: (peer: unknown) => Promise<void> } | null, peerId: unknown }
        const nodeB = network.harness.nodeB.node as { getControlNode?: () => { hangUp?: (peer: unknown) => Promise<void> } | null, peerId: unknown }
        const controlA = nodeA.getControlNode?.()
        const controlB = nodeB.getControlNode?.()
        if (controlA?.hangUp === undefined || controlB?.hangUp === undefined) {
          console.log('P2P_HARNESS_PROBE offline.disconnect=unavailable')
          return
        }

        await controlA.hangUp(nodeB.peerId)
        await controlB.hangUp(nodeA.peerId)
        console.log('P2P_HARNESS_PROBE offline.disconnect=hangUp')

        const signer = makeRequesterSigner()
        const init = regMakeInit(authorityId, { id: `poffline-${runId.current}` })
        const sig = await signer.sign(await regDigest(init, signer.publicHex))
        const transportB = new P2pRegistrationTransport({
          openStrand: network.portB,
          computeDigest: regDigest,
          strandId: network.hash,
          sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbB), authorityId })
        })

        let commitOutcome = 'timeout'
        try {
          await Promise.race([
            transportB.submitRequest(init, signer.publicHex, sig).then(() => { commitOutcome = 'committed' }),
            new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), HARNESS_TIMEOUTS.writableMs))
          ])
        } catch (err) {
          if (err instanceof P2pStagingError) {
            commitOutcome = `rejected:${err.code}`
          } else if (!(err instanceof Error) || err.message !== 'timeout') {
            commitOutcome = `rejected:${String(err)}`
          }
        }
        console.log(`P2P_HARNESS_PROBE offline.commitOutcome=${commitOutcome}`)

        if (commitOutcome === 'committed') {
          try {
            const transportA = new P2pRegistrationTransport({
              openStrand: network.portA,
              computeDigest: regDigest,
              strandId: network.hash,
              sealer: createIntakeSealer({ port: intakeQueryPortFromDb(network.dbA), authorityId })
            })
            const initA = regMakeInit(authorityId, { id: `poffline-a-${runId.current}` })
            await transportA.submitRequest(initA, signer.publicHex, sig)

            let mergeOutcome = 'no-remesh'
            await pollUntil(
              async () => {
                const a = await rawRows(network.dbA, 'RegistrationRequestStaging', network.hash)
                const b = await rawRows(network.dbB, 'RegistrationRequestStaging', network.hash)
                return { a, b }
              },
              (v) => {
                const aIds = new Set(v.a.map((r) => r.RequestId))
                const bIds = new Set(v.b.map((r) => r.RequestId))
                return aIds.has(init.id) && aIds.has(initA.id) && bIds.has(init.id) && bIds.has(initA.id)
              },
              { timeoutMs: HARNESS_TIMEOUTS.replicationMs, label: 'P-OFFLINE: re-mesh convergence' }
            ).then(() => {
              mergeOutcome = 'converged-distinct'
            }).catch(() => {
              mergeOutcome = 'lost-row'
            })
            console.log(`P2P_HARNESS_PROBE offline.mergeOutcome=${mergeOutcome}`)
          } catch (mergeErr) {
            console.log(`P2P_HARNESS_PROBE offline.mergeOutcome=error:${String(mergeErr)}`)
          }
        }
      } catch (probeErr) {
        console.log(`P2P_HARNESS_PROBE offline.disconnect=error:${String(probeErr)}`)
      }
    })
  })

  it('T-3 leg timing', function () {
    const loadavg = (globalThis as any).process?.loadavg?.() ?? []
    console.log('P2P_LEG_TIMING ' + JSON.stringify({ spec: 'staging-concurrency', runId: runId.current, legs: legTimings, loadavg }))
  })
})
