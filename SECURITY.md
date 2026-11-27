# Security

The product-level security record for VoteTorrent: the decisions about **what data is published**,
the threats those decisions create, the **gates that bear on them**, and the **deployment
requirements** that outlive any single phase of work.

## What this file is, and three things it is not

It is a durable record. An entry here is meant to be inherited by the next reader rather than
rediscovered.

1. **It is not a vulnerability-disclosure policy.** This project has not made that decision, and
   this document does not invent one. Where to report a suspected vulnerability is not settled
   here, and no intake channel is implied by this file's name or location.
2. **It is not a phase audit.** Per-phase threat registers and their verdicts live in
   `.planning/phases/NN-*/NN-SECURITY.md` and are graded by `scripts/verify-security-controls.mjs`.
3. **It records no control as CLOSED.** It records decisions, threats, and the gates that bear on
   them. A verdict of "closed" is the phase auditor's to issue and is never issued by this file.

Why it sits at the repository root: `.planning` is gitignored (`.gitignore:101`), as is `.claude`
(`.gitignore:103`), so a decision recorded in either place is invisible to anyone reading the
product tree on a fresh checkout.

---

## Published data decisions

### PD-01 — `RegistrantPublic` is published on the anonymous public election view

**Status: MADE** — 2026-09-02, during phase 54's discussion of the public no-login election view
(decisions D-18, D-20, D-21). This entry is the record; the phase artifacts are not part of the
product tree.

**What is published.** `LastName`, `FirstName` and `District` — and only those three columns — for
the registrants of one addressed election. They render inline with the other public facts rather
than behind a reveal gate (D-20).

**What is not published.**

- `ExtraFields` is **never** rendered (D-19). The schema documents it as *"json object for
  authority-specific public fields"* (`packages/vote-core/schema/votetorrent.qsql:1818`) — that is,
  unconstrained authority-supplied JSON, with no schema to reason about and no review step between
  an authority writing it and a reader seeing it.
- `RegistrantSelective` is not read at all by the public view. Rendering its `everyone` subset
  requires selective-disclosure handling over salted leaves that no code in this repository
  implements (D-22).
- `RegistrantPrivate` is never readable from the public entry.

**Reasoning, as three named grounds.**

1. **It is the schema's designated public projection of a registrant**, and is named accordingly —
   the table declaration at `packages/vote-core/schema/votetorrent.qsql:1812` carries the public
   name columns and nothing private.
2. **Each row is attributable.** Registrant records are signed by the authority under the `vrg`
   ("validate registrations") signing scope — the schema ties a registrant signature task to an
   `AdminSigning` session with `Scope = 'vrg'`
   (`packages/vote-core/schema/votetorrent.qsql:1372`) — so a published row is tamper-evident and
   traceable to an authority rather than being an unattributed dump.
3. **Published voter rolls are ordinary practice** in many jurisdictions, so publishing one is not
   a novel exposure so much as a choice about which jurisdictional norm this software encodes.

**The schema finding that reframed this decision (a correction to spike 087).**
`ElectionDisclosurePolicy.FieldName` is documented as *"a top-level attribute name within
`RegistrantSelective.SelectiveDetails`"* (`packages/vote-core/schema/votetorrent.qsql:2300`).
The two-audience `DisclosureAudience` policy therefore governs **`RegistrantSelective` only**;
`RegistrantPublic` has **no per-field audience lever at all**. Spike 087 classified both tables
`POLICY_GATED`
(`.claude/skills/spike-findings-votetorrent/sources/087-public-observable-inventory/classification.js:54-55`).
That was wrong for `RegistrantPublic`. Stated plainly: **only one of the two tables ever had a
policy.** The corrected classification is `packages/web-data/src/classification.js`, where
`RegistrantPublic` is `PUBLIC`.

**What this supersedes.** The spike synthesis previously read *"Publishing it anonymously is a
policy decision nobody has made."* That note is retired by this entry. A reader who meets it in an
older copy should treat PD-01 as its successor.

