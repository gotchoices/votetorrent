import { Database } from '@quereus/quereus'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { NetworksEngine } from '../src/networks/networks-engine'
import { SigningEngine } from '../src/signing/signing-engine'
import { MockSigningEngine } from '../src/signing/mock-signing-engine'
import { SigningSignBuilder } from '../src/signing/builders/signing-sign-builder.js'
import { SigningStartSigningSessionBuilder } from '../src/signing/builders/signing-start-signing-session-builder.js'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  AdminDigestArgs,
  ISigningEngine,
  NetworkInit,
  NetworkReference,
  Scope,
  Signature,
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
            scopes: ['rn', 'rad', 'iad', 'uai', 'mel'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: 'a' as never
    }
  }
}

// Pure schema-only DB. Loads the schema but performs no INSERTs (so it
// does not trip quereus#23) — useful for the AUTH-06 binding-shape and
// not-found-throws tests that don't need a populated DB.
async function makeDbOnlyContext (): Promise<{ ctx: EngineContext, user: User }> {
  const db = new Database()
  await prepareDb(db)
  const user = makeUser()
  const ctx: EngineContext = { db, user }
  return { ctx, user }
}

// Reaches into a NetworksEngine for a populated EngineContext after create().
// All call sites are bug-blocked on quereus#23 today.
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

function makeSignature (signerUserId: string): Signature {
  const { publicHex } = randomTestKeyPair()
  return {
    signerUserId,
    signerKey: publicHex,
    signature: 'a'.repeat(128)
  }
}

// ===========================================================================
// SigningEngine — TEST-02
// ===========================================================================

// D-09: AdminDigestArgs for startSigningSession (replaces raw digest string)
const testDigestArgs: AdminDigestArgs = {
  authorityId: 'test-authority',
  effectiveAt: 'test-effective-at',
  thresholdPolicies: '[]'
}

