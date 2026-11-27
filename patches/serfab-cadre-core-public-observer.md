# Patch: @serfab/cadre-core public-observer protocol

Status: VERIFIED against installed dist + a standalone Node inertness probe, 2026-09-04. NOT yet
landed upstream (filed as an issue only — see "Upstream" below).
Package: @serfab/cadre-core@0.12.0

## The blocker

VoteTorrent's public, no-login election view (Phase 56) needs an unauthenticated browser peer to
resolve the strand addresses it needs to join a public election's strand mesh. Two members-only
walls stand in the way, read from the installed 0.12.0 dist rather than assumed:

- **`dist/strand-addr-protocol.js:178-181`** (`StrandAddrService.processAddrRequest`) refuses any
  peer failing `isMember` (`CadreNode.isAuthorizedMember`) with an empty address list. This is
  Layer 3 — the strand-addr protocol handler's own authorization check.
- **`dist/cadre-node.js:1108-1139`** (`admitInboundControlConnection`) returns `'deny'` (relay off)
  or `'admit-for-relay'` (relay on, a connection that self-aborts after
  `RELAY_ADMISSION_RESERVE_DEADLINE_MS` unless a reservation lands) for a stranger on any gateway
  with `authorized.length > 0`. This is Layer 1 — the connection-level admission gate. A patch that
  only replaces Layer 3 is **still blocked here**, and the block is invisible to a cold-start
  harness (the `authorized.length === 0` carve-out masquerades as success).

**Layer 2 is explicitly NOT on this path and NOT edited.** `authorizeInboundControlStream`
(`dist/cadre-node.js:1291`) is reached only for the four Optimystic control-DB protocols
(`repo`/`cluster`/`sync`/`block-transfer`); `/sereus/*` protocols never touch it. It stays
fail-closed, unmodified, for every protocol it gates.

## The three edits, and why three not two

A naive read of the problem suggests two edits: a new receiver protocol (clears Layer 3) plus a
connection-level admit branch (clears Layer 1). **That is wrong, and the wrong shape is
`STRANGER_OPEN_PROTOCOLS` (`dist/membership-connection-gater.js:166`) being export/documentation-only
with ZERO consumers.**

`grep -rn "STRANGER_OPEN_PROTOCOLS" dist/` returns exactly four hits: its definition, the `index.js`
re-export, the `index.d.ts` re-export, and the `membership-connection-gater.d.ts` declaration.
`createMembershipConnectionGater` and `denyInboundEncryptedConnection` **never read it**. Appending
the new protocol id to that array would apply cleanly, pass a superficial review, and do **nothing**
— the connection would still be denied at Layer 1 before the new protocol is ever negotiated. This
is the single most reusable finding in this document; a future reader who skips it writes a
decorative patch that looks like a fix and changes no runtime behavior.

The three edits that actually clear the wall:

1. **New `dist/strand-observer-protocol.js`** — a mirror of `strand-addr-protocol.js`'s receiver
   half, `StrandObserverService`, gated on the STRAND (a node-local allowlist) rather than the
   PEER. Clears Layer 3 with a protocol an unauthenticated peer can actually reach.
2. **`dist/cadre-node.js` wiring** — constructs the node-local allowlist
   (`this.publicObserverStrandIds`), registers `StrandObserverService` only when it is non-empty, and
   adds `admitPublicObservers` to the connection gater's policy literal. Clears the wiring gap: the
   new protocol needs its own admission path distinct from the member-only control gate.
3. **The unconditional stranger-admit branch in `dist/membership-connection-gater.js`'s
   `denyInboundEncryptedConnection`** — reads `policy.admitPublicObservers?.()` and, when `true`,
   admits the connection. Clears Layer 1 for real, at the only place `admitInboundControlConnection`'s
   `'deny'`/`'admit-for-relay'` verdict is actually consulted.

## The invariants a forward-port may never relax

