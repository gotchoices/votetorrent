# repro — the D-04 upstream reproduction for the public-observer-protocol blocker

## What the blocker is

`@serfab/cadre-core`'s only address-resolution protocol for a strand mesh,
`/sereus/strand-addr/1.0.0`, gates on cadre membership with no "this strand is public" escape
hatch. VoteTorrent's public election view needs an unauthenticated peer to resolve a strand's
live multiaddrs before it can complete a strand-mesh read — and the strand mesh itself has no
membership gate on the read path (see `56-01-WALL-PROOF.md` in this repo's `.planning/`), so
`strand-addr` is the ONE wall standing between "public election" and "anonymous readable
election". `56-15` files this as an **issue only** against upstream — this project does not push
a PR to `sereus`; a suggested three-edit fix (a new node-local-allowlisted observer protocol) is
offered for discussion, and this repo's own copy of it is a committed `.yarn` patch
(`patches/serfab-cadre-core-public-observer.md`), not a claim that the maintainers must adopt it.

## Files

| file | what it is | needs |
|---|---|---|
| `public-observer-blocker.test.mjs` | the runnable repro `56-15` cites — self-contained, `node --test`, mode-detecting (runs against both stock and patched `@serfab/cadre-core` bytes and reports which) | `@serfab/cadre-core`, `@optimystic/db-p2p`, ~5-10s per mode |
| `control-self-publish-alone.test.mjs` | upstream repro for the CadrePeer control fork: a restarted member's boot timer and heartbeat commit its own row while no control sibling is reachable (`hasReachableControlSibling()` false). FAILS on stock `@serfab/cadre-core` 1.18.0 (2 solo commits); passes with this repo's control-fork guard in the cadre-core patch. Self-contained like the observer repro. | `@serfab/cadre-core`, `@optimystic/db-p2p`, 15 s to 2.5 min (an owner write made while the sibling is down can wait out its retry budget) |
| `control-sibling-stale-redial.test.mjs` | upstream repro for the second lock of the CadrePeer control fork: a sibling whose signed record is stale (or holds no address), with no address-book entry and no retained target, is never re-dialed through the party relay (`undialable`, off the redial ladder). Two relay-only nodes behind an in-process relay. FAILS on this repo's 1.18.0 patch before the stale-sibling relay redial hunk; passes with it. | `@serfab/cadre-core`, `@optimystic/db-p2p`, `@libp2p/circuit-relay-v2`, about 2-5 min |
| `peer-join-backfill-push-shape.test.mjs` | upstream repro for the peer-join block catch-up on `@optimystic/db-p2p` 1.19.0: cadre-core 1.18.0 calls `BlockTransferClient.pushBlocks(ids, buffers, ...)`, the 1.18.0 signature; 1.19.0 reads `(blocks, reason, ...)`, so the id array becomes the block map and the buffers become the `reason`. No network (the client's `processMessage` is captured). FAILED on this repo's 1.18.0 patch before the push-shape hunk. UPSTREAM in cadre-core 1.19.0, which passes it stock (2026-10-29), so the hunk is gone from the 1.19.0 patch; kept as a regression guard. | `@serfab/cadre-core`, `@optimystic/db-p2p`, under 1 s |
| `joiner-coordinator-miss-defers.test.mjs` | upstream repro for a joiner's cold re-attach: `StrandInstanceManager.buildStrandDatabase` waits for a seed peer (`'awaiting-seed'`) only on `cohort-unreachable`, so a first read that db-p2p's `findCoordinator` answers with `FindCoordinatorError` (`NO_NETWORK_COORDINATOR` / `NO_COORDINATOR_AVAILABLE`: restored serving peers not connected yet) releases the runtime and its redial loop. No network (`StrandDatabase.initialize` is stubbed). FAILS on this repo's 1.18.0 patch before the joiner-coordinator-miss hunk; passes with it. | `@serfab/cadre-core`, `@optimystic/db-p2p`, under 1 s |
| `verify-verdicts-memoized.test.mjs` | upstream repro for repeated pure-JS ed25519 verification: the membership refresh (`authorizedAmong` -> `hasAnchoredProof` -> `verifyInvitationAdmission`, three verifies per invitation-admitted row) and `resolvePeerAddrs` (`verifyPeerRecordSignature`) re-verify the same (digest, signature, key) triples on every pass, which kept a phone's JS thread busy. Asserts verdicts are unchanged (tampered, forged, moved signature, other key, other party all `false`, repeatedly) and that 50 repeats of one record cost at most a fifth of 50 distinct records. FAILS on this repo's 1.18.0 patch before the verify-memo hunk (ratio 1.0); passes with it (ratio ~30). | `@serfab/cadre-core`, under 1 s |
| `README.md` | this file | — |

## Running it

From `packages/p2p-probe-host`:

```bash
node --test repro/*.test.mjs
```

Against this repo's own tree (always patched), this registers and runs the `PATCHED` assertion
set: one outsider peer, one connection, one run — SERVED on the public-observer protocol,
still `REFUSED_EMPTY` on `/sereus/strand-addr/1.0.0` for the identical strand, with
`admitInboundControlConnection` re-checked concurrently to prove the success is attributable to
the patched connection-gater branch and not to membership, an enrollment window, a delegate
grant, or the cold-start carve-out.

To run it against **stock** (unpatched) bytes — e.g. after `npm pack @serfab/cadre-core@0.12.0`
into a scratch copy and deleting `dist/strand-observer-protocol.js` from it — point
`CADRE_CORE_ENTRY` at that copy's entry file:

```bash
CADRE_CORE_ENTRY=/path/to/scratch/@serfab/cadre-core/dist/index.js \
  REPRO_REQUIRE_MODE=stock node --test repro/*.test.mjs
```

This registers the `STOCK` assertion set instead: the observer protocol's export does not exist,
an outsider cannot resolve strand addresses through any path, and dialing the (derived, never
hard-coded) observer protocol id fails at negotiation because no handler is registered for it.

`REPRO_REQUIRE_MODE=stock|patched` pins the mode this run is REQUIRED to detect; a mismatch (for
example, `REPRO_REQUIRE_MODE=stock` run against this repo's own patched tree) throws and exits
non-zero rather than silently running the wrong assertion set. This repo's own regression gate
always passes `REPRO_REQUIRE_MODE=patched`, so a green run here can never be produced by a silent
downgrade to the weaker `stock` set.

## The stock/patched mode contract

The file resolves `@serfab/cadre-core` through **one** indirection —
`process.env.CADRE_CORE_ENTRY` if set, else the bare `@serfab/cadre-core` specifier — so the
identical file runs against either tree. It derives its mode from **two independent signals**
and requires them to agree before registering any test:

1. **Export signal** — is `STRAND_OBSERVER_PROTOCOL` a non-empty string (and
   `StrandObserverService` a function)?
2. **Byte signal** — a comment-stripped scan of the resolved package's `dist/*.js` files
   (`*.js.map` excluded) for a token **derived** from the imported `STRAND_ADDR_PROTOCOL`
   constant (never written as a literal — substituting its own protocol-name segment), carrying
   a **positive control**: the scan must find `STRAND_ADDR_PROTOCOL`'s own literal at least once
   in `strand-addr-protocol.js`, or the scanner itself is broken rather than the observer
   protocol being absent.

If the two signals **disagree** — for example, a copy whose `dist/index.js` re-export was
stripped while `dist/strand-observer-protocol.js` itself remains on disk — the file throws
`MODE_AMBIGUOUS` naming both observations and exits non-zero, rather than guessing. That
disagreement is exactly the hole that would let a failed or partially-reverted patch silently
downgrade this file to the weaker `stock` assertion set and report green.

## The no-drift rule

`56-15` inlines `public-observer-blocker.test.mjs` into the upstream issue it files. **The local
copy in this directory and the copy pasted into the issue must not drift apart** — if this file
changes, the issue (or its follow-up comment) must be updated to match, and vice versa.

## Why this lives in a real yarn workspace, not `tools/multipeer-gate`

`tools/multipeer-gate` runs its own standalone `npm install`, which drops this repo's Yarn
`resolutions` and patches — a cadre-core repro placed there would resolve **stock** bytes even
when run from this repo's own checkout, and could never observe the patched behaviour at all
(the same trap that nested an unfixed `@optimystic/db-p2p@0.24.2` under `@serfab/cadre-core`
in the `tools/multipeer-gate` corroboration-deadlock repro). `packages/p2p-probe-host` is a real
Yarn workspace — `56-04` Task 2 already asserts it resolves the patched bytes — so this file lives
here instead.

## What this repro does NOT claim

- **D-05.1** (patch-removal control against a rebuilt browser production variant) is `56-13`'s.
  Running this file against a hand-assembled stock scratch copy (as shown above) exercises this
  file's own `STOCK` branch so it does not ship untested code to strangers — it is **not** D-05.1
  and must not be read as one.
- **D-05.4** (byte provenance against the RUNNING gateway) is `56-08`'s.
- No PR to `sereus` is created, proposed, or scaffolded by this file or by `56-15`.

## Hygiene

Loopback-only listen addresses, in-memory storage, ephemeral `Ed25519` identities generated
fresh per run, empty `bootstrapNodes`, no on-disk enrolment channel, every node stopped in a
`finally` on both the pass and fail paths, and no probe payload ever carries a `delegatePeerId`
— this file is handed to strangers who may run it on a machine with a real cadre deployment.
Production-length strandIds throughout (a random UUID per run, never a three-character fixture).
Generous per-test timeouts: `CadreNode` boot is CPU-heavy, and a busy host has manufactured false
failures before — avoid running this alongside a concurrent `nx run-many`.
