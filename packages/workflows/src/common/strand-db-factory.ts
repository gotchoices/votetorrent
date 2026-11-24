/**
 * strand-db-factory.ts — the strand-backed DbFactory shared by both apps and the vt CLI.
 *
 * Moved from the Authority's `src/engines/rn-db-factory.ts` (the platform-neutral half). The LevelDB
 * solo factory stays in the app: this file imports NOTHING platform-specific, and `@serfab/cadre-core`
 * and `@votetorrent/vote-engine` are TYPE-only imports (the node is injected as `StrandHost`), so the
 * factory loads under plain Node, under Metro and under the apps' jest without the real cadre-core.
 */
import { VOTETORRENT_SCHEMA_SQL, VOTETORRENT_SCHEMA_VERSION } from '@votetorrent/vote-engine/rn'
import type { DbFactory, DbFactoryOptions } from '@votetorrent/vote-engine'
import type { StrandConfig, StrandInstance } from '@serfab/cadre-core'
import {
  failOnStrandError,
  isStrandAwaitingFirstSyncError,
  StrandLaunchFailedError,
  waitForStrandWritable,
} from './strand-first-sync.js'
import { takeFounderIntent, resolveFounderFlag, JoinedNetworksUnreadableError } from './founder-intent.js'
import { strandChanges } from './strand-changes.js'
import { normalizeRelaySeed, seedStrandWithRelays, type RelaySeedOutcome, type StrandSeedHost } from './strand-relay-seed.js'

// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema as
// `declare schema App { ${schema} } apply schema App;`. VOTETORRENT_SCHEMA_SQL is
// itself wrapped in `declare schema main { ... } apply schema main;`, so passing it
// verbatim nests invalidly and Quereus throws `got '}'`. Strip the outer wrapper so
// only the inner DDL is handed to addStrand; cadre-core re-wraps it under `App` and
// setSchemaPath(['App','main']) resolves bare engine table names (D-14). qsql has no
// `main.`-qualified references, so the strip is clean.
//
// Evaluated at module load, so it must not throw when the vote-engine entry is a partial test
// double: this module is reached through the package barrels by every binding that imports
// `@votetorrent/workflows`, including suites that mock '@votetorrent/vote-engine/rn' without the
// schema and never open a strand. A missing schema yields '' here and fails at the first query of
// a strand actually opened with it; the real entry always provides the string.
export const VOTETORRENT_INNER_DDL =
  typeof VOTETORRENT_SCHEMA_SQL === 'string'
    ? VOTETORRENT_SCHEMA_SQL
        .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
        .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
        .trim()
    : ''

/**
 * Minimal addStrand-capable seam — satisfied structurally by `CadreNode`.
 *
 * Injected (rather than reaching for a module-level singleton) so the
 * strand-backed factory is unit-testable with a fake node. CadreNode's
 * `getControlNode()` returns `Libp2p | null`; we only read `getConnections()`.
 */
export interface StrandHost extends StrandSeedHost {
  addStrand(config: StrandConfig): Promise<StrandInstance>
  getControlNode(): { getConnections(): readonly unknown[] } | null
  whenStrandWritable(strandId: string, options?: { timeoutMs?: number }): Promise<StrandInstance>
  /** Read for `'error'` while an open waits (see `StrandLaunchFailedError`). Optional for test fakes. */
  getStrand?(strandId: string): { status: string } | undefined
  /** Releases a strand that failed to start, so the next open launches it afresh. */
  stopStrand?(strandId: string): Promise<void>
}

/**
 * Options for the first-sync gate (quick task 260928-kkf — see strand-first-sync.ts).
 *
 * `signal` cancels a pending `whenStrandWritable` wait (node change, network switch /
 * Start Fresh, provider unmount). `onAwaitingFirstSync` fires once, BEFORE the wait
 * begins, so a caller can surface a "still syncing" state — it does not fire again on
 * subsequent retry attempts within the same wait.
 */
export interface StrandDbFactoryOptions {
  signal?: AbortSignal
  onAwaitingFirstSync?: (strandId: string) => void
  /**
   * D-30: whether `strandId` is on the persisted joined list (a network this node JOINED rather
   * than founded). A joined hash never opens as founder. Same shape as the Voter's option. An
   * unreadable list refuses the open: a throw or rejection here becomes a rejected
   * `JoinedNetworksUnreadableError` and `addStrand` is never called.
   */
  isJoinedNetwork?: (strandId: string) => boolean | Promise<boolean>
}