**How to reverse it.** Move `RegistrantPublic` back to a non-public class in
`packages/web-data/src/classification.js`. The roll's read then fails closed **at import** —
`FORBIDDEN_CLASSES` membership makes a public module naming the table a crash rather than a review
miss — and the forbidden-table scan and query-shape gates enforce the reversal with no further
edit. Encoding the policy as a classification rather than an allowlist is what makes the reversal a
one-line change instead of an audit (D-15).

---

## Threats

### TH-01 — Anonymity boundary of the public election view

**Category:** Information Disclosure (STRIDE) · **Disposition:** mitigate · **ASVS:** L1

**Boundary.** An anonymous reader — no login, no identity, no device key — reaching the source set
of the public entry (`apps/VoteTorrentPublic/src` and `packages/web-data/src/public`).

**Threat.** A future edit makes reachable from the public entry a table carrying registrant PII
beyond the three columns of PD-01, private key material, or an unsigned `Proposed*` draft row.

| Control | Mechanism | Gate that proves it |
|---|---|---|
| Audience split (structural, primary) | `@votetorrent/web-data` splits by audience into `./public` and `./officer`; nothing reachable from `./public` may reach `./officer` by any specifier form — relative traversal, barrel re-export, deep import, bare subpath or dynamic specifier. Specifiers are resolved, not word-matched; an unparseable dynamic import is a failure. | `packages/web-data/test/audience-boundary.test.mjs`, with planted-violation controls |
| Forbidden-table source scan | Forbidden names are derived from `CLASSIFICATION` crossed with `FORBIDDEN_CLASSES`, never hand-listed; comments are stripped before matching; a positive control is required so "no leaks" cannot pass vacuously. | `packages/web-data/test/anonymity-scan.test.mjs` |
| Query shape | The roll's select list is **set-equal** to exactly `LastName`, `FirstName`, `District` — set equality, not containment, so a fourth column fails. The key-release aggregate joins `ReleaseKeyTaskExtension` to `Task` because the completion flag lives on the parent (`Task.IsCompleted`, `packages/vote-core/schema/votetorrent.qsql:1138`), and its select items must all be `count(`/`sum(` forms, so no bare column — `Task.Id` included — can appear in the select list at all; `ExtraFields`, `SigningNonce` and `UserId` are additionally banned from **any** clause of a public statement. Together these stop a result identifying *which* keyholder released. | `packages/web-data/test/query-shape.test.mjs` |
| Classification drift | `CLASSIFICATION`'s key set is set-compared against the `table` declarations parsed live from `packages/vote-core/schema/votetorrent.qsql`, so a newly added table fails on the schema edit rather than on the first read. | `packages/web-data/test/classification-drift.test.mjs` |

All four run with one command: `yarn workspace @votetorrent/web-data test`.

**Proof level of the four rows.** Rows 1, 2 and 4 are **source-scanned** — they read files and
resolve module graphs, and they execute in tier 1 with planted-violation controls. Row 3 is
**statement-shape asserted** against the exact SQL constants the read layer exports, with each
control mutating a real constant rather than a synthetic string. **None of the four is
browser-rendered** — for the rendered roll, see the browser-tier gate cited in *What these controls
do not prove* below.

#### What these controls do not prove

This subsection is the reason the section exists. Read it before citing anything above as a
guarantee.

- The forbidden-table scan is a **static source scan**. It proves that no forbidden table name
  appears **as code** in the public entry's file set. It does **not** prove the rendered page is
  anonymous: it cannot see a value reaching the DOM through a variable, a prop or a serialized
  blob, and it cannot see a table it does not know is forbidden, because the classification itself
  could be wrong.