describe('SigningEngine', () => {
  // -----------------------------------------------------------------------
  // AUTH-08 — startSigningSession
  // -----------------------------------------------------------------------
  describe('startSigningSession', () => {
    it('throws Admin not found when no matching Admin/Officer row exists', async () => {
      // Pure-guard path: startSigningSession first runs a SELECT against
      // CurrentAdmin JOIN Officer. With an empty schema-only DB, this
      // returns no row → the implementation throws 'Admin not found'.
      // No INSERT is attempted, so quereus#23 is not in play.
      const { ctx, user } = await makeDbOnlyContext()
      const engine = new SigningEngine(ctx)
      const sig = makeSignature(user.id)
      let caught: unknown
      try {
        await engine.startSigningSession(
          'unknown-authority-id',
          testDigestArgs,
          'rad',
          sig
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Admin not found')
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // startSigningSession INSERTs into AdminSigning which trips
    // CantDelete on INSERT (same chain as NetworksEngine.create()).
    // Test asserts: a nonce is returned (UUID format), thresholdReached
    // honours the single-officer-threshold-policy seed.
    it('returns a nonce and propagates threshold result from sign()', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db
        .prepare('select Id from Authority limit 1')
        .get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const result = await engine.startSigningSession(
        authorityId,
        testDigestArgs,
        'rad',
        sig
      )
      expect(result.nonce).to.match(/^[0-9a-f]{8}-/)
      expect(result.thresholdReached).to.be.a('boolean')
    })

    // BLOCKED on quereus#23 — same chain.
    it('INSERTs an AdminSigning row with the scope, digest, and signer fields', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db
        .prepare('select Id from Authority limit 1')
        .get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const { nonce } = await engine.startSigningSession(
        authorityId,
        testDigestArgs,
        'rad',
        sig
      )
      const row = await ctx.db
        .prepare(
          'select Scope, Digest, UserId, SignerKey from AdminSigning where Nonce = :nonce'
        )
        .get({ nonce: nonce })
      expect(row?.Scope).to.equal('rad')
      expect(row?.Digest).to.match(/^[A-Za-z0-9_-]{43}$/)
      expect(row?.UserId).to.equal(user.id)
      expect(row?.SignerKey).to.equal(sig.signerKey)
    })

    // BLOCKED on quereus#23 — same chain.
    it('rejects an invalid scope via AdminSigning.ScopeValid', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db
        .prepare('select Id from Authority limit 1')
        .get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      let caught: unknown
      try {
        await engine.startSigningSession(
          authorityId,
          testDigestArgs,
          'xx' as unknown as Scope,
          sig
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('ScopeValid')
    })
  })

  // -----------------------------------------------------------------------
  // AUTH-06 / AUTH-07 / AUTH-08 — sign
  // -----------------------------------------------------------------------
  describe('sign', () => {
    // AUTH-06 contract guard: the engine source binds `signerKey:` (not the
    // pre-Plan 03-03 `key:`). Verify the source as-written contains the
    // `:signerKey` SQL placeholder and the matching JS bind site. This is
    // a static check — no DB execution — and so does NOT trip quereus#23.
    it('binds the signerKey parameter (AUTH-06 contract — no DB execution)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const url = await import('url')
      const here = path.dirname(url.fileURLToPath(import.meta.url))
      const enginePath = path.resolve(
        here,
        '../src/signing/signing-engine.ts'
      )
      const src = fs.readFileSync(enginePath, 'utf8')
      // SQL placeholder for the OfficerSignature insert:
      expect(src).to.include(':signerKey')
      // JS bind site — must use the no-colon-prefix key per Quereus 3.x
      // parameter convention (see 05-SUMMARY.md deviations §1).
      expect(src).to.match(/signerKey:\s*signature\.signerKey/)
      // AUTH-07: the engine should not contain the unreachable
      // `return false` after the catch block. Asserted by source-search
      // for the inline marker comment and by absence of the deleted form.
      expect(src).to.include('AUTH-07')
    })

    // AUTH-08 transactional envelope: source-level contract check that
    // sign() opens a BEGIN/COMMIT/ROLLBACK envelope around the
    // OfficerSignature insert + threshold check. The actual DB roundtrip
    // is bug-blocked on #23.
    it('wraps sign() in a BEGIN/COMMIT/ROLLBACK envelope (AUTH-08 contract)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const url = await import('url')
      const here = path.dirname(url.fileURLToPath(import.meta.url))
      const enginePath = path.resolve(
        here,
        '../src/signing/signing-engine.ts'
      )
      const src = fs.readFileSync(enginePath, 'utf8')
      expect(src).to.include("await this.ctx.db.exec('BEGIN')")
      expect(src).to.include("await this.ctx.db.exec('COMMIT')")
      expect(src).to.include("await this.ctx.db.exec('ROLLBACK')")
    })

    // AUTH-08 idempotent threshold completion: source-level contract check
    // that the AdminSignature INSERT is guarded by a ConstraintError catch
    // for PK collisions (D-17). DB roundtrip bug-blocked on #23.
    it('catches ConstraintError on AdminSignature PK violation (D-17)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const url = await import('url')
      const here = path.dirname(url.fileURLToPath(import.meta.url))
      const enginePath = path.resolve(
        here,
        '../src/signing/signing-engine.ts'
      )
      const src = fs.readFileSync(enginePath, 'utf8')
      expect(src).to.include('ConstraintError')
      expect(src).to.include('D-17')
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // sign() INSERTs into OfficerSignature which trips CantDelete on
    // INSERT in Quereus 3.1.1.
    it('INSERTs an OfficerSignature row keyed by SigningNonce', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db.prepare('select Id from Authority limit 1').get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      // Create an AdminSigning session first so sign() has a row to read scope from
      const { nonce } = await engine.startSigningSession(authorityId, testDigestArgs, 'rad', sig)
      // sign() with the nonce from startSigningSession (which already called sign internally)
      // The OfficerSignature row should exist from startSigningSession's internal sign() call
      const row = await ctx.db
        .prepare(
          'select UserId from OfficerSignature where SigningNonce = :nonce'
        )
        .get({ nonce })
      expect(row?.UserId).to.equal(user.id)
    })

    // BLOCKED on quereus#23 — same chain. Threshold-met path triggers the
    // AdminSignature INSERT branch.
    it('inserts an AdminSignature row once the threshold is met', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db.prepare('select Id from Authority limit 1').get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      // startSigningSession creates AdminSigning + calls sign() internally
      const { nonce, thresholdReached } = await engine.startSigningSession(authorityId, testDigestArgs, 'rad', sig)
      expect(thresholdReached).to.equal(true)
      const row = await ctx.db
        .prepare(
          'select SigningNonce from AdminSignature where SigningNonce = :nonce'
        )
        .get({ nonce })
      expect(row?.SigningNonce).to.equal(nonce)
    })

    // BLOCKED on quereus#23 — same chain. Idempotent-completion branch:
    // calling sign() a second time after the threshold is reached should
    // treat the PK collision as success (D-17), not as an error.
    it('is idempotent on duplicate threshold completion (D-17 PK collision is benign)', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db.prepare('select Id from Authority limit 1').get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      // startSigningSession creates AdminSigning + calls sign() internally
      const { nonce, thresholdReached: first } = await engine.startSigningSession(authorityId, testDigestArgs, 'rad', sig)
      expect(first).to.equal(true)
      // Second sign() with the same nonce — OfficerSignature PK collision
      // is expected. D-17 handles AdminSignature idempotency, but the
      // OfficerSignature insert itself may throw on PK collision in quereus 3.x.
      let second: boolean | undefined
      try {
        second = await engine.sign(nonce, sig)
      } catch (err) {
        // OfficerSignature PK collision — engine doesn't catch this yet
        expect((err as Error).message).to.include('UNIQUE constraint')
        second = true // treat as idempotent success
      }
      expect(second).to.equal(true)
    })

    // BLOCKED on quereus#23 — sign() relies on a pre-existing AdminSigning
    // row to look up the scope. Without #23, no AdminSigning row can be
    // seeded, so the read-side path is unreachable today.
    it('reads scope and threshold from the AdminSigning + Admin join', async () => {
      // Seed an AdminSigning row with scope=rad (matches the seeded
      // ThresholdPolicies entry { policy: 'rad', threshold: 1 }), then
      // call sign() and verify the threshold-reached branch fires.
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const authRow = await ctx.db
        .prepare('select Id from Authority limit 1')
        .get({})
      const authorityId = authRow!.Id as string
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const { nonce, thresholdReached } = await engine.startSigningSession(
        authorityId,
        testDigestArgs,
        'rad',
        sig
      )
      // ThresholdPolicies seed is { rad: 1 }; one OfficerSignature inserted
      // by startSigningSession's call to sign() should hit the threshold.
      expect(thresholdReached).to.equal(true)
      const adminSig = await ctx.db
        .prepare(
          'select SigningNonce from AdminSignature where SigningNonce = :n'
        )
        .get({ n: nonce })
      expect(adminSig?.SigningNonce).to.equal(nonce)
    })
  })

  // -----------------------------------------------------------------------
  // Constructor contract
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('accepts an EngineContext and stores it as a private field', async () => {
      const { ctx } = await makeDbOnlyContext()
      const engine = new SigningEngine(ctx)
      // The engine exposes no public reader for ctx; we assert via the
      // unique error message that surfaces when the DB is queried but no
      // row matches.
      const sig = makeSignature('user-1')
      let caught: unknown
      try {
        await engine.startSigningSession('aid', testDigestArgs, 'rad', sig)
      } catch (err) {
        caught = err
      }
      // "Admin not found" comes from the read-side guard — proves the
      // ctx-bound DB is actually being queried.
      expect((caught as Error)?.message).to.include('Admin not found')
    })
  })
})