/**
 * Strand-backed DbFactory (P2P-03 / D-07 / D-14).
 *
 * Returns a `DbFactory` that, instead of opening a standalone LevelDB-backed
 * Quereus Database, attaches a CadreNode strand for the network and hands back
 * the strand's Quereus Database. The strand owns the vtab + transactor, so there
 * is NO registerPlugin / setDefaultVtab call on this path — cadre-core applies
 * the sApp schema (wrapped in `declare schema App { ... }`) during addStrand.
 *
 * D-05: strandId is derived directly from the network hash — already unique per
 *       network, so it doubles as the strandId with no extra mapping structure.
 * D-07: SUPERSEDED by cadre-core 0.11.0 (spike 064). `StrandMode` and
 *       `StrandConfig.mode` were DELETED upstream — a deliberate breaking change
 *       ("the repo carries no backwards compatibility"). The solo/networked
 *       transactor split is gone: every strand now uses the shared path, and the
 *       backfill gate is armed for every stored strand, which is what upstream
 *       says closes the "founded alone, never replicates" hole.
 *       The surviving knob is `founder?: boolean` — whether THIS node provisioned
 *       the strand. The founder runs the one-time membership bootstrap (writes
 *       `Strand.Header`, and for a closed strand the founding Member+Manager); a
 *       joiner leaves it false and receives those rows via Optimystic sync.
 *       The existing peer probe carries over with its meaning intact: no control
 *       peers ⇒ nobody else can have provisioned this strand ⇒ we are the founder.
 *       Reference: sereus v0.11.0 `scripts/lib/published-smoke-scenario.mjs:439`
 *       passes `founder: true` on the create path.
 * D-14: after `getDatabase()`, `setSchemaPath(['App','main'])` makes bare engine
 *       SQL table names (e.g. `Network`) resolve to `App.Network` first, with
 *       `main` as the fallback for SchemaInit / TidSequence. One call fixes
 *       the entire SQL tier — zero engine query rewrites.
 *
 * D-30: `!hasPeers` stays the DEFAULT for every existing open path. On top of it, a persisted
 *       joined hash is never founder; a founding window (set around `NetworksEngine.create`) is
 *       founder exactly once; a joining window is never founder. See `founder-intent.ts`. The
 *       intent is read synchronously as the first statement, so it is claimed by the open that
 *       the window was installed for and by no other.
 *
 * Relays: a re-attach passes the network's stored relays (`DbFactoryOptions.relays`, from
 *       `NetworksEngine.open`). They are merged into the strand's carried bootstrap seed before
 *       `addStrand` (`strand-relay-seed.ts`), never on a founding create. With no relays the
 *       factory awaits nothing extra, so its timing is unchanged.
 *
 * Ordering (Pitfall 3): never read `strand.database` before `await addStrand`
 * resolves (or, on the first-sync gate path below, before `waitForStrandWritable`
 * resolves) — `database` is present once the strand is active/idle, which EITHER
 * resolution guarantees.
 *
 * First-sync gate (quick task 260928-kkf): since cadre-core 1.1.0, a JOINER's
 * `addStrand` can block for its configured `strandFirstSync.timeoutMs` (default
 * ~300s) and then REJECT with the retryable `StrandAwaitingFirstSyncError` — "no
 * sibling has been reachable since this node joined" — rather than resolving. That is
 * NOT a failure to open the network: the strand stays launched and keeps probing on
 * its own, so this catches exactly that one error (name-marker + strandId match, see
 * `strand-first-sync.ts`) and waits for `strand:writable` via `waitForStrandWritable`
 * instead of failing the open. `addStrand` is called at most once per factory call —
 * the wait only ever calls `whenStrandWritable`. See `strand-first-sync.ts`'s module
 * doc comment for the full class-identity-detection and indefinite-wait rationale.
 */
