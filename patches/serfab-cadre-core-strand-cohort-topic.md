# Patch: @serfab/cadre-core strand-cohort-topic surface

> **RETIRED 2026-10-09 (cadre-core 1.14.0).** cadre-core 1.12+ ships this surface itself as
> `CadreNodeConfig.strandReactivity: { enabled, strandIds? }` (`dist/strand-reactivity.js`,
> `strandCohortTopicOption`), building exactly `cohortTopic: { enabled: true }` for the selected
> strands. The only thing this patch added beyond that was forwarding `minSigs` as
> `cohortTopic.host.minSigs`; upstream states that `minSigs` does not govern the reactivity root
> (it is verified at the consensus super-majority), and that hunk was dropped by decision. All
> three hunks are gone from `.yarn/patches/@serfab-cadre-core-npm-1.14.0-votetorrent.patch`;
> `gateway.mjs` passes its `strandCohortTopic.enabled` to `strandReactivity` and refuses a
> `minSigs` key. The record below is kept as history.

Status: hand-authored, verified against installed dist by `git apply --check`/`patch --dry-run`
in both application orders, 2026-09-05. NOT yet landed upstream (filed as an issue only — see
"Upstream" below).
Package: @serfab/cadre-core@0.12.0

## The blocker

VoteTorrent's public, no-login election view (Phase 56) needs the gateway's strand node to
*originate* reactivity notifications — otherwise a subscribing browser can resolve strand
addresses (the `56-04` public-observer patch) but never learn of a write. `@optimystic/db-p2p`'s
reactivity-origination bridge is installed exclusively inside `createLibp2pNode`'s
`options.cohortTopic?.enabled === true` branch (`@optimystic/db-p2p@0.27.0`
`dist/src/libp2p-node-base.js:175` reads the flag; `dist/src/libp2p-node-base.js:1094-1120`
installs the bridge and hard-fails the node if FRET is unavailable while opted in). Two facts,
read from the installed 0.12.0 dist rather than assumed:

- **`dist/strand-instance-manager.js:246-291`** (`buildStrandRuntime`'s `createLibp2pNode(...)`
  call) builds every strand node's libp2p options with no `cohortTopic` key at all.
- **`grep -rl cohortTopic dist/`** over the whole of `@serfab/cadre-core`'s installed dist
  **returns nothing** — there is no config surface to set at all, on any launch path
  (`dist/cadre-node.js:3646`, the `startStrand({...})` composition in `launchStrand`, carries no
  such key either).

That is why the browser side's own experiment (`56-17`) stopped at
`CohortBackoffError: cohort-topic: no willing primary right now`: there is no willing primary
because the only candidate strand node never built a cohort-topic host in the first place.

## The edits, and why three not two

A naive read suggests two edits: thread a config key through `startStrand`'s composition, and
consume it in `createLibp2pNode`'s options. **That is wrong for the same reason
`patches/serfab-cadre-core-public-observer.md` names for its own three-edit shape**: a patch that
applies cleanly and reviews cleanly can still change nothing at runtime.
`STRANGER_OPEN_PROTOCOLS` (`dist/membership-connection-gater.js:166`) is that document's own
example — an exported array with zero consumers. This patch's third edit exists to make that
class of failure *checkable*, not to repeat it:

1. **`dist/strand-instance-manager.js`** — one conditional spread inside `buildStrandRuntime`'s
   `createLibp2pNode(...)` call (context: `dist/strand-instance-manager.js:246`,
   `dist/strand-instance-manager.js:260` — the `...(config.privateKey && { privateKey:
   config.privateKey })` neighbour the new spread sits beside). Contributes a `cohortTopic` key
   ONLY when the launch config's `strandCohortTopic` says so — a strict `enabled === true`, AND
   (when `strandIds` is a non-empty array) `strandIds.includes(strandId)`. Clears the substrate's
   own read at `@optimystic/db-p2p` `dist/src/libp2p-node-base.js:175`.
2. **`dist/cadre-node.js`** — one property threading `this.config.strandCohortTopic` through the
   `startStrand({...})` composition in `launchStrand` (`dist/cadre-node.js:3646`). Node-local only:
   never read from the replicated control database, a strand row, or a peer — the same discipline
   `56-04`'s `publicObserverStrandIds` allowlist follows.
3. **`dist/index.js`, one named constant** — `STRAND_COHORT_TOPIC_CONFIG_KEY`, a provenance token
   whose VALUE is the config key name this patch introduces (`'strandCohortTopic'`), mirroring the
   role `STRAND_OBSERVER_PROTOCOL` plays for `56-04` (`dist/index.js:89`:
   `export { StrandObserverService, STRAND_OBSERVER_PROTOCOL } from
   './strand-observer-protocol.js';`). This third edit is what lets `gateway.mjs`'s
   `checkProvenance` refuse to report a result from bytes that carry the first two edits' *shape*
   but not their *effect* — exactly the gap that made `STRANGER_OPEN_PROTOCOLS` a decorative patch
   the first time this package was touched.