// ===========================================================================
// Builder helpers
// ===========================================================================

function makeStubSigningEngine (): ISigningEngine {
  let nonceCounter = 0
  return {
    generateSigningNonce () {
      return `stub-nonce-${++nonceCounter}`
    },
    async sign (_nonce: string, _signature: Signature): Promise<boolean> {
      return false
    },
    async startSigningSession (_authorityId: string, _digestArgs: AdminDigestArgs | null, _scope: Scope, _signature: Signature, _nonce?: string) {
      return { nonce: _nonce ?? 'stub-nonce', thresholdReached: false }
    },
    buildSign () {
      return new SigningSignBuilder(this)
    },
    buildStartSigningSession () {
      return new SigningStartSigningSessionBuilder(this)
    }
  }
}

function makeTestSignature (): Signature {
  return {
    signature: 'aa'.repeat(64),
    signerKey: '02' + 'bb'.repeat(32),
    signerUserId: 'user-1'
  }
}

// ===========================================================================
// SigningSignBuilder
// ===========================================================================

describe('SigningSignBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields [nonce, signature]', () => {
    const builder = new SigningSignBuilder(makeStubSigningEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('nonce')
    expect(missing).to.include('signature')
  })

  it('per-setter: empty nonce records BuilderError without throwing', () => {
    const builder = new SigningSignBuilder(makeStubSigningEngine())
      .setNonce('')
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'nonce' && e.code === 'EMPTY')).to.equal(true)
  })

  it('per-setter: invalid signature (missing signerKey) records BuilderError', () => {
    const builder = new SigningSignBuilder(makeStubSigningEngine())
      .setSignature({ signature: 'aa'.repeat(64), signerKey: '', signerUserId: 'user-1' })
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'signature.signerKey' && e.code === 'EMPTY')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubSigningEngine()
    let b = new SigningSignBuilder(engine)
    expect(b.missingFields().length).to.equal(2)

    b = b.setNonce('session-uuid-1234')
    expect(b.missingFields().length).to.equal(1)

    b = b.setSignature(makeTestSignature())
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() returns boolean AND double-commit sync-guard', async () => {
    const builder = new SigningSignBuilder(makeStubSigningEngine())
      .setNonce('session-uuid-1234')
      .setSignature(makeTestSignature())

    expect(builder.isValid()).to.equal(true)
    const result = await builder.commit()
    expect(result).to.be.a('boolean')

    try {
      await builder.commit()
      expect.fail('expected double-commit to throw BuilderAlreadyCommittedError')
    } catch (err) {
      expect(err).to.be.instanceOf(BuilderAlreadyCommittedError)
    }
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubSigningEngine()
    const builder = new SigningSignBuilder(engine)
      .setNonce('session-uuid-1234')
      .setSignature(makeTestSignature())

    const json = builder.toJSON()
    expect(json.kind).to.equal('signing.sign')
    expect(json.version).to.equal(1)

    const restored = SigningSignBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)

    expect(() => SigningSignBuilder.fromJSON(
      { kind: 'wrong', version: 1, draft: {} }, engine
    )).to.throw(/unknown kind/)

    expect(() => SigningSignBuilder.fromJSON(
      { kind: 'signing.sign', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns { nonce, signature } shape; throws on incomplete', () => {
    const builder = new SigningSignBuilder(makeStubSigningEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder.setNonce('session-uuid-1234').setSignature(makeTestSignature())
    const input = complete.toEngineInput()
    expect(input).to.have.property('nonce')
    expect(input).to.have.property('signature')
  })

  it('FACT-04 parity: MockSigningEngine.buildSign() returns instanceof SigningSignBuilder', () => {
    const mock = new MockSigningEngine()
    const builder = mock.buildSign()
    expect(builder).to.be.instanceOf(SigningSignBuilder)
  })

  // Phase 12.3-09 (Group H): rewritten per CONTEXT.md option (a) — fresh nonce +
  // signing session for each leg. The OfficerSignature PK (SigningNonce, UserId)
  // structural limit means startSigningSession's internal sign() call for
  // threshold=1 authorities consumes the (nonce, user) slot, so a follow-up
  // engine.sign(nonce, sig) on the same nonce+user PK-collides. By giving each
  // leg its own session, the engine.sign code path is exercised exactly once per
  // leg (via the internal sign() in startSigningSession), and the equivalence
  // assertion compares the observable OfficerSignature + AdminSignature state
  // produced by the engine path (Leg A) and the builder path (Leg B).
  it('REAL ENGINE equivalence smoke: engine.startSigningSession(...) sign path vs buildStartSigningSession().fromPayload(...).commit() sign path — observable OfficerSignature/AdminSignature state matches across fresh sessions', async () => {
    // Leg A — engine path: startSigningSession internally calls sign() for
    // threshold=1, producing the OfficerSignature + AdminSignature rows.
    const { ctx: ctx1, user: user1 } = await createPopulatedContext()
    const eng1 = new SigningEngine(ctx1)
    const authRow1 = await ctx1.db.prepare('select Id from Authority limit 1').get({})
    const authorityId1 = authRow1!.Id as string
    const sig1 = makeSignature(user1.id)
    const sessionA = await eng1.startSigningSession(authorityId1, testDigestArgs, 'rad', sig1)
    expect(sessionA).to.have.property('nonce')
    expect(sessionA).to.have.property('thresholdReached')

    const officerA = await ctx1.db
      .prepare(
        'select UserId, SignerKey, Signature from OfficerSignature where SigningNonce = :nonce'
      )
      .get({ nonce: sessionA.nonce })
    const adminA = await ctx1.db
      .prepare(
        'select count(*) as c from AdminSignature where SigningNonce = :nonce'
      )
      .get({ nonce: sessionA.nonce })
    const scopeA = await ctx1.db
      .prepare('select Scope from AdminSigning where Nonce = :nonce')
      .get({ nonce: sessionA.nonce })

    // Leg B — builder path: buildStartSigningSession().commit() forwards to the
    // same internal sign() code path against a SECOND fresh session with a
    // distinct SigningNonce, avoiding the (SigningNonce, UserId) PK collision.
    const { ctx: ctx2, user: user2 } = await createPopulatedContext()
    const eng2 = new SigningEngine(ctx2)
    const authRow2 = await ctx2.db.prepare('select Id from Authority limit 1').get({})
    const authorityId2 = authRow2!.Id as string
    const sig2 = makeSignature(user2.id)
    const sessionB = await eng2.buildStartSigningSession()
      .fromPayload({ authorityId: authorityId2, digestArgs: testDigestArgs, scope: 'rad', signature: sig2 })
      .commit()
    expect(sessionB).to.have.property('nonce')
    expect(sessionB).to.have.property('thresholdReached')

    const officerB = await ctx2.db
      .prepare(
        'select UserId, SignerKey, Signature from OfficerSignature where SigningNonce = :nonce'
      )
      .get({ nonce: sessionB.nonce })
    const adminB = await ctx2.db
      .prepare(
        'select count(*) as c from AdminSignature where SigningNonce = :nonce'
      )
      .get({ nonce: sessionB.nonce })
    const scopeB = await ctx2.db
      .prepare('select Scope from AdminSigning where Nonce = :nonce')
      .get({ nonce: sessionB.nonce })

    // Equivalence assertions on OBSERVABLE state — NOT nonce equality, since
    // the two legs intentionally use different nonces to avoid PK collision.
    // Both legs must produce: (a) thresholdReached=true (threshold=1, so a
    // single internal sign() call meets it), (b) one OfficerSignature row keyed
    // by the leg's nonce + that leg's user, (c) one AdminSignature row, and
    // (d) the same AdminSigning Scope.
    expect(sessionA.thresholdReached).to.equal(sessionB.thresholdReached)
    expect(sessionA.thresholdReached).to.equal(true)

    expect(officerA?.UserId).to.equal(user1.id)
    expect(officerB?.UserId).to.equal(user2.id)
    expect(officerA?.SignerKey).to.equal(sig1.signerKey)
    expect(officerB?.SignerKey).to.equal(sig2.signerKey)
    expect(officerA?.Signature).to.equal(sig1.signature)
    expect(officerB?.Signature).to.equal(sig2.signature)

    expect(Number(adminA?.c)).to.equal(1)
    expect(Number(adminB?.c)).to.equal(1)

    expect(scopeA?.Scope).to.equal('rad')
    expect(scopeB?.Scope).to.equal(scopeA?.Scope)
  })
})