- **`dist/strand-addr-protocol.js` and `isAuthorizedMember` stay byte-for-byte untouched (D-02).**
  The patch carries zero hunks against either. Proven twice: `grep -c 'a/dist/strand-addr-protocol.js'`
  on the patch body is `0`, and the installed file's sha256 equals the pristine
  `npm pack @serfab/cadre-core@<version>` tarball in every resolved workspace copy. Byte equality,
  not a grep — an inverted decision would still contain the string `isMember`.
- **The allowlist is node-local, fail-closed, and exact-string (D-03).** `publicObserverStrandIds`
  is a `Set` built once, at construction time, from `CadreNodeConfig.publicObserverStrandIds` only —
  never from the replicated control DB, never from a peer. Membership is `Set.has(strandId)` with no
  prefix match, no wildcard, no normalization, no case folding. Fail-closed twice: an empty allowlist
  means the observer handler is never even registered (outer half), and a request naming an unlisted
  strand gets the same empty response an unauthorized peer gets from strand-addr today (inner half).
- **No `onDelegateAnnounce` on the observer service, ever.** In the original, a member's announce
  reaches `CadreNode.grantDelegateAdmission`, which admits a connection AND a relay reservation
  **exempt from the unauthorized-reservation budget**. `StrandObserverService` has no
  `onDelegateAnnounce` option, no read of `request.delegatePeerId`, and no path to
  `grantDelegateAdmission` — inheriting any of those would let an anonymous stranger mint that grant.
- **The gater branch sits below both the base-gater deny and the bring-up quiet period.** Placed
  after `const remotePeerId = peerId.toString();` and before `let verdict;` in
  `denyInboundEncryptedConnection` — after `base?.denyInboundEncryptedConnection` (the operator's own
  policy still wins) and after the `quiet()` bring-up check (hoisting above it would reopen the
  `BlockUnavailableError` start-up race the quiet period's module doc exists to prevent).
- **`this.publicObserverStrandIds` is constructed immediately after `this.config = config;`,
  never later.** `buildControlNodeOptions` builds the connection gater — which reads this Set via
  `admitPublicObservers` — during `start()`, **before** `start()` reaches the point where services are
  registered. Constructing the Set at the service-registration site instead would leave the gater
  closure reading an empty/undefined Set: the observer handler would register, but the Layer-1
  connection wall would stay up. That failure mode is silent and looks exactly like a fourth wall
  rather than a wiring bug — verify the hunk's preceding context line is `this.config = config;`
  before trusting any forward-port.

## The forward-port procedure

(a) **Read first.** Check the upstream delta for `@serfab/cadre-core` and any `tickets/complete/*.md`
in the sereus tree before spending time — the maintainers may have shipped an equivalent surface
already (see "Upstream" below).

(b) **Install the new version UNPATCHED first and measure whether the patch is still needed.**
`yarn add -D @serfab/cadre-core@<new-version> --exact` outside the patch (or just bump the range and
`yarn install` without a patch entry), then:
  - `grep -rn "STRANGER_OPEN_PROTOCOLS\|public-observer\|isObservableStrand" dist/` against the fresh
    unpatched dist — if the maintainers added an equivalent unauthenticated strand-address surface,
    the local patch may be retirable.
  - Run `56-07`'s three controls (members-only non-regression, allowlist fail-closed, observer
    protocol reachable) against the **unpatched** bytes. If they pass, **retire** the patch on the
    `ca9f1b87` shape (the prior `@serfab/cadre-core` patch retirement precedent) rather than
    forward-porting a patch nobody needs.
  - Prove a retired half, never infer it — a passing control suite on unpatched bytes is the only
    acceptable evidence for retirement; "the changelog looks related" is not.

