/**
 * relay-only-peer-address-seed.spec.ts
 *
 * Regression lock for the residual P2P-11 blocker that spike 066 localized on the four-family bump
 * (`@serfab/cadre-core@0.11.0` / `@optimystic/db-p2p@0.24.0` / `@quereus/quereus@4.14.0` /
 * `p2p-fret@1.0.0-beta.1`).
 *
 * History. Optimystic#11 (`relay-only-cohort-member-addresses-never-reach-siblings`, shipped in
 * db-p2p 0.24.0) fixed the CONSUMER side of address propagation: `ClusterService`, `ClusterClient`
 * and `RepoClient` used to structurally discard the addresses that cluster records and redirect
 * payloads already carried, so a cohort member reachable only through a circuit relay held an empty
 * address list and every dial by peer id failed instantly with `NoValidAddressesError` while
 * membership logs still read healthy. That fix works, and spike 066 measured it: on device the drone
 * now assembles FULL four-member clusters with every member addressed — 456x
 * `findCluster:done … peers=4 addressless=0`, and `addressless=0` in 1383 of 1389 lookups.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * CORRECTED 2026-08-21 BY SPIKE 073. Read this before trusting anything below it.
 *
 * The mechanism this spec was written to lock — "the learning path is circular, so a relay-only
 * peer stays undialable FOREVER" — is REFUTED. Spike 073's T1 stands up the four-link chain over
 * real loopback sockets on this exact 0.24.0 tarball and every link works, in ~2.1 s:
 * reservation -> `identifyPush` -> the relay's peerStore (~1.0 s) -> a published `ClusterRecord`
 * carrying a real `/p2p-circuit` address -> `mergeRecordPeerAddresses` on a never-connected
 * sibling -> a successful dial. It is reproducible; see the spike-073 `t1/` harnesses.
 *
 * On device the same chain works for ONE emulator and not the other IN THE SAME RUN — 260 of 261
 * published records carry a circuit address for emulator-5554's control peer, against 57 of 1,627
 * for emulator-5556's. Same relay, same code, same 30 minutes. That is a lifecycle/timing defect,
 * NOT a missing mechanism, and "nobody ever teaches us" is simply false.
 *
 * WHAT SURVIVES, and what the assertions below still legitimately lock:
 *   1. `findCluster` really does build each entry's `multiaddrs` only from what THIS node knows
 *      (`getPeerStoreAddrsByPeer` + live connections). Accurate.
 *   3. `mergeRecordPeerAddresses` really does SKIP zero-address entries
 *      (`if (addrs.length === 0 || idStr === skipId) continue`). Accurate.
 *   4. db-p2p really never COMPOSES a `/<relay>/p2p-circuit/p2p/<peer>` address itself. Accurate —
 *      it does not need to; `identifyPush` supplies it.
 * So these are correct SOURCE-SHAPE locks. What was wrong was the INFERENCE drawn from them.
 *
 * WHAT SPIKE 073 FOUND INSTEAD (both reproduced across two independent device runs):
 *   A. `getConnectedAddrsByPeer()` has NO direction check, so for an INBOUND relay-only peer it
 *      harvests that peer's EPHEMERAL SOURCE SOCKET, and `findCluster` places connected addresses
 *      FIRST ("the most reliable"). While the peerStore is still empty, the record therefore
 *      carries exactly one address, and it is undialable by anyone. 506 (run 3) / 993 (run 4)
 *      such records. `addressless` stays 0, so `findCluster:addressless-members` never fires and
 *      the cohort logs healthy — which is why 066 measured `addressless=0` in 1,383/1,389 while
 *      dials kept failing. The consumer does NOT skip it (it is non-empty), so the sibling merges
 *      a bad address and fails LATE, matching 066's shift to 2,971 `db-p2p/sync/1.0.0` failures.
 *   B. Every `/p2p-circuit` address a relay holds for its OWN reservation holders is SELF-RELAY
 *      (`/…/p2p/<self>/p2p-circuit`) — correct for siblings, unusable by the relay itself. So
 *      `NoValidAddressesError` fires with a POPULATED address book: 44 of 46 populated-peerStore
 *      dial failures in run 4.
 *
 * Full write-up + decision rules: `.planning/spikes/073-optimystic-12-reply-evidence/`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Device evidence (spike 066, n=4: emulator-5554 + emulator-5556 + drone-A + drone-B, all four
 * uniformly on the bumped stack, drone verified loading from the spike worktree):
 *   - `peer-address-book:merge` — **0 occurrences in 46,798 drone log lines**, while
 *     `findCluster:done` logged 1,389 times FROM THE SAME `optimystic:db-p2p:libp2p-key-network`
 *     namespace. The merge is not filtered out; it genuinely never fires.
 *     [073 CONFIRMS AND STRENGTHENS THIS ONE. The worry was that the two record-ingest paths log
 *     under DIFFERENT namespaces — `ClusterService.learnPeerAddresses` (inbound) under
 *     `db-p2p:peer-address-book`, `ClusterClient`/`keyNetwork.recordPeerAddresses` under
 *     `optimystic:db-p2p:libp2p-key-network` — so 066's grep might have been blind to the inbound
 *     half. Spike 073 re-ran with BOTH armed and counted them separately: still 0 — in 110,992
 *     (drone-A) + 177,320 (drone-B) lines in run 3, and 0 again in run 4's 109,742 drone-A lines.
 *     The objection is eliminated; this datum may be stated
 *     upstream. WHY it is zero is now explicable and is NOT this spec's mechanism: a merge happens
 *     on record INGEST, and the dials that would carry a record fail before any record is
 *     exchanged. The loop closes at the dial, not at an empty record.]
 *   - `NoValidAddressesError` x41-48 on drone-A, targeting exactly the two emulators' CONTROL
 *     peerIds (attributed against each device's logcat), while their STRAND peerIds carry real
 *     `/p2p-circuit/` addresses in `relayAddrsPerDrone`.
 *   - `findCluster:addressless-members count=1 of=4` x6, naming an emulator peer.
 *   - `REPLICATION VERDICT: FAIL` on both peers; P2P-11 stays open.
 *
 * The address is NOT unknowable — the emulators hold valid relay reservations
 * (`relayReservation=true` on both) and their circuit addresses are observable.
 * [073: the first sentence is right and the conclusion that followed it was wrong. A seeding path
 * DOES exist and demonstrably runs (T1; and 260/261 records for emulator-5554's control peer carry
 * a circuit address on device). It just does not run reliably for every peer. 073's T4 adds the
 * discriminator 066 lacked: at `NoValidAddressesError` time the drone's peerStore was EMPTY in
 * 1,299/1,300 (run 3) and 2,283/2,329 (run 4) failures, and 1,287/1,300 of those dials were on
 * `db-p2p/sync/1.0.0`, NOT findCluster's own path. 073's T5 also clears the maintainer's closing
 * hypothesis: cadre-core's membership connection gater wraps the CONTROL node only
 * (`cadre-node.js:915`) and not strand nodes (`strand-instance-manager.js:265`), but it is never
 * even consulted — 0 `[spike073-t5]` admission decisions on either emulator with the hook verified
 * present in the served bundle, 0 `DENYING` on both drones, `relayReservation=true` throughout.]
 *
 * Filed upstream: https://github.com/gotchoices/Optimystic/issues/12 (2026-08-19)
 * Draft: `.planning/spikes/066-multipeer-device-verdict-0_24/issues/db-p2p-relay-only-peer-has-no-address-seed.md`
 *
 * THIS SPEC IS A RED LOCK, NOT A PASSING FEATURE TEST. Each assertion pins a mechanism that is
 * currently BROKEN. When upstream ships a seeding path these assertions should FAIL — that failure
 * is the spec's success condition and the signal to close the issue and INVERT the assertions
 * (the 0.18.0 precedent in `post-peerid-patch-upstream-blockers.spec.ts`), not to delete them.
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('relay-only-peer-address-seed: could not locate yarn.lock walking up from the spec')
}

const REPO_ROOT = findRepoRoot()

/** The workspace is nohoist'd, so deps land in per-workspace node_modules. Any copy proves it. */
const CONSUMER_BASES = [
  join(REPO_ROOT, 'packages', 'p2p-probe-host'),
  join(REPO_ROOT, 'apps', 'VoteTorrentAuthority'),
  join(REPO_ROOT, 'apps', 'VoteTorrentVoter'),
  REPO_ROOT,
]