## The invariants a forward-port may never relax

- **`dist/strand-addr-protocol.js` and `isAuthorizedMember` stay byte-for-byte untouched by BOTH
  patches (D-02).** This patch carries zero hunks against `dist/strand-addr-protocol.js` and zero
  against `dist/membership-connection-gater.js`. `56-04`'s patch file
  (`.yarn/patches/@serfab-cadre-core-npm-0.12.0-7ac3a744da.patch`) is asserted byte-identical by
  `git diff --exit-code` before and after this patch installs — a combined regeneration that
  "happens to" also rewrite the observer hunks would destroy that argument silently.
- **Fail-closed twice (master switch AND per-strand allowlist).** Absent/false
  `strandCohortTopic.enabled` ⇒ no `cohortTopic` property reaches `createLibp2pNode` AT ALL — not
  `cohortTopic: undefined`, because `@optimystic/db-p2p`'s own read
  (`dist/src/libp2p-node-base.js:175`, `options.cohortTopic?.enabled === true`) treats an
  explicitly-undefined key as a behavioural difference in a diff, not a no-op. A strand id outside
  a non-empty `strandCohortTopic.strandIds` gets the same nothing an unconfigured node gets.
- **Node-local only, never replicated (D-03's discipline, reapplied).**
  `this.config.strandCohortTopic` is read once per launch from the launch config the operator
  supplied to `CadreNode`'s constructor — never from the replicated control database, never from a
  strand row, never from a peer.
- **`wantK` is never set by this patch.** `@optimystic/db-p2p` resolves an unset `wantK` to its own
  default (`16`) on both the host and any subscriber that also leaves it unset — the substrate's
  own default, not a number this patch chooses. Setting it here (or setting it differently from
  what the browser subscriber resolves) would make the membership gate and a subscriber check the
  same coordinate for two *different* cohorts. Verify a forward-port never adds it: `grep -c
  '^+.*wantK'` against this patch file must stay `0`.
- **No host-profile override.** The strand node WANTS the host's own unset-profile default
  (`coreProfile()`, `@optimystic/db-core` `dist/src/cohort-topic/tiers.js:46` — willing at every
  tier, including the reactivity tier `Tier.T3` at `dist/src/cohort-topic/tiers.js:22`). Setting a
  profile here would risk narrowing willingness below what a serving gateway is FOR.
- **`minSigs` is a two-sided number and must be raised on both sides together.**
  `@optimystic/db-core`'s own default (`DEFAULT_MIN_SIGS`,
  `dist/src/cohort-topic/sig/threshold.js:16`) is `14` — unsatisfiable below a 14-member signing
  cohort. This deployment's serving cohort is a single strand node, so the origin's
  `strandCohortTopic.minSigs` and the browser's exported `PUBLIC_COHORT_MIN_SIGS`
  (`apps/VoteTorrentPublic/src/peer/edge-node.js`) must carry the IDENTICAL number — a subscriber
  configured for a different `minSigs` than the cohort that signs its certificates either verifies
  too little or rejects everything. Raising either without the other breaks reactivity, not
  security.

## The forward-port procedure

(a) **Read first.** Check the upstream delta for `@serfab/cadre-core` and any
`tickets/complete/*.md` in the sereus tree before spending time — the maintainers may have shipped
an equivalent config surface already (see "Upstream" below).

(b) **Install the new version UNPATCHED first and measure whether the patch is still needed.**
Bump the range and `yarn install` without a patch entry, then `grep -rl cohortTopic dist/` against
the fresh unpatched dist. If the maintainers added an equivalent node-local `cohortTopic` config
surface, run the mesh-read gate's rungs 4-6 against the **unpatched** bytes; if they pass, retire
this patch on the `56-04` sibling document's retirement precedent rather than forward-porting a
patch nobody needs. Prove a retired half, never infer it.

(c) **Otherwise, `yarn patch @serfab/cadre-core` and re-derive each of the three hunks against the
new bytes.** Do not blind-apply the old patch — `git apply` may succeed on stale line offsets
while silently landing hunks in the wrong place if upstream reordered nearby code. Specifically
re-read:
  - `buildStrandRuntime`'s `createLibp2pNode(...)` call — the spread must still contribute
    NOTHING (no `cohortTopic: undefined`) when the condition is false; a refactor that changes the
    neighbouring conditional-spread idiom needs the same treatment applied here.
  - `launchStrand`'s `startStrand({...})` composition — confirm `this.config.strandCohortTopic` is
    still node-local at the call site, not accidentally resolved through a cohort-seed RPC the way
    `bootstrapNodes` is.
  - `@optimystic/db-p2p`'s own `cohortTopic` option shape (`libp2p-node-base.d.ts`) — a version
    bump of `@optimystic/db-p2p` could rename `host.minSigs` or change the hard-fail-on-missing-FRET
    behaviour; re-read `dist/src/libp2p-node-base.js:1094-1120` before assuming the option shape
    carried over.