(c) **Otherwise, `yarn patch @serfab/cadre-core` and re-derive each of the four hunks against the
new bytes.** Do not blind-apply the old patch — `git apply` may succeed on stale line offsets while
silently landing hunks in the wrong place if upstream reordered nearby code. Specifically re-read:
  - `denyInboundEncryptedConnection`'s body (line numbers and neighboring branches can move — the new
    admit branch must still sit after the base-gater deny and the bring-up quiet check, never before).
  - `start()`'s ordering (the service-registration site, and whether `this.config = config;` is still
    the earliest safe point to construct the allowlist Set — a refactor could move gater construction
    earlier or later).
  - The `STRANGER_OPEN_PROTOCOLS` consumer count — re-run the zero-consumers grep; if upstream ever
    wires it into `createMembershipConnectionGater`, the "why three not two" reasoning in this
    document needs to be revisited, not silently carried forward.

(d) **`yarn patch-commit -s <dir>`, then hand-repoint every `resolutions` key** — `patch-commit`
only rewrites the ONE key/workspace descriptor it detects; on this repo's `nmHoistingLimits:
workspaces` layout that has meant it also rewrites each workspace's own `dependencies` entry for the
package, but the root `resolutions` bare-name key and the explicit `@npm:<range>` key must still be
edited by hand (re-derive the range set with
`grep -rn '"@serfab/cadre-core"' package.json apps/*/package.json packages/*/package.json` rather
than trusting a prior count — a new workspace may have started depending on the package since the
last bump). Delete the superseded patch file, `yarn install`.

(e) **Re-run, in order:** the two version-lock guards
(`no-portal-vendor-regression.spec.ts` PUB-01-a/b/c, `published-stack-lock-regression.spec.ts`),
`yarn lint:peers`, the Authority app's cadre-core Node smoke coverage (inertness — same test titles,
zero new failures against the pre-bump baseline), then `56-07`'s three controls and `56-13`'s revert
control. **A green suite that never exercises the observer path proves nothing** — confirm at least
one control actually dials `STRAND_OBSERVER_PROTOCOL` and gets a real response before accepting the
bump.

## Explicit non-adoptions

- **No CI patch-integrity gate.** D-06 considered adding one (asserting the patch file's hash or hunk
  count in CI) and explicitly declined it — the guard is this document plus the `56-07`/`56-13`
  runtime controls, which exercise the actual behavior rather than the patch's shape. A CI hash-gate
  would only prove the patch file didn't change, not that it still does the right thing after an
  unrelated upstream refactor.
- **Gateway rate limiting and caps on anonymous observer requests are deferred.** What bounds a
  flood of anonymous observer requests today is inherited, not designed: the per-service
  `maxConcurrent` (100 concurrent inbound streams), `MAX_ADDR_SIZE` (64 KiB per frame), the 10 s read
  timeout, and libp2p's own connection-manager limits. None of these is an actual rate limit — the
  allowlist bounds WHAT is served, not HOW MANY peers may ask. This is a known non-mitigation
  (T-56-04-06 in the plan's threat model), arguably upstream's design call rather than ours, and is
  filed alongside the rest of the issue in "Upstream" below.
- **`.d.ts` files are not patched.** `types.d.ts`, `cadre-node.d.ts`, `index.d.ts`, and a
  `strand-observer-protocol.d.ts` are all deliberately absent. Every consumer of the new surface in
  this phase is plain ESM (`gateway.mjs`, the `56-07` harness, `src/peer/edge-node.js`) — no
  TypeScript consumer sets `publicObserverStrandIds` — and each extra declaration file is forward-port
  cost on the next bump for no current benefit. Revisit only if a `.ts` consumer of this surface
  appears.

## Upstream

This is an **issue-only** filing (`56-15`'s job, not this patch's) — VoteTorrent does not push PRs to
sereus for this change. The connection-level carve-out this patch adds is a genuine new
security-posture question for the sereus maintainers (T-56-04-05: it is peer-blind by construction,
since the connection gate runs before protocol negotiation), not a bug report against existing
behavior. If sereus adopts a different shape for unauthenticated strand-address resolution, adopt
theirs and retire this patch rather than maintaining two competing designs.