function resolveInstalled (...segments: string[]): string | undefined {
  for (const base of CONSUMER_BASES) {
    const p = join(base, 'node_modules', ...segments)
    if (existsSync(p)) return p
  }
  return undefined
}

/** Strip comments so an assertion can never be satisfied by upstream's prose about the defect. */
function stripComments (src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function readInstalled (...segments: string[]): string {
  const p = resolveInstalled(...segments)
  expect(p, `Expected ${segments.join('/')} to be installed under one of:\n  ${CONSUMER_BASES.join('\n  ')}`)
    .to.not.equal(undefined)
  return stripComments(readFileSync(p as string, 'utf8'))
}

const KEY_NETWORK = ['@optimystic', 'db-p2p', 'dist', 'src', 'libp2p-key-network.js']
const ADDRESS_BOOK = ['@optimystic', 'db-p2p', 'dist', 'src', 'peer-address-book.js']
const DB_P2P_PKG = ['@optimystic', 'db-p2p', 'package.json']

describe('P2P-11 residual: a relay-only peer has no address SEED (db-p2p 0.24.0)', () => {
  it('the Optimystic#11 CONSUMER-side fix is present — this issue is about what it does NOT cover', () => {
    const book = readInstalled(...ADDRESS_BOOK)
    expect(
      book.includes('export function mergePeerAddresses'),
      'Expected db-p2p to ship peer-address-book.mergePeerAddresses (the Optimystic#11 fix). If this ' +
      'is gone the baseline changed and this whole spec needs re-deriving, not just re-pointing.'
    ).to.equal(true)
    expect(
      book.includes('export function mergeRecordPeerAddresses'),
      'Expected the shared record traversal mergeRecordPeerAddresses to exist.'
    ).to.equal(true)
    const keyNet = readInstalled(...KEY_NETWORK)
    expect(
      keyNet.includes('recordPeerAddresses'),
      'Expected Libp2pKeyPeerNetwork to expose recordPeerAddresses (the IPeerNetwork entry point).'
    ).to.equal(true)
  })

  it('BLOCKER: mergeRecordPeerAddresses skips zero-address entries, so an unknown relay-only peer teaches nobody', () => {
    const book = readInstalled(...ADDRESS_BOOK)
    // The literal guard that makes the learning path circular: a record entry with no addresses is
    // dropped, and a record entry for a relay-only peer HAS no addresses (see the next test).
    expect(
      /addrs\.length\s*===\s*0/.test(book),
      'Expected mergeRecordPeerAddresses to still skip entries whose multiaddrs array is empty. If ' +
      'this guard is gone, upstream may have added a seeding path — re-read peer-address-book.js ' +
      'and close .planning/spikes/066-*/issues/db-p2p-relay-only-peer-has-no-address-seed.md'
    ).to.equal(true)
  })

  it('BLOCKER: findCluster sources a record\'s multiaddrs solely from what THIS node already knows', () => {
    const keyNet = readInstalled(...KEY_NETWORK)
    // The producer reads the local peerStore...
    expect(
      keyNet.includes('getPeerStoreAddrsByPeer'),
      'Expected findCluster to build peer addresses from the local peerStore lookup.'
    ).to.equal(true)
    // ...and publishes exactly that into the record, empty or not.
    expect(
      /peers\[idStr\]\s*=\s*\{\s*multiaddrs:\s*parsed/.test(keyNet),
      'Expected findCluster to assign the locally-parsed addresses straight into the record entry. ' +
      'A change here is the most likely shape of an upstream fix.'
    ).to.equal(true)
    // ...and explicitly tolerates the empty case rather than seeding it.
    expect(
      /parsed\.length\s*===\s*0/.test(keyNet),
      'Expected findCluster to still merely COUNT addressless members rather than seed them.'
    ).to.equal(true)
  })

  it('BLOCKER: no seeding path exists from a circuit-relay reservation into the peer address book', () => {
    const keyNet = readInstalled(...KEY_NETWORK)
    const book = readInstalled(...ADDRESS_BOOK)
    // The address a relay-only peer needs is `/<relay>/p2p-circuit/p2p/<peer>`. Nothing in either
    // module COMPOSES one — the only inputs are addresses handed to us by someone who already had
    // them. Note db-p2p does reference `/p2p-circuit` once, in `isLimitedConnection`, but that
    // CLASSIFIES an already-established connection; it never constructs a dialable address. The
    // assertion below is deliberately narrow to that distinction.
    const combined = `${keyNet}\n${book}`
    expect(
      combined.includes('p2p-circuit/p2p/'),
      'db-p2p 0.24.0 never COMPOSES a `/<relay>/p2p-circuit/p2p/<peer>` address for an addressless ' +
      'cohort member — the only `/p2p-circuit` reference is the isLimitedConnection classifier. If ' +
      'a composition now appears, a seeding path may have landed: verify against a device run ' +
      'before closing the upstream issue.'
    ).to.equal(false)
    expect(
      keyNet.includes('isLimitedConnection'),
      'Expected the isLimitedConnection classifier to still exist — it is the reference point for ' +
      'the narrow assertion above.'
    ).to.equal(true)
  })

  it('documents the exact installed version this residual was measured against', () => {
    const pkgPath = resolveInstalled(...DB_P2P_PKG)
    expect(pkgPath, 'Expected @optimystic/db-p2p to be installed').to.not.equal(undefined)
    const version = (JSON.parse(readFileSync(pkgPath as string, 'utf8')) as { version: string }).version
    expect(
      version,
      `Spike 066 measured this residual on @optimystic/db-p2p@0.24.0 (device n=4, 2026-08-19): ` +
      `peer-address-book:merge fired 0 times in 46,798 drone log lines while findCluster:done logged ` +
      `1,389 times from the same namespace. Installed version is now ${version} — if it moved, re-run ` +
      `the device proof before trusting the assertions above.`
    ).to.equal('0.24.0')
  })
})