- **Nothing in the table above proves anything about rendering.** The gates say so themselves: the
  query-shape gate *"reads STATEMENTS, not RESULTS … it cannot see what the render layer does with
  three permitted columns"*, and the roll's own tier-1 gate opens with *"nothing below renders …
  Presence is not rendering — this repo has shipped two defects on exactly that gap"*
  (`apps/VoteTorrentPublic/test/node/registrant-roll.test.mjs:14-19`). **That gate has since
  landed** (`apps/VoteTorrentPublic/test/browser/render-fidelity-gate.mjs`, run by
  `yarn workspace votetorrent-public test:render-fidelity`): against a seeded surface in a real
  browser, `roll-fields-rendered` finds the three columns and four rows;
  `roll-hides-extrafields-and-superseded` finds zero occurrences of the `ExtraFields` marker or the
  superseded record in `document.body.innerHTML`; and `roll-escapes-authority-text` finds zero
  injected elements from an XSS-shaped registrant name. Every comparator is exercised **both ways**
  under `--prove-matchers` — failing on a violating input and passing on a healthy one — because a
  comparator that fails on everything proves nothing. **This is a real rendering proof, and it is
  still an assertion over one fixture: it is not a proof about every authority's data.**
- The roll's **read** is data-proven rather than only source-scanned: `readRegistrantRoll` returns
  the expected rows against a real seeded database, and a positive control that removes the
  `RP.Cid = R.PublicCid` pin shows the superseded record would otherwise be published
  (`apps/VoteTorrentPublic/test/node/public-fixtures.test.mjs`). That gate also states its own
  limit — the result holds **within one process against `fake-indexeddb`**, and says nothing about
  what reaches a page.
- **No control here proves the browser's IndexedDB holds only publishable rows.** It holds whatever
  the bootstrap redemption wrote, which is an officer-scoped dataset. The guarantee is entirely
  about **what the page reads**, never about **what the database holds**.
- A gate proves a line exists and runs in test. It does **not** prove the shipped page routes
  through it. That distinction is called out here rather than assumed because this repository has
  already paid for assuming it — see `scripts/verify-security-controls.mjs:8-24`, which records a
  security document that marked nine threats CLOSED while the nine controls, though real, correct
  and unit-tested, were referenced nowhere outside their own package and their spec files: nothing
  in the shipping app knew they existed. That document stopped anyone looking for eleven days.

### TH-02 — Reader unlinkability on the live public election view

**Category:** Information Disclosure (STRIDE) · **Disposition:** mitigate, for the claim;
accept-and-disclose, for the network exposure · **ASVS:** L1

**Status: MADE** — 2026-09-04. TH-01 is about *what the page reads*. TH-02 is about *what a reader
leaves behind*. It supersedes nothing in TH-01 and sits beside it.

**Boundary.** An anonymous reader — no login, no identity, no device key — whose browser joins the
network directly as a libp2p Edge node over WSS and dials a bootstrap gateway operated by someone
else.

**The claim, in exactly two clauses.** There are **two**, and this document says so on purpose: a
later editor who adds a third is amending this entry, not clarifying it.

1. **No durable identifier links visits.** The reader's libp2p identity is generated per tab and
   held in `sessionStorage` under a single named slot
   (`apps/VoteTorrentPublic/src/peer/identity.js:49`): it survives a reload and dies with the tab.
   The persisted browser-key helper that ships in the optimystic web-storage package — whose own
   docstring sells a stable, reload-surviving identity — is not used, because a stable identity for
   an anonymous reader is a durable tracking identifier.
2. **The query layer discloses nothing beyond the declared public reads.** This clause is **not new
   and is not re-derived here**: it is **TH-01**'s, carried unchanged, because the read layer is
   source-agnostic and this phase of work changed only what fills the store. See TH-01 above for the
   mechanism and its four gates.

**The proof level of clause 1, stated before the table rather than after it.** Clause 1 is proven at
the **module** level and is **unproven at the property level**. The mechanism exists and is
unit-tested. The property — two real page loads producing different peerIds *as observed at the
gateway* — is a materially stronger and different claim, and the control that would establish it was
designed and **has not been built**: no run this project has recorded shows a completed
browser-to-gateway connection for such a control to observe. That gap is tracked in the planning
record, which is not part of the product tree, exactly as PD-01 already notes for its own phase
artifacts. Until that control exists and passes, clause 1 is a statement about a unit-tested
mechanism and **not** about behaviour observed at a gateway. This entry deliberately names no gate
for the property, because naming a gate that does not exist is precisely the failure this document
records against itself a few lines above.

