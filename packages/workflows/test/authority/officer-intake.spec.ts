// officer-intake.spec.ts: the five officer intake seams moved into @votetorrent/workflows (phase 67
// plan 09): the staging transports' shape, the association-sync ordering, the REQUIRED vault on all
// three seams (refusal before any engine read, transport build or signer call), the injected vault's
// identity reaching the intake opener, and the shared sources' purity. Every engine and vault here is
// a recording fake or an opaque marker: no key, share or signature value appears anywhere.
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { P2pAssociationTransport, P2pRegistrationTransport } from '@votetorrent/vote-engine/rn'
import type {
  AssociationStrandPort,
  IKeyVault,
  RegistrationStrandPort,
  StagingDecisionSigner,
  StagingOpener,
} from '@votetorrent/vote-engine/rn'
import type { Signature } from '@votetorrent/vote-core'
import {
  PeerReviewUnavailableError,
  createPeerStagingTransports,
  createPeerSyncBinding,
  enableOfficerEncryptedIntake,
  openPeerReviewSession,
  publishRegistrationDecisionAfterDecide,
  readOfficerIntakeKeyState,
  renewOfficerIntakeKeyAfterKeyReplacement,
  runAssociationSync,
} from '../../src/authority/officer.js'
import type {
  OfficerIntakeKeyDeps,
  PeerReviewDeps,
  PeerStagingTransports,
  PeerSyncBindingDeps,
} from '../../src/authority/officer.js'

const SHARED_FILES = [
  'sync-report.ts',
  'peer-staging-transports.ts',
  'attach-peer-sync-binding.ts',
  'officer-intake-key.ts',
  'continuity-review.ts',
]

function sharedSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/authority/${file}`, import.meta.url)), 'utf8')
}

/** A recording function: `calls` holds every argument list. */
function spy<A extends unknown[], R>(impl: (...args: A) => R): ((...args: A) => R) & { calls: A[] } {
  const calls: A[] = []
  const fn = (...args: A): R => {
    calls.push(args)
    return impl(...args)
  }
  return Object.assign(fn, { calls })
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

const vaultMarker = { __vault: 'marker' } as unknown as IKeyVault
const noVaultFn = undefined as unknown as () => IKeyVault
const noVault = undefined as unknown as IKeyVault
const openerMarker = { __opener: true } as unknown as StagingOpener
const neverSign = async (): Promise<Signature> => {
  throw new Error('never signs in this spec')
}
const createSignerFake = () => spy(async () => neverSign)

const emptyReport = { delivered: [] as never[], unreadable: [] as never[] }

function fakeTransports() {
  const registration = {
    readStagedRequestsReport: async () => emptyReport,
    publishDecision: spy(async (_d: unknown) => 'cid-1'),
    close: spy(async () => undefined),
  }
  const association = {
    readStagedRequestsReport: async () => emptyReport,
    readStagedAttestationsReport: async () => emptyReport,
    close: spy(async () => undefined),
  }
  const transports = { strandId: 'n1', registration, association }
  return { transports: transports as unknown as PeerStagingTransports, registration, association }
}

function fakeEngines() {
  const createOpener = spy((_vault: IKeyVault): StagingOpener => openerMarker)
  const registration = {
    getRegistrationRequest: async (_id: string) => undefined,
    submitRegistrationRequest: async () => 'id',
    listUnpublishedRegistrationDecisions: async () => [] as string[],
    publishRegistrationDecision: async () => ({}),
    completeDuplicateClosures: async () => ({ completed: [], failed: [] }),
  }
  const association = {
    getAssociationRequest: async (_id: string) => undefined,
    submitAssociationRequest: async () => 'id',
    submitAssociationAttestation: async () => undefined,
    processPendingAssociationRequests: async () => ({ challengesIssued: 0, associated: 0, rejected: 0 }),
    processPendingReassociations: async () => ({}),
  }
  const engines: Record<string, unknown> = { intake: { createOpener }, registration, association }
  let getEngineCalls = 0
  const getEngine = async <T>(name: string): Promise<T> => {
    getEngineCalls += 1
    return engines[name] as T
  }
  return { getEngine, createOpener, engines, calls: () => getEngineCalls }
}

describe('officer intake seams (@votetorrent/workflows/authority)', function () {
  this.timeout(20_000)

  it('I1 transports: createPeerStagingTransports builds both real transports without opening the strand', () => {
    const openStrand = spy(async () => ({}) as unknown as RegistrationStrandPort & AssociationStrandPort)
    const decisionSigner: StagingDecisionSigner = { authorityId: 'a1', sign: neverSign }
    const t = createPeerStagingTransports({ strandId: 'n1', openStrand, opener: openerMarker, decisionSigner })
    expect(t.strandId).to.equal('n1')
    expect(t.registration).to.be.instanceOf(P2pRegistrationTransport)
    expect(t.association).to.be.instanceOf(P2pAssociationTransport)
    expect(openStrand.calls.length).to.equal(0)
  })

  it('I2 association sync: both reads rejecting still drives processPending once; the predicate skips on true and attempts on throw', async () => {
    const processPending = spy(async () => undefined)
    const r = await runAssociationSync<{ id: string }, { id: string }>({
      readStagedRequests: async () => {
        throw new Error('read refused')
      },
      readStagedAttestations: async () => {
        throw new Error('read refused')
      },
      requestIdOf: (d) => d.id,
      attestationIdOf: (d) => d.id,
      submitRequest: async () => undefined,
      submitAttestation: async () => undefined,
      processPending,
    })
    expect(processPending.calls.length).to.equal(1)
    expect(r.imported).to.equal(0)
    expect(r.pending).to.equal(0)
    expect(r.errorItemIds).to.deep.equal([])

    const submitRequest = spy(async (_d: { id: string }) => undefined)
    const r2 = await runAssociationSync<{ id: string }, { id: string }>({
      readStagedRequests: async () => [{ id: 'skip-me' }, { id: 'throws' }],
      readStagedAttestations: async () => [],
      requestIdOf: (d) => d.id,
      attestationIdOf: (d) => d.id,
      submitRequest,
      submitAttestation: async () => undefined,
      processPending: async () => undefined,
      alreadyImportedRequest: async (d) => {
        if (d.id === 'throws') throw new Error('predicate broke')
        return true
      },
    })
    expect(submitRequest.calls.map((c) => c[0].id)).to.deep.equal(['throws'])
    expect(r2.imported).to.equal(1)
  })

  it('I3 peer binding requires the vault: construction refuses before any engine, transport or signer call', () => {
    const e = fakeEngines()
    const createTransports = spy(() => fakeTransports().transports)
    const createSigner = createSignerFake()
    let caught: unknown
    try {
      createPeerSyncBinding({ getEngine: e.getEngine, createTransports, createSigner, resolveVault: noVaultFn })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(TypeError)
    expect((caught as Error).message).to.include('resolveVault is required')
    expect(e.calls()).to.equal(0)
    expect(createTransports.calls.length).to.equal(0)
    expect(createSigner.calls.length).to.equal(0)
  })

  it('I4 peer binding uses the injected vault: the exact object reaches createOpener on syncNow and readCounts', async () => {
    const e = fakeEngines()
    const made: ReturnType<typeof fakeTransports>[] = []
    const createTransports = spy(() => {
      const t = fakeTransports()
      made.push(t)
      return t.transports
    })
    const createSigner = createSignerFake()
    const resolveVault = spy(() => vaultMarker)
    const deps: PeerSyncBindingDeps = { getEngine: e.getEngine, createTransports, createSigner, resolveVault }
    const binding = createPeerSyncBinding(deps)
    expect(binding.id).to.equal('peer')

    const report = await binding.syncNow({ authorityId: 'a1' })
    expect(e.createOpener.calls.length).to.equal(1)
    expect(e.createOpener.calls[0]?.[0]).to.equal(vaultMarker)
    expect(resolveVault.calls.length).to.equal(1)
    expect(createSigner.calls.length).to.equal(0)
    expect(made.length).to.equal(1)
    expect(made[0]?.registration.close.calls.length).to.equal(1)
    expect(made[0]?.association.close.calls.length).to.equal(1)
    expect(report.imported).to.equal(0)
    expect(report.errorItemIds).to.deep.equal([])

    const counts = await binding.readCounts({ authorityId: 'a1' })
    expect(e.createOpener.calls.length).to.equal(2)
    expect(e.createOpener.calls[1]?.[0]).to.equal(vaultMarker)
    expect(resolveVault.calls.length).to.equal(2)
    expect(counts).to.deep.equal({ pending: 0, synced: 0, failed: 0 })
    expect(made[1]?.registration.close.calls.length).to.equal(1)
    expect(made[1]?.association.close.calls.length).to.equal(1)
    expect(createSigner.calls.length).to.equal(0)
  })

  it('I5 intake key requires the vault: enable rejects, read reports unavailable, renew reports failed; the injected vault reaches the engine', async () => {
    const register = spy(async (_a: string, _v: IKeyVault, _s: unknown) => ({}) as unknown)
    const status = spy(async (_a: string, _v: IKeyVault) => ({ isIntakeRecipient: true }))
    const renew = spy(async (_v: IKeyVault, _s: unknown) => 'not-needed' as const)
    const intake = { registerOfficerEncryptionKey: register, getOfficerEncryptionKeyStatus: status, renewStrandedOfficerEncryptionKey: renew }
    let getEngineCalls = 0
    const getEngine = async <T>(_name: string): Promise<T> => {
      getEngineCalls += 1
      return intake as unknown as T
    }
    const createSigner = createSignerFake()

    const missing: OfficerIntakeKeyDeps = { getEngine, vault: noVault, createSigner }
    const err = await rejection(enableOfficerEncryptedIntake(missing, 'a1'))
    expect(err).to.be.instanceOf(TypeError)
    expect((err as Error).message).to.include('vault is required')
    expect(getEngineCalls).to.equal(0)
    expect(createSigner.calls.length).to.equal(0)
    expect(await readOfficerIntakeKeyState(missing, 'a1')).to.equal('unavailable')
    expect(await renewOfficerIntakeKeyAfterKeyReplacement(missing)).to.equal('failed')
    expect(createSigner.calls.length).to.equal(0)
    expect(register.calls.length).to.equal(0)
    expect(renew.calls.length).to.equal(0)

    const withVault: OfficerIntakeKeyDeps = { getEngine, vault: vaultMarker, createSigner }
    expect(await enableOfficerEncryptedIntake(withVault, 'a1')).to.equal('enabled')
    expect(register.calls.length).to.equal(1)
    expect(register.calls[0]?.[1]).to.equal(vaultMarker)
    expect(status.calls.length).to.equal(1)
    expect(status.calls[0]?.[1]).to.equal(vaultMarker)
    expect(createSigner.calls.length).to.equal(1)

    const superseded = {
      ...intake,
      registerOfficerEncryptionKey: async () => ({ superseded: true }),
    }
    const supersededDeps: OfficerIntakeKeyDeps = {
      getEngine: async <T>() => superseded as unknown as T,
      vault: vaultMarker,
      createSigner,
    }
    const sErr = await rejection(enableOfficerEncryptedIntake(supersededDeps, 'a1'))
    expect((sErr as { code?: unknown }).code).to.equal('intake-key-superseded')
  })

  it('I6 review requires the vault: no-transport-factory keeps precedence, a missing resolveVault refuses before the factory, the injected vault builds the opener', async () => {
    const e = fakeEngines()
    const sign = neverSign

    const noFactory = await rejection(openPeerReviewSession({ getEngine: e.getEngine, authorityId: 'a1', sign, resolveVault: () => vaultMarker }))
    expect(noFactory).to.be.instanceOf(PeerReviewUnavailableError)
    expect((noFactory as PeerReviewUnavailableError).reason).to.equal('no-transport-factory')

    const factory = spy((_d: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }) => fakeTransports().transports)
    const missing: PeerReviewDeps = {
      getEngine: e.getEngine,
      createPeerStagingTransports: factory,
      authorityId: 'a1',
      sign,
      resolveVault: noVaultFn,
    }
    const err = await rejection(openPeerReviewSession(missing))
    expect(err).to.be.instanceOf(TypeError)
    expect((err as Error).message).to.include('resolveVault is required')
    expect(factory.calls.length).to.equal(0)
    expect(e.calls()).to.equal(0)

    const publish = spy(async (_publisher: unknown, _id: string, _opts: unknown) => ({ published: true }) as unknown)
    e.engines.registration = {
      getRegistrationRequest: async () => ({ status: 'a' }),
      publishRegistrationDecision: publish,
    }
    const failed = await publishRegistrationDecisionAfterDecide(missing, 'r1', null)
    expect(failed).to.deep.equal({ kind: 'failed', code: 'unknown' })
    expect(factory.calls.length).to.equal(0)
    expect(publish.calls.length).to.equal(0)

    const made: ReturnType<typeof fakeTransports>[] = []
    const factory2 = spy((_d: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }) => {
      const t = fakeTransports()
      made.push(t)
      return t.transports
    })
    const resolveVault = spy(() => vaultMarker)
    const withVault: PeerReviewDeps = { ...missing, createPeerStagingTransports: factory2, resolveVault }
    const outcome = await publishRegistrationDecisionAfterDecide(withVault, 'r1', null)
    expect(outcome.kind).to.equal('published')
    expect(resolveVault.calls.length).to.equal(1)
    expect(e.createOpener.calls.length).to.equal(1)
    expect(e.createOpener.calls[0]?.[0]).to.equal(vaultMarker)
    expect(factory2.calls[0]?.[0].opener).to.equal(openerMarker)
    expect(publish.calls.length).to.equal(1)
    const publisher = publish.calls[0]?.[0] as { authorityId: string; publishDecision: (d: unknown) => Promise<string> }
    expect(publisher.authorityId).to.equal('a1')
    await publisher.publishDecision({ decision: 'marker' })
    expect(made[0]?.registration.publishDecision.calls.length).to.equal(1)
    expect(made[0]?.registration.close.calls.length).to.equal(1)
    expect(made[0]?.association.close.calls.length).to.equal(1)
  })

  it('I7 source purity: no shared officer file names the app vault, a test vault or an optional vault', () => {
    const forbidden = [
      'resolveAuthority' + 'KeyVault',
      'key-' + 'vault',
      'InMemoryTest' + 'KeyVault',
      'resolveVault' + '?:',
      'vault' + '?:',
    ]
    for (const file of SHARED_FILES) {
      const text = sharedSource(file)
      expect(text.length).to.be.greaterThan(0)
      for (const literal of forbidden) {
        expect(text.includes(literal), `${file} contains ${literal}`).to.equal(false)
      }
    }
  })
})
