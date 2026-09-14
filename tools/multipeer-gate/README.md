# multipeer-gate

A standalone Node gate for the **n=4 Sereus/Optimystic multi-peer topology**: two
always-on relay/storage drones plus two peers that are reachable *only* through a relay.

It answers one question — **is the multi-peer path actually unblocked?** — and when the
answer is no, it names the earliest broken link instead of leaving you with "replication
failed".

It depends only on published packages. No VoteTorrent code, no app, no Android, no
emulator. Upstream maintainers can point it at a candidate build; it doubles as a
regression test.

## Run it

There are **two gates**. They run the same legs over the same node options; they differ
only in where the nodes live, and that difference is itself a measurement — see
[Two shapes](#two-shapes-one-process-or-one-process-per-node).

```bash
cd tools/multipeer-gate
npm install

node multipeer-gate.mjs    # all nodes in ONE process
node multiproc-gate.mjs    # one OS process per node — nothing shared but the host
```

Node >= 22. Exit `0` when every leg passes, `1` at the first failure.

A real summary, from `multiproc-gate.mjs` on db-p2p 0.29.0 / cadre-core 0.12.0:

```
──────────────────────────── SUMMARY ────────────────────────────
 PASS       L0  dependency-provenance
 PASS       L1  control-reachability
 PASS       L2  relay-reservation
 PASS       L3  cadre-authorization
 PASS       DD  dial-through-relay
 PASS       L4  strand-cohort
 PASS       L5  replication
 PASS       D1  replication-reverse
 PASS       D2  convergence-all-members
 PASS       D3  concurrent-writes
 FAIL       D4  mutation-propagation
 PASS       D5  isolation-control
 FIXED      L6  replication-factor
 FIXED      L7  late-joiner-convergence
 FIXED      L8  durability
─────────────────────────────────────────────────────────────────
MULTIPROC-GATE: FAIL at D4 (mutation-propagation) — 15 leg(s) ran.
Shape: one OS process per node, all on this host.
```

`FIXED` and `KNOWN-RED` mark the standing reproductions and never decide the verdict; only
`PASS`/`FAIL` legs do. `FIXED` means a leg kept as a known-red has gone green — worth
checking whether the defect it watches is actually closed.

Before trusting a red data leg, check the instrument:

```bash
npm run selftest    # the data legs against ONE node — every line must be green
```

A leg that has only ever been seen red is an untested assertion, not evidence. The
self-test removes replication from the picture so a red line there means the harness is
broken and any gate result depending on that leg should be discarded.

To test a candidate build, point the dependency at it (`npm install
@optimystic/db-p2p@<version>` / `@serfab/cadre-core@<version>`) and re-run.

[`repro/`](./repro/) holds the standalone reproductions for the upstream defect this gate
found — two `node --test` files, ~200 ms, no cadre-core and no sockets. Run
`node --test repro/*.test.mjs`.

## Topology

| node | profile | addressing |
|---|---|---|
| `drone-A` | `storage` | relay server ON, direct ws listen. **Founder.** |
| `drone-B` | `storage` | relay server ON, direct ws listen. Joins A. |
| `peer-A` | `transaction` | **relay-only** — listens on `<relay>/p2p-circuit` only |
| `peer-B` | `transaction` | **relay-only** — listens on `<relay>/p2p-circuit` only |

The peers get **no direct listen address**. That is the point: a sibling cannot reach
them except through a relay, and that constraint is where every multi-peer bug in this
topology has lived.

## The legs

Legs are **ordered and short-circuit**, so a failure is the earliest broken link rather
than a downstream symptom.

| leg | asserts |
|---|---|
| **L0** dependency-provenance | the installed tree is the tree `package.json` declares, resolved once |
| **L1** control-reachability | every node holds >= 1 control connection; the founder sees all of them |
| **L2** relay-reservation | each relay-only peer holds >= 1 reservation, counted by **distinct relay identity** |
| **L3** cadre-authorization | the relay-only peers are **authorized cadre members** |
| **DD** dial-through-relay | every drone holds a circuit address for every peer **and actually dials it** — reported as fresh or reused |
| **L4** strand-cohort | every strand node assembles a cohort larger than itself |
| **L5** replication | `peer-A` writes a row; `peer-B` reads it back |
| **D1** replication-reverse | `peer-B` writes a row; `peer-A` reads it back |
| **D2** convergence-all | **every** member reads **every** row — not just the one sibling L5 samples |
| **D3** concurrent-writes | both peers write at the same instant and neither write is lost |
| **D4** mutation-propagation | an `update` and a `delete` converge, not only an `insert` |
| **D5** isolation-control | a non-member with a **live database of its own** sees none of it |

Then three **standing reproductions** — recorded, never fatal, so a fix can be verified by
watching one flip green:

| leg | asserts |
|---|---|
| **L6** replication-factor | the row's block is held by >= `CLUSTER_SIZE` nodes, not just one |
| **L7** late-joiner | a member arriving **after** the write can still read it |
| **L8** durability | the data survives losing a node that held it |

### Why the D legs exist

`L5` writes one row on `peer-A` and reads it on `peer-B`. One direction, one row, one
reader, one shot — and until these legs existed it was the **only** data assertion in the
gate. Each D leg is a property a distributed database has to hold that `L5` passes without
ever testing:

| `L5` still passes if... | caught by |
|---|---|
| the path only works `A -> B` | **D1** |
| only the sampled sibling ever converges | **D2** |
| a second, concurrent write is silently lost | **D3** |
| rows can be inserted but not changed or removed | **D4** |
| the reader never needed the network at all | **D5** |

This is not hypothetical. The n=4 device runs fail with **both peers writing and reading
cleanly while neither sees the other's row** — exactly D1/D2, and invisible to L5 in
whichever direction it happens to sample.

**`DD` runs after `L3`, and the order is the assertion.** Before enrolment the control
network is a star — `L1` says so in as many words, and the mesh only widens once
`reconcileControlCohort` runs, which is gated on membership. An earlier reachability check
tests the harness's own sequence rather than the system: when this check lived inside `L2`
it passed in one process, where the mesh happened to widen in time, and failed with one
process per node, where it did not.

`D5` is the control arm and always runs, even after a failure above it. It is an outsider
in its own party, sharing the process (or the host) with the cohort and sharing no
membership with it. It first writes and reads back **its own** row — an outsider whose
database cannot be queried would report "sees nothing" forever and vouch for nothing —
and then must see none of the cohort's.

### Why L3 exists

This is the leg people skip, and skipping it is what made this class of bug so expensive
to find.

Control-network membership is the v1 authorization for the strand-address RPC
(`strand-addr-protocol.js`: *"only this party's cadre peers may ask us for a strand
address"*). A peer that is merely **connected** is addressable but **not authorized**.
Its strand-addr request is refused as `non-member`, so it never receives cohort
addresses, and its strand node then sits at a cohort of one having made zero dial
attempts.

Everything underneath looks healthy while replication silently never happens — the dial
layer in particular looks *pristine*, because it was never handed a peer to dial. L3
makes the gate explicit instead of letting it masquerade as an L4 or L5 failure.

Membership requires a `CadrePeer` row with an **anchored voucher**: a `stampId`, a
`vouchOwner` present in the node's trusted-owner store, and a verifying `vouchSig`.
Connecting does not produce one. The gate runs the real ceremony:

```
getIdentityOwnerKey → trustOwnerKeys → ensureOwnerKey → initializeSeedBootstrap   (founder genesis)
createInvite → dialInvite → acceptPhone                                           (per joiner)
```

## Two shapes: one process, or one process per node

`multipeer-gate.mjs` builds all four nodes inside a single Node process. That is how this
gate started, it localizes real blockers, and it stays the fast default. But there is a
class of claim it cannot support, because in one process the nodes share a heap, a module
registry, a timer wheel and a single libp2p event loop:

- **"`peer-B` read the row `peer-A` wrote"** does not establish that anything was
  serialized, framed, or put on a socket. Two nodes in one heap can satisfy every data
  assertion here with no network involved, and nothing in a green run tells the two apart.
  D5 is the control for this; running the same legs across processes is the proof.
- **A stream that is never opened cannot fail to open.** The n=4 device runs die during
  block transfer on `UnexpectedEOFError` and then `NoValidAddressesError` — failures of a
  real dial between real processes, which an in-process cohort never performs.
- **One event loop hides scheduling.** Four nodes taking cooperative turns is not four
  nodes competing for a CPU.

`multiproc-gate.mjs` runs each node as its own `peer-agent.mjs` process, addressed over a
newline-delimited JSON channel on stdio. Every byte between two nodes then crosses a real
socket, because there is no other route. The legs are the *same source files*
(`lib/core-legs.mjs`, `lib/db-legs.mjs`) and the nodes are built from the *same options*
(`lib/topology.mjs`), so a difference in outcome is a difference in **shape** — which is
the entire point of having both.

### Going host-to-host

The control channel is a byte pipe, so "another process" and "another machine" are one
code path. Point any node's agent somewhere else:

```bash
SPAWN_PEER_A='ssh bench-2 node /opt/multipeer-gate/peer-agent.mjs' \
SPAWN_PEER_B='ssh bench-3 node /opt/multipeer-gate/peer-agent.mjs' \
  node multiproc-gate.mjs
```

`SPAWN_<NAME>` upper-cases the node name and replaces `-` with `_`
(`peer-A` -> `SPAWN_PEER_A`). The far end needs this package installed and a route back for
the libp2p sockets; the gate tunnels **control**, never traffic. That adds a real NIC and a
real NAT, and the summary names the shape so two runs cannot be quoted interchangeably.

### What each shape is worth

| shape | removes | still absent |
|---|---|---|
| one process | nothing | shared heap, one event loop, no sockets between nodes |
| one process per node | the shared heap; nodes must use sockets | real NIC, NAT, mobile scheduler, Hermes |
| processes on separate hosts | loopback; adds real routing and NAT | mobile scheduler, radio, Hermes |
| the app on a device | — | — |

**None of the three is a device run.** Say which one you ran; the summary prints it for
exactly that reason.

## Knobs

All optional.

| env | default | effect |
|---|---|---|
| `DRONES=N` | `2` | number of always-on storage nodes |
| `RELAYS=1\|2` | `1` | how many relays each peer is OFFERED (cadre-core 0.12.0 reserves with the first that answers, so this is not the reservation count) |
| `CLUSTER_SIZE=N` | `2` | `strandClusterSize` — must be identical on every node |
| `ENROLL=0\|1` | `1` | run the enrolment ceremony; `0` observes the un-enrolled failure |
| `ENROLL_ATTEMPTS=N` | `5` | bounded retries for the ceremony |
| `AUTH_TIMEOUT_MS=N` | `120000` | how long L3 waits for the control database to become readable after the enrolment write. Separate from the ceremony's per-dial timeout |
| `DB_LEGS=0\|1` | `1` | run the distributed-database legs D1-D5 |
| `TIMEOUT_SCALE=N` | `1` | multiply every timeout on a slow machine |
| `SKIP_PREFLIGHT=1` | off | run against a tree that does **not** match `package.json`, deliberately. Recorded in the summary, so such a result cannot be quoted against the declared versions |
| `RPC_TIMEOUT_MS=N` | `180000` | *(multiproc only)* how long an agent may take to answer one control request |
| `SPAWN_<NODE>=cmd` | local | *(multiproc only)* run that node's agent elsewhere, e.g. over `ssh` |
| `VERBOSE=1` | off | per-poll progress |

`DRONES` is a **discriminator**, not decoration. Only storage-profile nodes serve blocks
(`enableRingZulu` and `storageRing` are gated on `profile === 'storage'`). If a leg fails
at `DRONES=2` and passes at `DRONES=3`, the cause is block-cluster breadth rather than
relay-only reachability.

### Diagnostics

```bash
DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' node multipeer-gate.mjs
```

**Arm both namespace roots.** The `optimystic:*` namespaces have *zero* coverage of
strand-address seeding, which lives under `sereus:cadre:strand-addr`. A run armed with
only the optimystic namespaces will show a clean, healthy-looking system while the actual
refusal is invisible.

Two more traps worth knowing when reading raw logs:

- **Split control from strand.** A node's control and strand libp2p instances log under
  *separate* `libp2p-key-network:<peerId12>` namespaces in the same stream. The
  reassuring `peers=4` lines are usually the **control** node while the strand node sits
  at 1. Aggregating them hides the entire problem.
- **Count relay identities, not addresses.** Three `/p2p-circuit` addresses can be one
  relay in three IP forms. L2 reports `N addr/M relay` for exactly this reason.

## Verified behaviour

### 2026-09-14 — what the new legs found

Measured on `@optimystic/db-p2p@0.29.0` / `@serfab/cadre-core@0.12.0`, macOS, Node 22.

**The declared dependency set is broken, and nothing noticed.** `package.json` declares
`@optimystic/db-p2p@^1.0.0-beta.3` and `@serfab/cadre-core@0.13.0`; the tree installed in
this directory was `0.29.0` and `0.12.0`, a whole major behind. `.gitignore` hides
`package-lock.json`, so nothing in the repository records which tree any past run used.
Two baselines taken the same day disagreed about which leg failed first for exactly that
reason. On the declared set, a four-node run with the relay-only constraint *removed* still
never replicates: `acceptPhone` fails with `collection default/OwnerKey holds committed
revision 1, but its header block read as absent`, membership never takes, and a row written
on one node is never seen by another. **L0 exists so this cannot happen silently again.**

**L1-L5 can be entirely green while replication is broken.** In-process run 2:

```
PASS  L0 L1 L2 L3 DD L4 L5          <- the whole of the old gate's verdict
FAIL  D1  replication-reverse — peer-B wrote 'gate-45ebc9c3-reverse' and peer-A never saw
          it in 60000ms (peer-A=absent peer-B='written-by-peer-B')
```

`L5` had just passed on the *same pair of peers* in the opposite direction. The old gate
would have reported `PASS — all 5 legs green` on that run. This is the same shape as the
n=4 device symptom, where both peers write and read cleanly and neither sees the other's
row — and it is not deterministic: D1 passed on run 1 and failed on run 2 of an unchanged
tree, so the direction is not merely unsupported, it is unreliable.

**The write path breaks under concurrency and mutation — intermittently, and in more than
one way.** These are the only legs that ever issue two writes at the same instant, or change
and remove a row rather than adding one. Across repeated runs of an unchanged tree they
produced three distinct named failures:

```
FAIL  D3  concurrent-writes — a simultaneous write was rejected — peer-B:
          SyncRevisionStalledError: sync for collection default/GateRow stopped after 2
          attempts: this client holds rev 2 and would request rev 3, but block <id> is
          confirmed committed at rev 3 and refreshing did not close the gap
```

```
FAIL  D3  concurrent-writes — after two simultaneous writes: peer-B lacks
          '<run>-concurrent-a'='v-peer-A'. Census —
          concurrent-a: drone-A='v-peer-A' drone-B='v-peer-A' peer-A='v-peer-A' peer-B=absent
          concurrent-b: drone-A='v-peer-B' drone-B='v-peer-B' peer-A='v-peer-B' peer-B='v-peer-B'
```

```
FAIL  D4  mutation-propagation — peer-A could not seed the row: Some peers did not
          complete: <peer>[blocks:1](in-flight) cause=Transaction rejected by validators
          (1/2 rejected): content-digest-mismatch, <peer>[blocks:1](in-flight)
          cause=The stream has been reset
```

The second is the one to read closely. Both drones **and** `peer-A` hold `concurrent-a`;
the only member that never received it is `peer-B`, the node that was writing at the same
instant. A presence-only assertion would have missed it too — the leg checks the *value*
each writer wrote, not merely that a row exists.

`D3` has also passed, which matters: these are real assertions that go green on a good run,
not permanently-red markers. Every write the gate issued before these legs existed was
serialized by the harness, so the collection was only ever mutated by one writer at a time —
the one case none of this can appear in.

**Across 5 in-process and 3 cross-process runs of an unchanged tree**, one run was green
end to end (every leg including D1-D5), one failed at `L3` on the pre-existing ceremony
flake, and the rest failed at one of `D1`, `D3` or `D4`. So the write path is not simply
broken — it is unreliable, which is the harder thing to see and the reason these legs are
worth having in the gate rather than in a one-off script.

Every new leg has been observed both green and red, and the leg logic itself is checked
separately by `npm run selftest`, which runs the data legs against a single node where
convergence cannot be the variable. That distinction had to be made: `D4` failed on every
multi-peer run it reached, and nothing in those runs separated "update and delete do not
converge" from "this leg's SQL is wrong". It is the latter that the self-test rules out.

**The standing reproductions have flipped on 0.29.0.** `L6` (replication factor 4/4, 0 of
24 blocks singly held), `L7` (late joiner reads the row after joining) and `L8` (data
survives killing a holder's OS process, 3/4 survivors still hold it) all report `FIXED`.
Optimystic#15 is closed on this stack; the late-joiner deadlock documented against 0.24.2
does not reproduce.

**An ordering flaw in this harness, found by the cross-process shape.** The reachability
check used to live in `L2`, before enrolment. In one process it passed; with one process
per node it failed — `drone-B` held no circuit address for either peer, and with
`PEER_DIRECT=1` the dial itself raised
`NoValidAddressesError: The dial request has no valid addresses for peer`. That was the
harness, not the system: the control mesh is a star until membership lets it widen, so the
check was asserting a precondition the design does not promise at that point, and its
in-process pass was luck. Moved to `DD`, after `L3`, both shapes pass. A 4x timeout scale
did not change the old result, which is what ruled out simple latency.

### 2026-09-03 — the relay/authorization legs

Re-measured 2026-09-03 on `@optimystic/db-p2p@0.27.0` / `@serfab/cadre-core@0.12.0`, macOS, Node 22:

| configuration | result |
|---|---|
| default (`DRONES=2 RELAYS=1 ENROLL=1`) | **PASS**, 4/4 (was 4/5 before the L3 fix) |
| `ENROLL=0` | **FAIL at L3** — `peer-A=false peer-B=false; owner lists 0 authorized member(s)` |
| `RELAYS=2` | **PASS**, 8/8 (was 3/5 before the L3 fix — see below). The old `claimed-elsewhere` does not appear at all |
| `DRONES=3` | not re-measured on this stack |

The `ENROLL=0` arm is the negative control, and it matters: it is the exact failure mode
seen in a real n=4 device run, and it proves the gate can actually fail. A green gate
that cannot go red proves nothing.

The default PASS establishes that **the n=4 topology does replicate on these versions**
when peers are properly enrolled — so a deployment that still fails should be checked for
a missing enrolment ceremony before anything upstream is suspected.

### `RELAYS=2` — the read-repair deadlock, FIXED in db-p2p 0.27.0

**Status 2026-09-03: the deadlock this section documented is closed.** `RELAYS=2` reached L5
and the gate went green on 3 of 5 runs; the old `claimed-elsewhere` signature does not appear
at all. It is no longer a standing reproduction — `repro/` keeps the regression tests.

Two things changed and they are easy to conflate:

* **The deadlock is gone (0.27.0).** A block held by exactly one cohort member could never gain
  a second, so the founder's solo owner-genesis write was permanently unreadable by every later
  joiner. 0.27.0 proofs the solo commit, so the certified-claim path can rescue it. History and
  the full root cause are kept below.
* **The relay count no longer behaves the same (cadre-core 0.12.0).** This section's old sample
  read `peer-A=4 addr/2 relay` — TWO reservations. On 0.12.0 the same configuration yields
  `2 addr/1 relay`: relays moved from a `<relay>/p2p-circuit` `listenAddrs` entry (libp2p's
  'configured' route, which reserves with EACH named relay) to `network.relayAddrs` (the
  'search' route, where `driveRelayReservation` dials every relay but asks *the first that
  answers* for a slot and returns as soon as one `/p2p-circuit` address appears). So `RELAYS=2`
  no longer widens reservation breadth, and L2's job changed with it — a single reservation is
  fine only if the OTHER cohort members can still route to the peer, which L2 now asserts
  directly rather than inferring from a count.

**The L3 flake is FIXED** (2026-09-03). It was 2 of 5 runs at `RELAYS=2` and 1 of 5 on the
default arm, always `Block default/Revocation is unavailable (peers-unreachable)` — a control-DB
read that could not be served, not a membership verdict. Now 8/8 at `RELAYS=2` and 4/4 on the
default arm, with `ENROLL=0` still failing (in ~17s). See the section below for the two causes.

<details>
<summary>History — the original root-cause writeup (accurate for db-p2p &lt;= 0.26.0)</summary>

Reserving on a **second** relay is enough to break control-DB reads:

```
PASS  L2  relay-reservation — peer-A=4 addr/2 relay peer-B=4 addr/2 relay
FAIL  L3  cadre-authorization — Block default/CadrePeer is unavailable (claimed-elsewhere)
```

**This is not a relay bug, and not a cadre-core bug.** It is an `@optimystic/db-p2p` read-repair
deadlock, root-caused and reproduced with no relays, no NAT and no cadre-core — see
[`repro/`](./repro/).

A block held by exactly **one** cohort member can never gain a second. Read repair requires two
distinct non-self peers to corroborate a revision before it may be restored; a sole holder
supplies one; and both paths that would create the second holder (read-repair acquisition and
`createReconcileBlock`) are gated by that same floor. So the block is permanently unreadable by
every member that was not present when it was committed.

The founder's owner-genesis write happens while it is solo, so the control database always
begins singly held. What the second relay changes is only **visibility**: it makes every node
see every other, which widens each joiner's cohort view from 2 to 3 — past the point where
`corroboratorCapacity` relaxes the floor from 2 to 1.

| relays | joiner's cohort view | corroborators required | outcome |
|---|---|---|---|
| 1 | 2 | 1 | the sole holder's claim is accepted — **PASS** |
| 2 | 3 | 2 | one holder can never supply two — **FAIL, permanently** |

`DRONES=3` fails identically for the same reason, which is why block-cluster breadth was ruled
out. The device-side symptom is the same defect: widening a device's relay-qualified
`listenAddrs` from one drone to two turned a run that reached the write phase into one that died
during boot with `BlockUnavailableError`.

`RELAYS=2` is kept as a **standing reproduction**, so a fix can be verified by flipping it to
PASS. Until then single-relay is the only posture known to work, which is why `RELAYS` defaults
to `1` — it works by keeping cohort views below 3, not by avoiding the bug.

</details>

### The L3 flake — diagnosed and fixed

**Not the read-repair deadlock above.** That attribution was carried here for months and is
falsified: db-p2p 0.27.0 closed the deadlock and the flake survived it, including on `RELAYS=1`,
which the deadlock explanation says cannot happen at a cohort view of 2.

What it actually was, in two parts:

1. **The ceremony stopped running.** `isAuthorizedMember` reads the control database, and that
   read can fail outright rather than answer. It was the FIRST statement inside each attempt, so
   once reads started failing every remaining attempt died before reaching `createInvite` — the
   ceremony that would have fixed things never ran, and the failure was then reported as
   "membership did not take" on a joiner that had in fact been accepted. A read that cannot be
   served is now `'unknown'`, distinct from a `false` verdict, and the ceremony proceeds.
2. **L3 gave up too early.** The enrolment write leaves the control DB briefly unreadable while
   replication spreads the new revision to a second holder, and that convergence sometimes takes
   over 30 seconds on loopback. L3's window was 30s (shared, confusingly, with the ceremony's
   per-dial timeout). It is now its own `AUTH_TIMEOUT_MS`, defaulting to 120s.

Neither is a retry that hides a failure: `ENROLL=0` still fails L3, and a peer that never becomes
a member still fails it. Re-running the ceremony now happens only on a DEFINITE `false` — an
`unknown` means it already ran and cannot be confirmed yet, where the old code would storm
`createInvite`/`acceptPhone` through a read outage to no effect.

Measured 2026-09-03, `RELAYS=2`: 3/5 before → 5/6 with (1) alone → **8/8 with both**; default arm
4/5 before → **4/4**. `ENROLL=0` still red.

Owner genesis is run while the founder is **still solo**, before anyone joins, because the write
needs a quorum the joiners cannot yet serve. That is also what makes the control database singly
held, and so what makes it vulnerable. Committing it at a cohort of 2 instead is proven to avoid
the deadlock (`repro/probe-holders.mjs` with `GENESIS_AT=2`), but whether cadre-core can move the
write is an upstream question.

## What this does and does not prove

**Does:** that the topology's addressing, authorization, cohort assembly and replication
work when peers are reachable only through a relay.

**Does not:** prove device behaviour. Everything here is one process on loopback. A real
NAT adds address translation and mobile schedulers add main-thread starvation; both have
produced device-only failures that a loopback gate passed straight through.

Treat a PASS as *"the blocker is not in this layer"* — a necessary condition for a device
proof, never a substitute for one.