| Control | Mechanism | Gate that proves it |
|---|---|---|
| Ephemeral per-tab identity (module level) | `apps/VoteTorrentPublic/src/peer/identity.js` generates a fresh Ed25519 key per tab into `sessionStorage` under one named slot; the persisted reload-surviving helper is never imported. | `apps/VoteTorrentPublic/test/node/session-peer-identity.test.mjs` — 8 subtests, including *two calls against the SAME storage return byte-identical public keys*, *two DIFFERENT storage objects return different public keys*, and *exactly one slot written*. Both halves of the reuse/freshness contract; one without the other would prove nothing. |
| Cross-load unlinkability (property level) | The same mechanism, observed from outside — different peerIds across two real page loads at a gateway. | **None. Unproven, not disproven.** The control is designed and unbuilt; its blocker is an unobserved browser-to-gateway connection, tracked in the planning record. |
| Query-layer disclosure | Unchanged from TH-01. | The four gates TH-01 names — `packages/web-data/test/audience-boundary.test.mjs`, `packages/web-data/test/anonymity-scan.test.mjs`, `packages/web-data/test/query-shape.test.mjs`, `packages/web-data/test/classification-drift.test.mjs` — run by `yarn workspace @votetorrent/web-data test`. |
| Per-strand store isolation | One browser database per strand, so one election's cached rows are not readable through another's store. | `apps/VoteTorrentPublic/test/node/strand-storage-isolation.test.mjs` |

**What was deliberately not built.** Three mechanism-level anonymity controls — an import-closure
scan for the persisted key helper, a runtime assertion over the web database's key-value object
store, and a negative control on that scan — were considered and **not adopted**. The choice was to
prove the property rather than multiply instruments. Recording the choice is what stops a later
reader treating their absence as an oversight and re-adding them as obvious hygiene. Note the
consequence honestly: the property-level control that was chosen instead is the one that has not
been built yet, so at present neither the mechanism scans nor the property proof exists — only the
module-level unit contract in the table above.

#### What a gateway operator can observe

The other half of the sentence, stated plainly. An operator of the bootstrap gateway a reader dials
can see:

- the reader's **source IP**, and the connection's time and duration;
- the **ephemeral peerId** for that tab's lifetime;
- the **protocol IDs** negotiated;
- **which election was asked for** — the requested strand id is the network hash, so the request
  names the election;
- and that they **can correlate all of these with each other**, and with anything else they hold.

None of this is mitigated by anything in this repository. It is inherent to dialling a peer
directly. The alternatives that would remove it are ruled out by the project's liveness and
decentralisation constraint.

#### What this claim is not

- **It is not a claim of anonymity.** A gateway operator sees the list above. Nothing here hides a
  reader from the node they connect to.
- **It does not rest on operator behaviour.** No mitigation in this entry takes the form "the
  operator will not log it". That shape was considered and rejected, because it would depend on
  behaviour that cannot be verified from inside this tree — the same unenforced-assumption shape
  that left "the web gates run in CI" untested across two phases of work.
- **It says nothing about a network-level observer.** TLS hides the payload; it does not hide that a
  browser connected to a gateway.
- **It is scoped to unlinkability across visits.** Within one tab, requests are trivially linkable
  by design — that is what the session key is for.

### OB-01 — `AdminSigning.Scope` is not cross-checked against the signing officer's `Officer.Scopes`

**Status: RECORDED — not assessed.** Surfaced during phase 54's voter-roll fixture work, then
re-derived against the schema for this entry. No impact analysis has been done and no disposition is
claimed.

`AdminSigning` carries a `Scope` column (`packages/vote-core/schema/votetorrent.qsql:240`). Its
`ScopeValid` constraint checks only that the value exists in the `Scope` view
(`packages/vote-core/schema/votetorrent.qsql:246`), and its `UserIdValid` constraint checks only
that the instigating user is an officer of the referenced administration
(`packages/vote-core/schema/votetorrent.qsql:247-252`). Neither checks that the officer's own
`Scopes` array contains the scope being exercised. Observed consequence, in this repo's own
fixtures: the founding officer is seeded with `Officer.Scopes = ["mel","ceb"]`
(`packages/web-data/test/fixtures/seed-founding-authority.js:47`), and the registrant-roll fixture
nonetheless completes `AdminSigning` sessions carrying `Scope = 'vrg'`
(`apps/VoteTorrentPublic/test/fixtures/registrant-roll-fixture.js:289`). Whether that is a real
authorization gap, or an intentional separation of a signing session's scope from the instigating
officer's scope set, has **not** been determined here.

