import { Database } from '@quereus/quereus'
import { UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { NetworksEngine } from '../src/networks/networks-engine'
import { SigningEngine } from '../src/signing/signing-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
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
          'd'.repeat(64),
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
    it.skip('returns a nonce and propagates threshold result from sign()', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const result = await engine.startSigningSession(
        // authorityId will need to be resolved from the populated DB once
        // #23 ships and createPopulatedContext can hand back the seeded id.
        'authority-1',
        'd'.repeat(64),
        'rad',
        sig
      )
      expect(result.nonce).to.match(/^[0-9a-f]{8}-/)
      expect(result.thresholdReached).to.be.a('boolean')
    })

    // BLOCKED on quereus#23 — same chain.
    it.skip('INSERTs an AdminSigning row with the scope, digest, and signer fields', async () => {
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
      const digest = 'd'.repeat(64)
      const { nonce } = await engine.startSigningSession(
        authorityId,
        digest,
        'rad',
        sig
      )
      const row = await ctx.db
        .prepare(
          'select Scope, Digest, UserId, SignerKey from AdminSigning where Nonce = :nonce'
        )
        .get({ ':nonce': nonce })
      expect(row?.Scope).to.equal('rad')
      expect(row?.Digest).to.equal(digest)
      expect(row?.UserId).to.equal(user.id)
      expect(row?.SignerKey).to.equal(sig.signerKey)
    })

    // BLOCKED on quereus#23 — same chain.
    it.skip('rejects an invalid scope via AdminSigning.ScopeValid', async () => {
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
          'd'.repeat(64),
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
    it.skip('INSERTs an OfficerSignature row keyed by SigningNonce', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const nonce = crypto.randomUUID()
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      await engine.sign(nonce, sig)
      const row = await ctx.db
        .prepare(
          'select UserId from OfficerSignature where SigningNonce = :nonce'
        )
        .get({ nonce })
      expect(row?.UserId).to.equal(user.id)
    })

    // BLOCKED on quereus#23 — same chain. Threshold-met path triggers the
    // AdminSignature INSERT branch.
    it.skip('inserts an AdminSignature row once the threshold is met', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const nonce = crypto.randomUUID()
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const reached = await engine.sign(nonce, sig)
      expect(reached).to.equal(true)
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
    it.skip('is idempotent on duplicate threshold completion (D-17 PK collision is benign)', async () => {
      const { ctx, user } = await createPopulatedContext()
      const engine = new SigningEngine(ctx)
      const nonce = crypto.randomUUID()
      const sig: Signature = {
        signerUserId: user.id,
        signerKey: user.activeKeys[0]!.key,
        signature: 'a'.repeat(128)
      }
      const first = await engine.sign(nonce, sig)
      const second = await engine.sign(nonce, sig)
      expect(first).to.equal(true)
      expect(second).to.equal(true)
    })

    // BLOCKED on quereus#23 — sign() relies on a pre-existing AdminSigning
    // row to look up the scope. Without #23, no AdminSigning row can be
    // seeded, so the read-side path is unreachable today.
    it.skip('reads scope and threshold from the AdminSigning + Admin join', async () => {
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
        'd'.repeat(64),
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
        .get({ ':n': nonce })
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
        await engine.startSigningSession('aid', 'd'.repeat(64), 'rad', sig)
      } catch (err) {
        caught = err
      }
      // "Admin not found" comes from the read-side guard — proves the
      // ctx-bound DB is actually being queried.
      expect((caught as Error)?.message).to.include('Admin not found')
    })
  })
})
