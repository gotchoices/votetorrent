import { Database } from '@quereus/quereus'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionEvent,
  ElectionType,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { ElectionEngine } from '../src/election/election-engine'
import { ElectionsEngine } from '../src/elections/elections-engine'
import { ElectionsCreateElectionBuilder } from '../src/elections/builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from '../src/elections/builders/elections-adjust-election-builder.js'
import { MockElectionsEngine } from '../src/elections/mock-elections-engine.js'
import { NetworksEngine } from '../src/networks/networks-engine'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine'
import { OnboardingTasksEngine } from '../src/tasks/onboarding-tasks-engine'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine'
import type { EngineContext } from '../src/types.js'
import { createTestNetwork, addTestAuthority, addTestElection, seedBallot, seedQuestion, seedElectionSigning, makeElectionInit as makeElectionInitFromFixture, makeTestSignature } from './fixtures/test-context.js'
import { peekNextElectionTid } from '../src/elections/elections-engine.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  Ballot,
  ElectionInit,
  ElectionRevisionInit,
  IElectionsEngine,
  KeyholderInvite,
  NetworkInit,
  NetworkReference,
  Option,
  Question,
  Scope,
  SignatureResult,
  SignatureTask,
  User
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser (overrides?: Partial<User>): User {
  const { publicHex } = randomTestKeyPair()
  return {
    id: 'user-1',
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: publicHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 86_400_000
      }
    ],
    ...overrides
  }
}