Scope checks against `Officer.Scopes` **do** exist at specific sites — for example
`packages/vote-core/schema/votetorrent.qsql:113` requires a `rad`-scoped officer — so this is an
absence at one site, not a general absence of scope enforcement. Recorded here so it is inherited
rather than rediscovered; assessing it is future work.

---

## Deployment requirements

### DR-01 — the public election view reads only same-origin data

**Status: ANSWERED 2026-09-03, then SUPERSEDED the same day by a design decision; tree state
re-derived and updated 2026-09-04, when the Edge-subscriber path shipped into the source tree.**
Asked whether
the two apps would be served from one origin in production, the project owner answered: *"they are
not supposed to be served from one origin in prod at all."*

**The answer stands; its consequence has changed.** The owner then chose the live-peer data path
(see `.planning/STATE.md`, decision of 2026-09-03): the public view becomes a libp2p **Edge
subscriber** that reads the network directly and receives push updates, rather than reading a
database some other app populated. Liveness and decentralisation are a hard constraint on that
choice — a published-snapshot or read-only-endpoint compromise was explicitly ruled out.

**Under that design, separate origins is CORRECT rather than fatal.** The public view's IndexedDB
stops being a store it must be handed and becomes its own local cache of what it read from peers.
Origin partitioning then isolates the anonymous reader from the officer's data, which is the
property this section wanted in the first place.

**What is true in the tree as of 2026-09-04, re-read from the source rather than carried forward:**
three things, and the third has changed.

*The Edge-subscriber path has shipped into the source tree.* `apps/VoteTorrentPublic/src/peer/`
holds the peer layer — the bootstrap-config loader, the ephemeral identity, the browser Edge node,
the reactivity bridge and the strand read. `apps/VoteTorrentPublic/src/screens/PublicApp.tsx:10`
owns the single production call site of the peer boot, and `apps/VoteTorrentPublic/src/main.tsx`
mounts that component. Shipping into the tree is not the same as reaching its proof bar: the
end-to-end browser gate for the mesh read has **not** certified, which is recorded as a non-claim
below rather than left implicit here.

*Network resolution is unchanged, and the old citation still holds.* The public entry still resolves
which network to open through `listNetworks`
(`apps/VoteTorrentPublic/src/election-index-source.js:59`), which reads the **dashboard's** registry
key, `'votetorrent.dashboard.networks'` (`packages/web-data/src/networks-registry.js:23`). That was
checked by reading both files, not assumed from the previous version of this paragraph.

*"No write path of any kind" is no longer literally true and must be restated.* The imported surface
has widened past the five names this paragraph used to list: the change-propagation seam is imported
at `apps/VoteTorrentPublic/src/screens/use-public-election.ts:2`, the peer-write notification and the
subscribed-table allowlist at `apps/VoteTorrentPublic/src/peer/reactivity-bridge.js:187`, and the
store handle at `apps/VoteTorrentPublic/src/peer/boot.js:154`. The bridge writes rows it received
from peers into this browser's **own local cache**
(`apps/VoteTorrentPublic/src/peer/reactivity-bridge.js:453`). What remains true is narrower, and it
is the property this section wanted: **no write leaves the browser.** There is still no insert of
reader-supplied data, no bootstrap redemption and no registration path anywhere in the public entry.

What a reader now gets, and what it costs them, is TH-02 above and
`## Non-claims and accepted residuals` below.

This was never a defect in any control below; the controls are correct and were verified. It was a
gap in **D-01**, which fixed the data *source* on a premise the intended deployment does not
satisfy. D-01 is superseded by the Edge-subscriber decision.

The paragraphs below are retained unchanged as the analysis that produced this answer.

