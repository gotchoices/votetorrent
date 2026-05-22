import { Database } from '@quereus/quereus'
import {
  ElectionEvent,
  ElectionType,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { ElectionEngine } from '../src/election/election-engine'
import { ElectionsEngine } from '../src/elections/elections-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine'
import { OnboardingTasksEngine } from '../src/tasks/onboarding-tasks-engine'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  Ballot,
  ElectionInit,
  ElectionRevisionInit,
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
    it.skip('returns upcoming elections joined with Authority name', async () => {
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

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // Election.InsertOnly (`check on update, delete (false)`) fires on
    // INSERT today, same chain as networks-engine.create().
    it.skip('INSERTs an Election row via the AdminSignature pipeline', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionsEngine(ctx)
      const init = makeElectionInit()
      await engine.createElection(init)
      const row = await ctx.db
        .prepare('select Id, Title from Election where Id = :id')
        .get({ ':id': init.election.id })
      expect(row?.Title).to.equal(init.election.title)
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
    it.skip('INSERTs a ProposedElection row gated by Officer scope mel', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionsEngine(ctx)
      await engine.adjustElection(makeElectionInit())
      const row = await ctx.db
        .prepare('select Id from ProposedElection where Id = :id')
        .get({ ':id': 'election-1' })
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

    // BLOCKED on quereus#23 — seeding Election + ElectionRevision
    // through createElection trips CantDelete on INSERT.
    it.skip('returns Election joined with the current ElectionRevision', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const details = await engine.getElectionDetails()
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

    // BLOCKED on quereus#23
    it.skip('returns ElectionRevision rows ordered by Revision asc', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const revisions = await engine.getRevisions()
      expect(revisions).to.be.an('array').with.length.greaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-05 — propose (proposeRevision)
  // -----------------------------------------------------------------------
  describe('proposeRevision', () => {
    // BLOCKED on quereus#23 — ProposedElectionRevision.UserValid CHECK
    // joins through Officer + UserKey + Election rows seeded by
    // NetworksEngine.create.
    it.skip('INSERTs a ProposedElectionRevision row', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
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
      await engine.proposeRevision(revision)
      const row = await ctx.db
        .prepare(
          'select Revision from ProposedElectionRevision where ElectionId = :id'
        )
        .get({ ':id': 'election-1' })
      expect(row?.Revision).to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-06 — addBallot (proposeBallot)
  // -----------------------------------------------------------------------
  describe('proposeBallot', () => {
    // BLOCKED on quereus#23 — ProposedBallot.UserValid joins through
    // Officer + UserKey + Election rows seeded by NetworksEngine.create.
    it.skip('INSERTs a ProposedBallot row', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const ballot: Ballot = {
        id: 'ballot-1',
        electionId: 'election-1',
        authorityId: 'authority-1',
        description: 'Test ballot',
        districts: ['d1'],
        questions: []
      }
      await engine.proposeBallot(ballot)
      const row = await ctx.db
        .prepare('select Description from ProposedBallot where Id = :id')
        .get({ ':id': 'ballot-1' })
      expect(row?.Description).to.equal('Test ballot')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-07 — addQuestion (ProposedQuestion INSERT) — class-only method
  // -----------------------------------------------------------------------
  describe('addQuestion', () => {
    // BLOCKED on https://github.com/gotchoices/quereus/issues/21 —
    // QuestionType view union-all returns only the first row ('select');
    // any value other than 'select' silently fails the TypeValid CHECK.
    // Also BLOCKED on quereus#23 transitively (UserValid joins through
    // tables seeded by NetworksEngine.create).
    it.skip('INSERTs a ProposedQuestion row with the QuestionType enum guard', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const q: Question = {
        code: 'q1',
        title: 'Q1',
        instructions: 'pick one',
        options: [],
        type: 'select'
      }
      await engine.addQuestion('ballot-1', q)
      const row = await ctx.db
        .prepare(
          'select Code from ProposedQuestion where BallotId = :id and Code = :c'
        )
        .get({ ':id': 'ballot-1', ':c': 'q1' })
      expect(row?.Code).to.equal('q1')
    })
  })

  // -----------------------------------------------------------------------
  // ELEC-08 — addOption (ProposedOption INSERT) — class-only method
  // -----------------------------------------------------------------------
  describe('addOption', () => {
    // BLOCKED on quereus#23 transitively.
    it.skip('INSERTs a ProposedOption row', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new ElectionEngine(
        { id: 'election-1', authorityId: 'authority-1' },
        ctx
      )
      const o: Option = { code: 'opt-1', title: 'Option 1' }
      await engine.addOption('ballot-1', 'q1', o, 0)
      const row = await ctx.db
        .prepare(
          'select Code from ProposedOption where BallotId = :id and QuestionCode = :qc and Code = :c'
        )
        .get({ ':id': 'ballot-1', ':qc': 'q1', ':c': 'opt-1' })
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
    // BLOCKED on quereus#23 — Keyholder.ElectionIdValid + ElectionRevisionValid
    // depend on Election + ElectionRevision rows that today require #23.
    it.skip('INSERTs a Keyholder row pinned to the election + revision', async () => {
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
        digest: 'd'.repeat(64)
      }
      await engine.inviteKeyholder(kh, 'election-1')
      const row = await ctx.db
        .prepare(
          'select UserId from Keyholder where ElectionId = :id limit 1'
        )
        .get({ ':id': 'election-1' })
      expect(row?.UserId).to.be.a('string')
    })
  })

  describe('revokeKeyholder', () => {
    // BLOCKED on quereus#23 — Keyholder rows can't be seeded today.
    it.skip('DELETEs a Keyholder row', async () => {
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
        digest: 'd'.repeat(64)
      }
      await engine.revokeKeyholder(kh, 'election-1')
      const row = await ctx.db
        .prepare('select UserId from Keyholder where ElectionId = :id')
        .get({ ':id': 'election-1' })
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

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 — the
    // UPDATE Task path trips Task.MutationValid which requires an
    // AdminSignature row seeded via the same pipeline that fails on
    // INSERT today.
    it.skip('marks a release-key Task as completed', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new KeysTasksEngine(makeNetworkRef(), ctx)
      const task = {
        type: 'release-key' as const,
        userId: 'user-1',
        network: makeNetworkRef(),
        election: {
          election: { id: 'election-1', authorityId: 'authority-1' },
          current: {}
        } as never
      }
      await engine.completeKeyRelease(task)
      const row = await ctx.db
        .prepare(
          `select IsCompleted from Task T join ReleaseKeyTaskExtension R on R.TaskId = T.Id
            where T.UserId = :userId and R.ElectionId = :electionId`
        )
        .get({ ':userId': 'user-1', ':electionId': 'election-1' })
      expect(row?.IsCompleted).to.equal(1)
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

    // BLOCKED on quereus#23 — SigningEngine.sign() + UPDATE Task
    // pipeline depends on seeded AdminSigning + Task rows.
    it.skip('invokes SigningEngine.sign and marks the Task complete', async () => {
      const { ctx } = await createPopulatedContext()
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

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // Task.MutationValid on update needs the AdminSignature pipeline.
    it.skip('marks an onboarding Task as completed', async () => {
      const { ctx } = await createPopulatedContext()
      const engine = new OnboardingTasksEngine(ctx)
      await engine.setOnboardingTaskCompleted('task-1')
      const row = await ctx.db
        .prepare('select IsCompleted from Task where Id = :id')
        .get({ ':id': 'task-1' })
      expect(row?.IsCompleted).to.equal(1)
    })
  })
})