export function createStrandDbFactory(node: StrandHost, options?: StrandDbFactoryOptions): DbFactory {
  return async (networkHash: string, dbOptions?: DbFactoryOptions) => {
    // D-05: the network hash is already unique per network — use it as the strandId.
    const strandId = networkHash

    // D-30: the one-shot intent read is the FIRST statement, before any await, so a founding
    // window is claimed by the open it was installed for and by no other.
    const intent = takeFounderIntent(strandId)

    // D-30: a persisted joined hash is never founder. Only awaited when the option is given, so
    // the timing of a factory without it is unchanged (addStrand stays synchronous).
    let joined = false
    if (options?.isJoinedNetwork) {
      try {
        joined = (await options.isJoinedNetwork(strandId)) === true
      } catch {
        console.warn('[strand-factory] attach refused', { reason: 'joined-list-unreadable' })
        throw new JoinedNetworksUnreadableError()
      }
    }

    // D-07 (0.11.0): check for peers BEFORE addStrand — no peers ⇒ we are the founder (the default).
    const controlConnections = node.getControlNode()?.getConnections().length ?? 0
    const founder = resolveFounderFlag({ intent, joined, controlConnections })

    // The network's relays join this strand's bootstrap seed (strand-relay-seed.ts). Awaited only
    // when there are relays, so a factory call without them keeps its timing.
    if (normalizeRelaySeed(dbOptions?.relays).length > 0) {
      const relaySeed: RelaySeedOutcome = await seedStrandWithRelays(node, strandId, dbOptions?.relays, intent === 'founding')
      console.info('[strand-factory] relay seed', { relaySeed })
    }

    // Closed tokens only (never the strand id / network hash). This line exists so a device
    // run can read which founder flag a cold start, an import or a create attached with.
    console.info('[strand-factory] attach', { founder, controlConnections, intent: intent ?? 'none' })

    let strand: StrandInstance
    try {
      strand = await openStrand()
    } catch (error) {
      if (error instanceof StrandLaunchFailedError) {
        // Best effort: a strand that cannot be stopped leaves the next open failing the same way.
        await node.stopStrand?.(strandId).catch(() => undefined)
      }
      throw error
    }

    // Safe only after addStrand OR waitForStrandWritable resolves (Pitfall 3).
    // `database` is present once the strand is active/idle, which either
    // resolution guarantees.
    const db = strand.database!.getDatabase()
    db.setSchemaPath(['App', 'main']) // D-14 transparency — never omit (Pitfall 2).
    // Screens hear this strand's table changes through the process's one hub (useStrandChanges).
    strandChanges.attach(strandId, strand.database!)

    return db

    async function openStrand(): Promise<StrandInstance> {
      try {
        const launch = node.addStrand({
          // FounderOwnerKey is new and REQUIRED in cadre-core 0.13.0: the owner key of the machine
          // that published the row, used to derive "am I the founder?" for a launch that supplies
          // no explicit flag. We DO supply `founder` explicitly just below, so null is correct
          // here rather than merely tolerated — and it is provenance, not content, so
          // `strandRowMismatches` excludes it from the identical-content comparison.
          // cadre-core 1.18 adds `FounderPeerId` (the machine that runs the founder bootstrap,
          // read only when no explicit `founder` flag is given). Same reasoning, so null.
          strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
          sAppConfig: {
            id: 'org.votetorrent',
            version: '1.0.0',
            schema: VOTETORRENT_INNER_DDL,
            schemaVersion: VOTETORRENT_SCHEMA_VERSION,
            latencyHint: 'interactive',
          },
          founder,
        })
        // A launch that loses the race below still settles later; never as an unhandled rejection.
        launch.catch(() => undefined)
        return await failOnStrandError(node, strandId, launch)
      } catch (error) {
        // Only the first-sync gate error, FOR THIS strand, is retryable — every other
        // error (including the same gate error for a different strand) rejects unchanged.
        if (!isStrandAwaitingFirstSyncError(error, strandId)) {
          throw error
        }
        options?.onAwaitingFirstSync?.(strandId)
        // Never re-calls addStrand — loops on whenStrandWritable only (see the doc
        // comment above and strand-first-sync.ts). cadre-core's default
        // `awaitFirstSync: true` is left untouched, so a non-gated/fast join is
        // unaffected and resolves exactly as before this catch was added.
        return await waitForStrandWritable(node, strandId, { signal: options?.signal })
      }
    }
  }
}