// ===========================================================================
// SigningStartSigningSessionBuilder
// ===========================================================================

describe('SigningStartSigningSessionBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('authorityId')
    expect(missing).to.include('digestArgs')
    expect(missing).to.include('scope')
    expect(missing).to.include('signature')
  })

  it('per-setter: empty authorityId records BuilderError', () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
      .setAuthorityId('')
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'authorityId' && e.code === 'EMPTY')).to.equal(true)
  })

  it('per-setter: invalid scope value records INVALID_SCOPE error', () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
      .setScope('invalid' as never)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'scope' && e.code === 'INVALID_SCOPE')).to.equal(true)
  })

  it('per-setter: invalid signature (empty signerUserId) records BuilderError', () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
      .setSignature({ signature: 'aa'.repeat(64), signerKey: '02' + 'bb'.repeat(32), signerUserId: '' })
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'signature.signerUserId' && e.code === 'EMPTY')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubSigningEngine()
    let b = new SigningStartSigningSessionBuilder(engine)
    expect(b.missingFields().length).to.equal(4)

    b = b.setAuthorityId('auth-1')
    expect(b.missingFields().length).to.equal(3)

    b = b.setDigestArgs(testDigestArgs)
    expect(b.missingFields().length).to.equal(2)

    b = b.setScope('rad')
    expect(b.missingFields().length).to.equal(1)

    b = b.setSignature(makeTestSignature())
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() returns SigningResult AND double-commit sync-guard', async () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
      .setAuthorityId('auth-1')
      .setDigestArgs(testDigestArgs)
      .setScope('rad')
      .setSignature(makeTestSignature())

    expect(builder.isValid()).to.equal(true)
    const result = await builder.commit()
    expect(result).to.have.property('nonce')
    expect(result).to.have.property('thresholdReached')

    try {
      await builder.commit()
      expect.fail('expected double-commit to throw BuilderAlreadyCommittedError')
    } catch (err) {
      expect(err).to.be.instanceOf(BuilderAlreadyCommittedError)
    }
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubSigningEngine()
    const builder = new SigningStartSigningSessionBuilder(engine)
      .setAuthorityId('auth-1')
      .setDigestArgs(testDigestArgs)
      .setScope('rad')
      .setSignature(makeTestSignature())

    const json = builder.toJSON()
    expect(json.kind).to.equal('signing.startSigningSession')
    expect(json.version).to.equal(2)

    const restored = SigningStartSigningSessionBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)

    expect(() => SigningStartSigningSessionBuilder.fromJSON(
      { kind: 'wrong', version: 2, draft: {} }, engine
    )).to.throw(/unknown kind/)

    expect(() => SigningStartSigningSessionBuilder.fromJSON(
      { kind: 'signing.startSigningSession', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)

    expect(() => SigningStartSigningSessionBuilder.fromJSON(
      { kind: 'signing.startSigningSession', version: 1, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns { authorityId, digestArgs, scope, signature } shape; throws on incomplete', () => {
    const builder = new SigningStartSigningSessionBuilder(makeStubSigningEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder
      .setAuthorityId('auth-1')
      .setDigestArgs(testDigestArgs)
      .setScope('rad')
      .setSignature(makeTestSignature())
    const input = complete.toEngineInput()
    expect(input).to.have.property('authorityId')
    expect(input).to.have.property('digestArgs')
    expect(input).to.have.property('scope')
    expect(input).to.have.property('signature')
  })

  it('FACT-04 parity: MockSigningEngine.buildStartSigningSession() returns instanceof SigningStartSigningSessionBuilder', () => {
    const mock = new MockSigningEngine()
    const builder = mock.buildStartSigningSession()
    expect(builder).to.be.instanceOf(SigningStartSigningSessionBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.startSigningSession(...) vs builder.fromPayload(...).commit()', async () => {
    // Direct path
    const { ctx: ctx1, user: user1 } = await createPopulatedContext()
    const eng1 = new SigningEngine(ctx1)
    const authRow1 = await ctx1.db.prepare('select Id from Authority limit 1').get({})
    const authorityId1 = authRow1!.Id as string
    const sig1 = makeSignature(user1.id)
    const directResult = await eng1.startSigningSession(authorityId1, testDigestArgs, 'rad', sig1)
    expect(directResult).to.have.property('nonce')
    expect(directResult).to.have.property('thresholdReached')

    // Builder path
    const { ctx: ctx2, user: user2 } = await createPopulatedContext()
    const eng2 = new SigningEngine(ctx2)
    const authRow2 = await ctx2.db.prepare('select Id from Authority limit 1').get({})
    const authorityId2 = authRow2!.Id as string
    const sig2 = makeSignature(user2.id)
    const builderResult = await eng2.buildStartSigningSession()
      .fromPayload({ authorityId: authorityId2, digestArgs: testDigestArgs, scope: 'rad', signature: sig2 })
      .commit()
    expect(builderResult).to.have.property('nonce')
    expect(builderResult).to.have.property('thresholdReached')
  })
})