(d) **`yarn patch-commit -s <dir>`, then hand-repoint every `resolutions` key** — exactly
`56-04`'s document's step (d): the root `resolutions` bare-name key and the `@npm:<range>` key must
be edited by hand; re-derive the workspace descriptor set with `grep -rn '"@serfab/cadre-core"'
package.json apps/*/package.json packages/*/package.json` rather than trusting a prior count.

(e) **Re-run, in order:** the two version-lock guards, `yarn lint:peers`, the Authority app's
cadre-core Node smoke coverage (inertness — zero new failures against the pre-bump baseline), then
re-prove `56-04`'s invariants (byte-identical patch file, `strand-addr-protocol.js` sha256 against
a pristine tarball, observer-token exactly-once) and this patch's own `EFFECT_COHORT` rung in both
the enabled and disabled configuration. A green suite that never exercises the cohort-topic host
proves nothing — confirm `EFFECT_COHORT=PASS` reads a live `cohortTopicHost` before accepting the
bump.

## Explicit non-adoptions

- **No CI patch-integrity gate**, for the same reason `56-04`'s sibling document declines one: the
  guard is this document plus the gateway's own `EFFECT_COHORT` runtime rung, which exercises the
  actual behaviour rather than the patch's shape.
- **No `.d.ts` is patched.** `libp2p-node-base.d.ts`'s `cohortTopic` shape already exists upstream
  (in `@optimystic/db-p2p`, not `@serfab/cadre-core`) — nothing in `@serfab/cadre-core`'s own
  `.d.ts` surface needs a matching declaration because every consumer of this patch's new launch-
  config key is plain ESM (`gateway.mjs`), and `CadreNodeConfig`'s TypeScript shape is not this
  patch's to extend without also patching `.d.ts` forward-port cost for no current benefit.
- **No per-strand replicated visibility flag.** `strandCohortTopic.strandIds` is the SAME
  node-local, non-replicated shape `56-04`'s `publicObserverStrandIds` uses — there is no second,
  independently-editable list; `packages/p2p-probe-host/gateway.mjs` derives it from
  `publicObserverStrandIds` rather than accepting a second config key (see that file's own
  comment for why: the mesh-read origin's per-run override transcribes every key except
  `publicObserverStrandIds`, so a second list would go stale the moment that override fires).
- **`wantK` untouched** — see "The invariants a forward-port may never relax" above; this patch
  never sets it and never will without both sides moving together.

## Open security-posture questions for the maintainers

- **Enabling the cohort-topic host on a strand node registers the four cohort-topic protocols and
  the reactivity notify/recover protocols on a node an unauthenticated observer can now reach**
  (via `56-04`'s address-resolution path). Widening what a stranger may negotiate on that node is a
  genuine new security-posture question, not incidental to this patch.
- **The push-state-gossip authenticity gate is `fret.assembleCohort(coord, wantK).includes
  (fromPeerId)`** (`@optimystic/db-p2p` `dist/src/libp2p-node-base.js:1283`). In a small network
  (e.g. `wantK`'s default of 16 against a 2-peer deployment), that assembled set can include an
  anonymous peer — cohort membership is not a meaningful authorization boundary at small `n`. This
  is upstream's own authenticity model, not something a node-local config key can fix.
- **`@optimystic/db-core`'s `DEFAULT_MIN_SIGS` of 14 is unsatisfiable below a 14-member cohort**,
  which pushes every small deployment (this one included, at `PUBLIC_COHORT_MIN_SIGS = 1`) to a
  threshold of 1 — a signature-count floor that provides essentially no protection against a
  single malicious or compromised signer in a small cohort. Whether the substrate should offer a
  documented, deliberately-weak "small deployment" mode, versus leaving every small deployment to
  discover this by reading source, is a question for the maintainers, not a decision this patch
  makes on their behalf.

## Upstream

This is an **issue-only** filing (`56-15`'s job, not this patch's) — VoteTorrent does not push a
pull request to sereus for this change. The connection-level widening and the small-`n` cohort
question above are genuine open questions for the maintainers, not bug reports against existing
behavior; this document only states them so `56-15` can carry them into the issue without
re-deriving them. If sereus ships an equivalent node-local `cohortTopic` config surface, adopt
theirs and retire this patch rather than maintaining two competing designs — see step (b) above.