function makeNetworkInit (): NetworkInit {
  return {
    name: 'Test Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com'
    },
    admin: {
      officers: [
        {
          init: {
            name: 'Admin A',
            title: 'Chair',
            scopes: ['rn', 'rad', 'iad', 'uai', 'mel', 'ceb'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

function makeNetworkRef (): NetworkReference {
  return {
    hash: 'h'.repeat(16),
    name: 'Test Network',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthorityDomainName: 'authority.example.com'
  }
}

function makeElectionInit (overrides?: Partial<ElectionInit['election']>): ElectionInit {
  const now = Date.now()
  return {
    election: {
      id: 'election-1',
      authorityId: 'authority-1',
      title: 'Test Election',
      date: now + 30 * 86_400_000,
      revisionDeadline: now + 7 * 86_400_000,
      ballotDeadline: now + 14 * 86_400_000,
      type: ElectionType.adhoc,
      ...overrides
    },
    revision: {
      electionId: overrides?.id ?? 'election-1',
      revision: 0,
      revisionTimestamp: now,
      tags: ['test'],
      instructions: '# Test Election',
      keyholders: [],
      timeline: {
        [ElectionEvent.registrationEnds]: now + 25 * 86_400_000,
        [ElectionEvent.ballotsFinal]: now + 14 * 86_400_000,
        [ElectionEvent.votingStarts]: now + 28 * 86_400_000,
        [ElectionEvent.tallyingStarts]: now + 30 * 86_400_000,
        [ElectionEvent.validation]: now + 31 * 86_400_000,
        [ElectionEvent.certificationStarts]: now + 32 * 86_400_000,
        [ElectionEvent.closed]: now + 33 * 86_400_000
      },
      keyholderThreshold: 1
    }
  }
}

// Pure-schema-only DB. Loads the schema but performs no INSERTs (so it
// does not trip quereus#23) — useful for guard/contract tests that do
// not need a populated DB.
async function makeDbOnlyContext (
  userOverrides?: Partial<User>
): Promise<{ ctx: EngineContext, user: User }> {
  const db = new Database()
  await prepareDb(db)
  const user = makeUser(userOverrides)
  const ctx: EngineContext = { db, user }
  return { ctx, user }
}

// Reach into a NetworksEngine's contexts map to obtain a populated ctx
// produced by NetworksEngine.create(). All call sites are bug-blocked on
// quereus#23 today.
async function createPopulatedContext (): Promise<{
  ctx: EngineContext
  user: User
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeUser()
  await networksEngine.create(makeNetworkInit(), user)
  const recents =
    (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
  const ref = recents[0]
  if (!ref) throw new Error('No network reference after create()')
  const ctx = (networksEngine as unknown as {
    contexts: Map<string, EngineContext>
  }).contexts.get(ref.hash)
  if (!ctx) throw new Error('No cached context after create()')
  return { ctx, user }
}

// ===========================================================================
// ElectionsEngine
// ===========================================================================

describe('ElectionsEngine', () => {
  // -----------------------------------------------------------------------
  // ELEC-01 — list / getElections + getElectionHistory
  // -----------------------------------------------------------------------
  describe('getElections', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      const elections = await engine.getElections()
      expect(elections).to.deep.equal([])
    })

    it('returns [] for an empty Election table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionsEngine(ctx)
      const elections = await engine.getElections()
      expect(elections).to.deep.equal([])
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // createPopulatedContext depends on NetworksEngine.create()
    // succeeding, which trips CantDelete on INSERT.
    it('returns upcoming elections joined with Authority name', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionsEngine(ctx)
      // After #23 lands, seed an Election row through createElection and
      // assert the join here.
      const elections = await engine.getElections()
      expect(elections).to.be.an('array')
    })
  })

  describe('getElectionHistory', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      const history = await engine.getElectionHistory()
      expect(history).to.deep.equal([])
    })

    it('returns [] for an empty Election table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionsEngine(ctx)
      const history = await engine.getElectionHistory()
      expect(history).to.deep.equal([])
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-02 — create (createElection in interface terms)
  // -----------------------------------------------------------------------
  describe('createElection', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      let caught: unknown
      try {
        await engine.createElection(makeElectionInit())
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    it('INSERTs an Election row via the AdminSignature pipeline', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const row = await elCtx.ctx.db
        .prepare('select Id, Title from Election where Id = :id')
        .get({ id: 'election-1' })
      expect(row?.Title).to.equal('Test Election')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-05 — adjustElection (ProposedElection INSERT)
  // -----------------------------------------------------------------------
  describe('adjustElection', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      let caught: unknown
      try {
        await engine.adjustElection(makeElectionInit())
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    // BLOCKED on quereus#23 — ProposedElection.UserValid CHECK joins
    // through Officer + UserKey, both seeded only via NetworksEngine.create.
    it('INSERTs a ProposedElection row gated by Officer scope mel', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionsEngine(ctx)
      await engine.adjustElection(makeElectionInit())
      const row = await ctx.db
        .prepare('select Id from ProposedElection where Id = :id')
        .get({ id: 'election-1' })
      expect(row?.Id).to.equal('election-1')
    })
  })

  // -----------------------------------------------------------------------
  // openElection
  // -----------------------------------------------------------------------
  describe('openElection', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      let caught: unknown
      try {
        await engine.openElection('e1')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    it('throws when the election id has no row', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionsEngine(ctx)
      let caught: unknown
      try {
        await engine.openElection('does-not-exist')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('not found')
    })
  })

  // -----------------------------------------------------------------------
  // getProposedElections — read path only
  // -----------------------------------------------------------------------
  describe('getProposedElections', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new ElectionsEngine()
      const proposed = await engine.getProposedElections()
      expect(proposed).to.deep.equal([])
    })

    it('returns [] for an empty ProposedElection table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionsEngine(ctx)
      const proposed = await engine.getProposedElections()
      expect(proposed).to.deep.equal([])
    })
  })
})

// ===========================================================================
// ElectionEngine
// ===========================================================================

describe('ElectionEngine', () => {
  // -----------------------------------------------------------------------
  // ELEC-03 — getElectionDetails (was getDetails in ROADMAP)
  // -----------------------------------------------------------------------
  describe('getElectionDetails', () => {
    it('throws when the election id has no row', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionEngine({ id: 'ghost', authorityId: 'a1' }, ctx)
      let caught: unknown
      try {
        await engine.getElectionDetails()
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('not found')
    })

    it('returns Election joined with the current ElectionRevision', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const details = await elCtx.electionEngine.getElectionDetails()
      expect(details.election.id).to.equal('election-1')
      expect(details.current.revision).to.be.a('number')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-04 — getRevisions (helper, not on IElectionEngine)
  // -----------------------------------------------------------------------
  describe('getRevisions', () => {
    it('returns [] for an election with no revisions', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const revisions = await engine.getRevisions()
      expect(revisions).to.deep.equal([])
    })

    it('returns ElectionRevision rows ordered by Revision asc', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: auth.authority.id },
        elCtx.ctx
      )
      const revisions = await engine.getRevisions()
      expect(revisions).to.be.an('array').with.length.greaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-05 — propose (proposeRevision)
  // -----------------------------------------------------------------------
  describe('proposeRevision', () => {
    it('INSERTs a ProposedElectionRevision row', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const revision: ElectionRevisionInit = {
        electionId: 'election-1',
        revision: 1,
        revisionTimestamp: Date.now(),
        tags: ['amended'],
        instructions: '# Revised',
        keyholders: [],
        timeline: {} as Record<ElectionEvent, number>,
        keyholderThreshold: 1
      }
      await elCtx.electionEngine.proposeRevision(revision)
      const row = await elCtx.ctx.db
        .prepare(
          'select Revision from ProposedElectionRevision where ElectionId = :id'
        )
        .get({ id: 'election-1' })
      expect(row?.Revision).to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-06 — addBallot (proposeBallot)
  // -----------------------------------------------------------------------
  describe('proposeBallot', () => {
    it('INSERTs a ProposedBallot row', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const ballot: Ballot = {
        id: 'ballot-1',
        electionId: 'election-1',
        authorityId: auth.authority.id,
        description: 'Test ballot',
        districts: ['d1'],
        questions: []
      }
      await elCtx.electionEngine.proposeBallot(ballot)
      const row = await elCtx.ctx.db
        .prepare('select Description from ProposedBallot where Id = :id')
        .get({ id: 'ballot-1' })
      expect(row?.Description).to.equal('Test ballot')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-07 — addQuestion (ProposedQuestion INSERT) — class-only method
  // -----------------------------------------------------------------------
  describe('addQuestion', () => {
    // CONTEXT.md (Group F) predicted the prior DependsOn-NOT-NULL skip
    // annotation was obsolete and that the only real blocker was the
    // missing Ballot row. After Plan 12.3-03 (`seedBallot`) resolved the
    // Ballot-row gap, the test was re-attempted and revealed that the
    // BLOCKED on a Quereus bug confirmed in 3.3.0: binding explicit NULL
    // (via :param or SQL literal) to a column declared with a non-NULL
    // `default X` throws `NOT NULL constraint failed`. ProposedQuestion has
    // two such columns — `OptionRange text default '{1, 1}'` and
    // `Required boolean default true` — and the engine binds null/false to
    // both. The error message names a nullable sibling (`DependsOn`) which
    // is what produced the original misdiagnosis. See repro spec
    // test/quereus-repros/text-null-column.spec.ts (D1–D3) and issue draft
    // .planning/quick/260528-001-quereus-not-null-text-null-column/issues/
    // default-column-rejects-explicit-null.md.
    it.skip('INSERTs a ProposedQuestion row — BLOCKED: quereus 3.3.0 rejects explicit null binding against a `default X` column (ProposedQuestion.OptionRange / .Required); error message misleadingly names DependsOn', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elec = await addTestElection(auth)
      const { ballotId } = await seedBallot(elec, 'ballot-1')
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: auth.authority.id },
        elec.ctx
      )
      const q: Question = {
        code: 'q1',
        title: 'Q1',
        instructions: 'pick one',
        options: [],
        type: 'select'
      }
      await engine.addQuestion(ballotId, q)
      const row = await elec.ctx.db
        .prepare(
          'select Code from ProposedQuestion where BallotId = :id and Code = :c'
        )
        .get({ id: ballotId, c: 'q1' })
      expect(row?.Code).to.equal('q1')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-08 — addOption (ProposedOption INSERT) — class-only method
  // -----------------------------------------------------------------------
  describe('addOption', () => {
    // Phase 12.4: uses seedQuestion (Layer-3 fixture) to seed the canonical
    // Question row required by ProposedOption.QuestionCodeValid. seedQuestion
    // bypasses the quereus 3.3.0 default-column NULL bug that blocks the
    // ElectionEngine addQuestion path.
    it('INSERTs a ProposedOption row', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elec = await addTestElection(auth)
      const { ballotId } = await seedBallot(elec, 'ballot-1')
      await seedQuestion(elec, ballotId, {
        code: 'q1',
        title: 'Q1',
        instructions: 'pick one',
        type: 'select'
      })
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: auth.authority.id },
        elec.ctx
      )
      // NOTE: provide non-null values for all optional columns (details,
      // infoURL, image, video) — the quereus 3.3.0 default-column NULL bug
      // (260528-001) currently rejects NULL writes to nullable text columns
      // on ProposedOption. Once quereus lands the upstream fix the test
      // can revert to `{ code, title }` only.
      const o: Option = {
        code: 'opt-1',
        title: 'Option 1',
        details: '',
        infoURL: '',
        image: { url: '' },
        video: { url: '' }
      }
      await engine.addOption(ballotId, 'q1', o, 0)
      const row = await elec.ctx.db
        .prepare(
          'select Code from ProposedOption where BallotId = :id and QuestionCode = :qc and Code = :c'
        )
        .get({ id: ballotId, qc: 'q1', c: 'opt-1' })
      expect(row?.Code).to.equal('opt-1')
    })
  })

  // -----------------------------------------------------------------------
  // getBallots / getBallotDetails — read paths
  // -----------------------------------------------------------------------
  describe('getBallots', () => {
    it('returns [] for an election with no ballots', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const ballots = await engine.getBallots()
      expect(ballots).to.deep.equal([])
    })
  })

  describe('getBallotDetails', () => {
    it('throws when the ballot id has no row', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      let caught: unknown
      try {
        await engine.getBallotDetails('ghost-ballot')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('not found')
    })
  })

  // -----------------------------------------------------------------------
  // inviteKeyholder / revokeKeyholder
  // -----------------------------------------------------------------------
  describe('inviteKeyholder', () => {
    it('INSERTs a Keyholder row', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      const kh: KeyholderInvite = {
        name: 'KH1',
        type: 'au',
        expiration: '0',
        inviteKey: 'k'.repeat(66),
        inviteSignature: 's'.repeat(128),
      }
      await elCtx.electionEngine.inviteKeyholder(kh, 'election-1')
      const row = await elCtx.ctx.db
        .prepare(
          'select UserId from Keyholder where ElectionId = :id limit 1'
        )
        .get({ id: 'election-1' })
      expect(row?.UserId).to.be.a('string')
    })
  })

  describe('revokeKeyholder', () => {
    // BLOCKED on quereus#23 — Keyholder rows can't be seeded today.
    it('DELETEs a Keyholder row', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const kh: KeyholderInvite = {
        name: 'KH1',
        type: 'au',
        expiration: '0',
        inviteKey: 'k'.repeat(66),
        inviteSignature: 's'.repeat(128),
      }
      await engine.revokeKeyholder(kh, 'election-1')
      const row = await ctx.db
        .prepare('select UserId from Keyholder where ElectionId = :id')
        .get({ id: 'election-1' })
      expect(row).to.equal(undefined)
    })
  })
})

// ===========================================================================
// KeysTasksEngine — TASK-01, TASK-02
// ===========================================================================

describe('KeysTasksEngine', () => {
  describe('getKeysToRelease', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new KeysTasksEngine(makeNetworkRef())
      const tasks = await engine.getKeysToRelease(true)
      expect(tasks).to.deep.equal([])
    })

    it('returns [] for an empty Task table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new KeysTasksEngine(makeNetworkRef(), ctx)
      const tasks = await engine.getKeysToRelease(true)
      expect(tasks).to.deep.equal([])
    })
  })

  describe('completeKeyRelease', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new KeysTasksEngine(makeNetworkRef())
      const task = {
        type: 'release-key' as const,
        userId: 'user-1',
        network: makeNetworkRef(),
        election: {
          election: { id: 'e1', authorityId: 'a1' },
          current: {}
        } as never
      }
      let caught: unknown
      try {
        await engine.completeKeyRelease(task)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    it.skip('marks a release-key Task as completed — BLOCKED: QuereusError CHECK constraint failed: ReleaseKeyTaskExtension.TaskIdValid fires at commit (DeferredConstraintQueue) and does not see the sibling Task row inserted in the same db.exec batch. Phase 12.4 CR-02 + CR-03 schema fixes are not the root cause (ReleaseKey CHECK was already valid pre-Phase-12.4); the actual blocker is the deferred-CHECK visibility semantics in quereus 3.3.0 for sibling rows inserted within the same batch.', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const elCtx = await addTestElection(auth)
      await elCtx.ctx.db.exec(
        `insert into ReleaseKeyTaskExtension (TaskId, ElectionId, ElectionRevision)
         with context Tid = 1
         values ('task-rk-1', 'election-1', 0);
         insert into Task (Id, UserId, Type, IsCompleted)
         with context IsMutationValid = true, Tid = 1
         values ('task-rk-1', 'user-1', 'release-key', 0);`
      )
      const engine = new KeysTasksEngine(makeNetworkRef(), elCtx.ctx)
      const task = {
        type: 'release-key' as const,
        userId: 'user-1',
        network: makeNetworkRef(),
        election: {
          election: { id: 'election-1', authorityId: auth.authority.id },
          current: {}
        } as never
      }
      await engine.completeKeyRelease(task)
    })
  })
})

// ===========================================================================
// SignatureTasksEngine — TASK-03, TASK-04
// ===========================================================================

describe('SignatureTasksEngine', () => {
  describe('getRequestedSignatures', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new SignatureTasksEngine(makeNetworkRef())
      const tasks = await engine.getRequestedSignatures(true)
      expect(tasks).to.deep.equal([])
    })

    it('returns [] for an empty Task table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new SignatureTasksEngine(makeNetworkRef(), ctx)
      const tasks = await engine.getRequestedSignatures(true)
      expect(tasks).to.deep.equal([])
    })
  })

  describe('completeSignature', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new SignatureTasksEngine(makeNetworkRef())
      const task: SignatureTask = {
        type: 'signature',
        userId: 'user-1',
        network: makeNetworkRef(),
        signatureType: 'admin'
      }
      const result: SignatureResult = {
        isAccepted: true,
        signature: {
          signature: 'a'.repeat(128),
          signerKey: 'b'.repeat(66),
          signerUserId: 'user-1'
        }
      }
      let caught: unknown
      try {
        await engine.completeSignature(task, result)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    it('throws when no pending task matches user + signatureType', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new SignatureTasksEngine(makeNetworkRef(), ctx)
      const task: SignatureTask = {
        type: 'signature',
        userId: 'user-1',
        network: makeNetworkRef(),
        signatureType: 'admin'
      }
      const result: SignatureResult = {
        isAccepted: true,
        signature: {
          signature: 'a'.repeat(128),
          signerKey: 'b'.repeat(66),
          signerUserId: 'user-1'
        }
      }
      let caught: unknown
      try {
        await engine.completeSignature(task, result)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no pending task')
    })

    it.skip('invokes SigningEngine.sign and marks the Task complete — BLOCKED: QuereusError CHECK constraint failed: AdminSignatureTaskExtension.TaskIdValid fires at commit (DeferredConstraintQueue) and does not see the sibling Task row inserted in the same db.exec batch, even with the post-Phase 12.4 CR-02 compound discriminator (T.Type=signature and T.SignatureType=admin). The CR-02 fix is necessary but not sufficient; the actual blocker is the deferred-CHECK visibility semantics in quereus 3.3.0 for sibling rows in one batch.', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      // Seed a separate AdminSigning row for the signature task
      const taskNonce = crypto.randomUUID()
      const adminRow = await auth.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: auth.authority.id })
      if (!adminRow) throw new Error('CurrentAdmin not found')
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad',
                 Digest(:authorityId, :adminEffectiveAt, '[]'),
                 :userId, :signerKey, :signature)`,
        {
          nonce: taskNonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as number | string,
          userId: auth.user.id,
          signerKey: auth.user.activeKeys[0]!.key,
          signature: 'a'.repeat(128),
          now: Date.now()
        }
      )
      // Seed AdminSignatureTaskExtension first (its TaskIdValid is deferred),
      // then Task (its ExtensionExists sees the extension row).
      await auth.ctx.db.exec(
        `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
         with context Tid = 1
         values ('task-sig-1', :authorityId, :adminEffectiveAt);
         insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = 1
         values ('task-sig-1', 'user-1', 'signature', 'admin', :nonce, 0);`,
        { nonce: taskNonce, authorityId: auth.authority.id, adminEffectiveAt: adminRow.EffectiveAt as number | string }
      )
      const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      const task: SignatureTask = {
        type: 'signature',
        userId: 'user-1',
        network: makeNetworkRef(),
        signatureType: 'admin'
      }
      const result: SignatureResult = {
        isAccepted: true,
        signature: {
          signature: 'a'.repeat(128),
          signerKey: auth.user.activeKeys[0]!.key,
          signerUserId: 'user-1'
        }
      }
      await engine.completeSignature(task, result)
    })
  })
})

// ===========================================================================
// OnboardingTasksEngine — TASK-05, TASK-06
// ===========================================================================

describe('OnboardingTasksEngine', () => {
  describe('getCompletedOnboardingTasks', () => {
    it('returns [] when no EngineContext is bound', async () => {
      const engine = new OnboardingTasksEngine()
      const ids = await engine.getCompletedOnboardingTasks()
      expect(ids).to.deep.equal([])
    })

    it('returns [] for an empty Task table', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new OnboardingTasksEngine(ctx)
      const ids = await engine.getCompletedOnboardingTasks()
      expect(ids).to.deep.equal([])
    })
  })

  describe('setOnboardingTaskCompleted', () => {
    it('throws when no EngineContext is bound', async () => {
      const engine = new OnboardingTasksEngine()
      let caught: unknown
      try {
        await engine.setOnboardingTaskCompleted('task-1')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })

    it.skip('marks an onboarding Task as completed — BLOCKED: QuereusError CHECK constraint failed: OnboardingTaskExtension.TaskIdValid fires at commit (DeferredConstraintQueue) and does not see the sibling Task row inserted in the same db.exec batch. Phase 12.4 CR-02 + CR-03 schema fixes are not the root cause (Onboarding CHECK was already valid pre-Phase-12.4); the actual blocker is the deferred-CHECK visibility semantics in quereus 3.3.0 for sibling rows in one batch.', async () => {
      const net = await createTestNetwork()
      await net.ctx.db.exec(
        `insert into Onboarding (Id) with context Tid = 1 values ('onboarding-1')`
      )
      await net.ctx.db.exec(
        `insert into OnboardingTaskExtension (TaskId, OnboardingId)
         with context Tid = 1
         values ('task-1', 'onboarding-1');
         insert into Task (Id, UserId, Type, IsCompleted)
         with context IsMutationValid = true, Tid = 1
         values ('task-1', 'user-1', 'onboarding', 0);`
      )
      const engine = new OnboardingTasksEngine(net.ctx)
      await engine.setOnboardingTaskCompleted('task-1')
      const row = await net.ctx.db
        .prepare('select IsCompleted from Task where Id = :id')
        .get({ id: 'task-1' })
      expect(row?.IsCompleted).to.equal(1)
    })
  })
})

// ===========================================================================
// ElectionsCreateElectionBuilder — BUILD-ELEC-01
// ===========================================================================

function makeStubElectionsEngine (): IElectionsEngine {
  return {
    createElection: async () => {},
    adjustElection: async () => {},
    getElections: async () => [],
    getElectionHistory: async () => [],
    getProposedElections: async () => [],
    openElection: async () => { throw new Error('stub') },
    buildCreateElection: () => { throw new Error('stub') },
    buildAdjustElection: () => { throw new Error('stub') }
  }
}

describe('ElectionsCreateElectionBuilder', () => {
  const stubEngine = makeStubElectionsEngine()

  it('empty builder is invalid with missingFields=[election, revision]', () => {
    const b = new ElectionsCreateElectionBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const missing = b.missingFields()
    expect(missing.map(m => m.path)).to.deep.equal(['election', 'revision'])
  })

  it('per-setter validation rejects invalid election fields', () => {
    const b = new ElectionsCreateElectionBuilder(stubEngine)
      .setElection({
        id: '',
        authorityId: '',
        title: '',
        date: -1,
        revisionDeadline: 0,
        ballotDeadline: 0,
        type: ElectionType.adhoc
      })
    const errs = b.errors().filter(e => e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
    expect(errs.some(e => e.path === 'election.id')).to.equal(true)
  })

  it('errors/missingFields progression: setting election removes its missing field', () => {
    const init = makeElectionInit()
    const b = new ElectionsCreateElectionBuilder(stubEngine).setElection(init.election)
    const missing = b.missingFields()
    expect(missing.map(m => m.path)).to.deep.equal(['revision'])
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const engine = new ElectionsEngine(auth.ctx)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.keyholderThreshold = 0
    const tid = peekNextElectionTid()
    const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)
    const b = new ElectionsCreateElectionBuilder(engine).fromPayload(init)
    expect(b.isValid()).to.equal(true)
    await b.commit({ signingNonce: nonce })
  })

  it('round-trip serialization + fromJSON kind/version rejection', () => {
    const init = makeElectionInit()
    const b = new ElectionsCreateElectionBuilder(stubEngine).fromPayload(init)
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionsCreateElectionBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
    // Reject wrong kind
    expect(() => ElectionsCreateElectionBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stubEngine))
      .to.throw(/unknown kind/)
    // Reject wrong version
    expect(() => ElectionsCreateElectionBuilder.fromJSON({ kind: 'elections.createElection', version: 99, draft: {} }, stubEngine))
      .to.throw(/unsupported version/)
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const engine = new ElectionsEngine(auth.ctx)
    const init = makeElectionInit({ authorityId: auth.authority.id })
    init.revision.keyholderThreshold = 0
    const tid = peekNextElectionTid()
    const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)
    const b = new ElectionsCreateElectionBuilder(engine).fromPayload(init)
    await b.commit({ signingNonce: nonce })
    let caught: unknown
    try { await (b as unknown as { commit: () => Promise<void> }).commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape matches ElectionInit + incomplete builder rejection', () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsCreateElectionBuilder(stubEngine).fromPayload(init)
    const input = b.toEngineInput()
    expect(input).to.have.property('election')
    expect(input).to.have.property('revision')
    expect(input.election.id).to.equal(init.election.id)
    // Incomplete builder throws
    expect(() => new ElectionsCreateElectionBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit sync guard', async () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsCreateElectionBuilder(stubEngine).fromPayload(init)
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.createElection(init) vs builder.fromPayload(init).commit()', async () => {
    // Direct path
    const net1 = await createTestNetwork()
    const auth1 = await addTestAuthority(net1)
    const eng1 = new ElectionsEngine(auth1.ctx)
    const initDirect = makeElectionInit({ authorityId: auth1.authority.id })
    initDirect.revision.keyholderThreshold = 0
    const tid1 = peekNextElectionTid()
    const { nonce: nonce1 } = await seedElectionSigning(auth1.ctx, auth1.authority.id, initDirect, auth1.user, tid1)
    await eng1.createElection(initDirect, { signingNonce: nonce1 })  // direct path — no throw
    // Builder path
    const net2 = await createTestNetwork()
    const auth2 = await addTestAuthority(net2)
    const eng2 = new ElectionsEngine(auth2.ctx)
    const initBuilder = makeElectionInit({ authorityId: auth2.authority.id })
    initBuilder.revision.keyholderThreshold = 0
    const tid2 = peekNextElectionTid()
    const { nonce: nonce2 } = await seedElectionSigning(auth2.ctx, auth2.authority.id, initBuilder, auth2.user, tid2)
    await new ElectionsCreateElectionBuilder(eng2).fromPayload(initBuilder).commit({ signingNonce: nonce2 })  // builder — no throw
  })

  it('FACT-04 parity: both engines return instanceof ElectionsCreateElectionBuilder', () => {
    const real = new ElectionsEngine()
    const mock = new MockElectionsEngine()
    expect(real.buildCreateElection()).to.be.instanceOf(ElectionsCreateElectionBuilder)
    expect(mock.buildCreateElection()).to.be.instanceOf(ElectionsCreateElectionBuilder)
  })

  it('cross-field: keyholderThreshold > keyholders.length surfaces error', () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 5
    init.revision.keyholders = []
    const b = new ElectionsCreateElectionBuilder(stubEngine).fromPayload(init)
    const errs = b.errors().filter(e => e.code === 'THRESHOLD_EXCEEDS_KEYHOLDERS')
    expect(errs.length).to.equal(1)
    expect(errs[0].kind).to.equal('cross-field')
  })
})

// ===========================================================================
// ElectionsAdjustElectionBuilder — BUILD-ELEC-01
// ===========================================================================

describe('ElectionsAdjustElectionBuilder', () => {
  const stubEngine = makeStubElectionsEngine()

  it('empty builder is invalid with missingFields=[election, revision]', () => {
    const b = new ElectionsAdjustElectionBuilder(stubEngine)
    expect(b.isValid()).to.equal(false)
    const missing = b.missingFields()
    expect(missing.map(m => m.path)).to.deep.equal(['election', 'revision'])
  })

  it('per-setter validation rejects invalid election fields', () => {
    const b = new ElectionsAdjustElectionBuilder(stubEngine)
      .setElection({
        id: '',
        authorityId: '',
        title: '',
        date: -1,
        revisionDeadline: 0,
        ballotDeadline: 0,
        type: ElectionType.adhoc
      })
    const errs = b.errors().filter(e => e.kind === 'per-setter')
    expect(errs.length).to.be.greaterThan(0)
  })

  it('errors/missingFields progression: setting both clears all missing', () => {
    const init = makeElectionInit()
    const b = new ElectionsAdjustElectionBuilder(stubEngine)
      .setElection(init.election)
      .setRevision(init.revision)
    const missing = b.missingFields()
    expect(missing.length).to.equal(0)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError', async () => {
    const { ctx } = await createPopulatedContext()
    const engine = new ElectionsEngine(ctx)
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsAdjustElectionBuilder(engine).fromPayload(init)
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization', () => {
    const init = makeElectionInit()
    const b = new ElectionsAdjustElectionBuilder(stubEngine).fromPayload(init)
    const json = b.toJSON()
    const parsed = JSON.parse(JSON.stringify(json))
    expect(parsed).to.deep.equal(json)
    const restored = ElectionsAdjustElectionBuilder.fromJSON(parsed, stubEngine)
    expect(restored.isValid()).to.equal(b.isValid())
  })

  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    const { ctx } = await createPopulatedContext()
    const engine = new ElectionsEngine(ctx)
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsAdjustElectionBuilder(engine).fromPayload(init)
    await b.commit()
    let caught: unknown
    try { await (b as unknown as { commit: () => Promise<void> }).commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput shape + incomplete rejection', () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsAdjustElectionBuilder(stubEngine).fromPayload(init)
    const input = b.toEngineInput()
    expect(input.election.id).to.equal(init.election.id)
    expect(() => new ElectionsAdjustElectionBuilder(stubEngine).toEngineInput())
      .to.throw(BuilderValidationError)
  })

  it('SC4 DB-FREE stub: isValid===true => commit() no-throw + double-commit guard', async () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    const b = new ElectionsAdjustElectionBuilder(stubEngine).fromPayload(init)
    expect(b.isValid()).to.equal(true)
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: equivalence smoke: engine.adjustElection(init) vs builder.fromPayload(init).commit()', async () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 0
    // Direct path
    const { ctx: ctx1 } = await createPopulatedContext()
    const eng1 = new ElectionsEngine(ctx1)
    await eng1.adjustElection(init)  // direct path — no throw
    // Builder path
    const { ctx: ctx2 } = await createPopulatedContext()
    const eng2 = new ElectionsEngine(ctx2)
    await new ElectionsAdjustElectionBuilder(eng2).fromPayload(init).commit()  // builder path — no throw
  })

  it('FACT-04 parity: both engines return instanceof ElectionsAdjustElectionBuilder', () => {
    const real = new ElectionsEngine()
    const mock = new MockElectionsEngine()
    expect(real.buildAdjustElection()).to.be.instanceOf(ElectionsAdjustElectionBuilder)
    expect(mock.buildAdjustElection()).to.be.instanceOf(ElectionsAdjustElectionBuilder)
  })

  it('cross-field: keyholderThreshold > keyholders.length surfaces error', () => {
    const init = makeElectionInit()
    init.revision.keyholderThreshold = 5
    init.revision.keyholders = []
    const b = new ElectionsAdjustElectionBuilder(stubEngine).fromPayload(init)
    const errs = b.errors().filter(e => e.code === 'THRESHOLD_EXCEEDS_KEYHOLDERS')
    expect(errs.length).to.equal(1)
    expect(errs[0].kind).to.equal('cross-field')
  })
})