**The mechanism.** `apps/VoteTorrentPublic` reads election data from the browser's own IndexedDB
(D-01: an anonymous reader's data comes from an already-bootstrapped browser). IndexedDB is
strictly partitioned by origin — scheme, host and port — so a database written under one origin is
not readable from another.

**The measurement.** The app that writes that database, `apps/VoteTorrentDashboard`, is served on
port 5180 (`apps/VoteTorrentDashboard/package.json:8`,
`apps/VoteTorrentDashboard/vite.config.ts:44`). The public view is served on port 5181
(`apps/VoteTorrentPublic/package.json:8`, `apps/VoteTorrentPublic/vite.config.ts:56`). In
development these are two different origins, and a database written by the dashboard is therefore
invisible to the public view.

**The requirement.** For the real-data path to activate for any reader, the app that writes the
database and the public view must be served from **one origin** — the same scheme, the same host
and the same port, differing only by path.

**This is an unresolved precondition, not a description of anything.** It is not currently
confirmed that any production deployment satisfies it, and no artifact in this repository settles
the question. Until it is confirmed, the real-data path should be treated as **conditional and
unproven in production**, and the honest-empty-state copy carries substantially more weight than
the phase that wrote it planned: if the two apps are served from different origins, the empty state
stops being an edge case and becomes what **every** visitor sees.

**The failure mode if the requirement is not met.** The public view renders its empty state —
*"This browser holds no elections yet."* (`packages/ui-web/src/copy.js:662`) — for every visitor,
with no error and no technical symptom. That is the origin partition working exactly as designed,
but it presents as a UI bug, which is what makes it expensive to diagnose.

**Why no gate covers this.** Every gate seeds IndexedDB under its own harness origin by
construction, so a same-origin harness is green whether or not production is same-origin. This
class of defect is structurally invisible to the test suite. That is precisely why it is recorded
as a requirement for a human to confirm rather than asserted by CI.

**Explicit non-claim.** This document states a requirement and **makes no claim about how the
product is or will be deployed.** D-01 fixed the *data source*; it never made a *deployment* claim,
so this is a gap in the decision record rather than a contradiction of it. Nothing in this section
should be read as saying the two apps are, or are planned to be, served from one origin. A future
answer of "yes, same origin is intended" would confirm an **intent**; it would still not describe a
deployed system, and this section must keep saying so.

---

## Non-claims and accepted residuals

These are limits this project knows about and has chosen to live with. They are recorded here, in
the product tree, for one reason: a limit recorded only in a planning artifact is invisible on a
fresh checkout, because `.planning` is gitignored (`.gitignore:101`). Carried across, they are
inherited. Left there, they are gone.

Each entry states the limit first, then why it was acceptable, then what would close it.

### NC-01 — Nothing limits how many anonymous peers may ask a gateway for data

A **known non-mitigation**, in those words. What bounds it today is inherited rather than designed:
per-service concurrent inbound stream caps, a per-frame size cap, a read timeout, libp2p's own
connection-manager limits, and — only with relay enabled — the unauthorized-relay-reservation
budget. **None of these is a rate limit.** The strand allowlist bounds *what* is served; it never
bounds *how many* peers may ask.

Acceptable because it is arguably the upstream project's design call rather than this project's, and
because the gateway that runs this configuration is operated deliberately by someone who chose to
serve anonymous readers. Raised and set aside on that basis, and filed upstream as an open question
rather than silently absorbed. What would close it: rate limiting in the core, or an operator-placed
limiter in front of the node. See the named non-mitigation section of `doc/public-gateway-deploy.md`.

### NC-02 — "Reachable from the open internet" is an explicit NON-CLAIM

What was proven is a locally-running WSS gateway with a real certificate chain, plus a written
deploy recipe. **Nothing demonstrates a gateway reachable from the public internet**, and nothing in
this repository may quietly imply otherwise.

Acceptable because reachability is a deployment property, not a code property, and this document
does not make deployment claims (DR-01 says so in its own voice). It is machine-readable in the
gateway's runtime handoff `nonClaims` array as well as prose, so it survives a reader who never
opens `doc/public-gateway-deploy.md`. What would close it: a recorded measurement against a
genuinely public address.

### NC-03 — The React Native bootstrap-config change is proven in jest only

No device run backs it. The device proof was accepted as deferred **at decision time, with the
counter-example in front of the decision**: this project has already watched a green Node gate on a
peer-to-peer config change get refuted by a four-device run.

Acceptable because it was a stated, priced trade rather than an oversight, and it is filed as a
tracked debt item with a runnable procedure. That item lives in the planning record, which is not
part of the product tree — the same caveat PD-01 already carries for its own phase artifacts. What
would close it: running that procedure on hardware.

### NC-04 — Rows written by a peer are not re-validated

The ingest path re-validates **nothing**: no CHECK, no NOT NULL, no UNIQUE and no child-side
foreign-key existence runs on rows arriving from a peer
(`packages/web-data/src/public/subscribe.js:332` records this against the upstream API's own
documented behaviour). The subscribed-table allowlist bounds **which tables** may be written; it
never bounds row **content**.

Acceptable because the trust root is the strand's threshold-signed commit, and that is the same
trust root the entire mesh read already rests on. A cohort that signs a bad revision writes bad rows
into an allowlisted table and the page renders them, and a reader holding no key cannot re-check
that locally. What would close it: local re-validation of ingested rows, which would need the reader
to hold a schema-level validator the read path does not currently run.

### NC-05 — The transport key is briefly at rest where any script on the origin can read it

It lives in `sessionStorage` (`apps/VoteTorrentPublic/src/peer/identity.js:49`). This is the accepted
cost of the per-tab session boundary, chosen deliberately over a memory-only key, which would pay a
full reconnect-and-resubscribe cost on every same-tab reload.

Bounded by what the key *is*: a transport identity that signs no election record, holds no schema
scope, and grants no read an anonymous peer does not already have. It does not survive tab close. An
attacker who can already run script on the origin owns the page regardless. What would close it: a
non-extractable key held only in memory, at the reload cost above.

### NC-06 — A peer feed that starts and then silently loses every connection is not observed

The page reports a feed that stopped and a feed that never started. It does **not** detect a feed
that is up but has no connections.

Closing it needs either a second connection-state signal path, or a no-write-in-N-minutes heuristic
— and the heuristic was **rejected on the record**, because there is no expected write cadence for
an election and a timeout would manufacture a false "not connected" on a quiet but healthy page.
This is why the only positive liveness claim the page makes is a badge reporting an update that was
actually observed, rather than a claim about the connection.

### NC-07 — An anonymous reader has no independent anchor against the gateway it bootstraps from

A gateway that is also the only reachable serving cohort can present a self-consistent,
correctly-signed alternate strand for a network, and a reader with no key and no second source
cannot tell.

Inherent to bootstrapping from an operator-supplied address list. Two real bounds, neither of which
closes it: the schema is supplied from the application bundle, so a gateway cannot substitute one to
widen the read surface or change what a column means; and the read surface is a frozen table
allowlist, so a gateway cannot induce a read outside it. What would close it: a second, independent
source of the strand's head, which the current bootstrap shape does not provide.

### NC-08 — What the patch-removal control would prove, and what it does not

The dynamic revert-and-restore control — rebuild with the local change genuinely reverted, require
the proof bar to become unreachable, require it to return on restore — **was not run this round.**
Its bar was never reached, so a revert would have reported a red for a reason unrelated to the
revert. It is deferred with a filed blocker, not abandoned, and it is named here so that no reader
mistakes its absence for the absence of evidence.

What does stand is a composition of three controls that were run:

- `packages/p2p-probe-host/wall-proof.mjs` — the layered refusal against a node with authorized
  members present;
- `packages/p2p-probe-host/observer-controls.mjs` — the members-only non-regression and the
  fail-closed strand allowlist;
- `packages/p2p-probe-host/repro/public-observer-blocker.test.mjs` — the self-contained repro that
  refuses to run when its two mode signals disagree.

**No one of these supports the claim alone.** The first is a connection-layer measurement, the
second and third are protocol-layer measurements, and it is their composition that carries the
argument. Recorded here so a later reader cannot over-read a single result in either direction.

### NC-09 — Whether the strand SQL layer imposes its own membership expectation: measured, and it does not

This was a real escalation risk — a fourth wall would have resized the work — so it was measured
rather than assumed, with the escalation path agreed in advance: record the originating `file:line`
in the upstream package and halt, rather than work around it.

**Observed outcome, read from the execution record:** it did not surface. A cold, anonymous,
non-member strand-database initialize against a strand that exists nowhere, with no reachable
bootstrap peer, **resolves rather than rejects**, in roughly 0.1 to 1.6 seconds, with the transactor
reporting `network` and a real-schema select returning zero rows. No fourth wall was found at the SQL
composition layer. This is the opposite of the feared result, and it is recorded as an observation
rather than a hypothetical.

### NC-10 — This work depends on two package patches, not three

The two are `patches/serfab-cadre-core-public-observer.md` and
`patches/serfab-cadre-core-strand-cohort-topic.md`, each a written forward-port record beside the
pinned patch it describes. (2026-10-09: the strand-cohort-topic patch is retired on cadre-core
1.14.0 — cadre-core's own `strandReactivity` replaces it, without `minSigs` — so one patch remains.) A third patch was anticipated by an earlier plan's text and **was never
authored** — the design was superseded before a line of it was written.

This entry exists so a later reader does not go looking for a third dependency because an older
document implied one. Neither of the two that exist has landed upstream; both carry their own
forward-port record; a future version bump of the patched package must re-verify **both, and only
both**.

### NC-11 — Three predictions about the peer layer's registration behaviour remain unproven

Recorded because they are easy to mistake for settled facts about anonymity or liveness. None is
refuted; none is confirmed.

- *The browser's coordination registry stays empty on a healthy run* — no healthy run has ever been
  reached to measure it against. The non-zero registry size seen across three follow-on measurement
  sessions is evidence about the **failure** mode, not about the healthy-run claim.
- *No inbound registration frame is observed at the origin* — no instrument counting inbound frames
  by destination peer exists on this tree, and none of the three follow-on sessions built one.
- *The renewal cadence is one third of the time-to-live* — the renewal timer is scheduled only after
  a successful registration, which has never occurred on any run driven so far.

### NC-12 — The end-to-end mesh-read proof bar never certified, and three controls are deferred behind it

**The headline fact this section exists to carry across.** The browser gate that would prove an
anonymous reader completes a live mesh read is recorded as **CERTIFIED: NO**. It reaches
**4 of 10 rungs**, deterministically, on every run recorded — furthest rung reached is rung 4, "the
Edge node connects to the gateway", and rungs 1, 2, 3 and 7 pass while 4, 5, 6, 8, 9 and 10 fail.
The named failure is that the reactivity transport is not enabled on either side. That is the shared
root cause of everything else in this entry.

Three controls are consequently **deferred rather than run**, each an explicit non-claim with a
filed blocker as its pointer, never a silence:

- **The dynamic revert/restore proof** of whether the package patches are load-bearing beyond the
  static wall and non-regression evidence already recorded in NC-08. Nothing is claimed about it.
- **The liveness inversion** — whether the peer-write notification statement is the sole carrier of
  liveness. Nothing is claimed about it.
- **Cross-load peerId unlinkability as a property observed at the gateway** — TH-02's clause 1 at
  the property level. The module-level unit contract in TH-02's table stands unaffected; the
  property-level proof does not exist yet.

All three blockers are filed in the planning record, which is not part of the product tree. What
would close this entry: reaching the mesh-read bar, after which each of the three controls becomes
runnable in turn.

---

## Scope and maintenance

This file carries decisions, threats and requirements that **outlive a single phase** of work:
what is published and why, the threats that publication creates, the gates that bear on them, and
the deployment conditions no test can check. It does **not** carry per-phase threat registers or
their verdicts — those live in `.planning/phases/NN-*/NN-SECURITY.md` and are graded by
`scripts/verify-security-controls.mjs`.

One rule this file obeys, mirroring the rule that checker states about itself: a `path:line`
citation here is a **human, reviewed edit** — never a machine rewrite. A citation that has drifted
is a finding to be read and corrected by a person, because a tool that silently re-points a
citation would destroy the only evidence that the underlying claim moved.
