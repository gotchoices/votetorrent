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

```bash
cd tools/multipeer-gate
npm install
node multipeer-gate.mjs
```

Node >= 22. Exit `0` when all five legs pass, `1` at the first failure.

```
PASS  L1  control-reachability — drone-A=3 drone-B=1 peer-A=1 peer-B=1 (founder >= 3, each >= 1)
PASS  L2  relay-reservation — peer-A=2 addr/1 relay peer-B=2 addr/1 relay
PASS  L3  cadre-authorization — peer-A, peer-B authorized
PASS  L4  strand-cohort — drone-A=2 drone-B=2 peer-A=2 peer-B=2
PASS  L5  replication — peer-B observed 'gate-row-8uRzAcLQ'
MULTIPEER GATE: PASS — all 5 legs green.
```

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
| **L1** control-reachability | every node holds >= 1 control connection; the founder sees all of them |
| **L2** relay-reservation | each relay-only peer exposes a `/p2p-circuit` multiaddr, counted by **distinct relay identity** |
| **L3** cadre-authorization | the relay-only peers are **authorized cadre members** |
| **L4** strand-cohort | every strand node assembles a cohort larger than itself |
| **L5** replication | `peer-A` writes a row; `peer-B` reads it back |

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

## Knobs

All optional.

| env | default | effect |
|---|---|---|
| `DRONES=N` | `2` | number of always-on storage nodes |
| `RELAYS=1\|2` | `1` | how many relays each peer reserves on |
| `CLUSTER_SIZE=N` | `2` | `strandClusterSize` — must be identical on every node |
| `ENROLL=0\|1` | `1` | run the enrolment ceremony; `0` observes the un-enrolled failure |
| `ENROLL_ATTEMPTS=N` | `5` | bounded retries for the ceremony |
| `TIMEOUT_SCALE=N` | `1` | multiply every timeout on a slow machine |
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

Measured on `@optimystic/db-p2p@0.24.2` / `@serfab/cadre-core@0.11.0`, macOS, Node 22:

| configuration | result |
|---|---|
| default (`DRONES=2 RELAYS=1 ENROLL=1`) | **PASS**, 3/3 consecutive runs |
| `ENROLL=0` | **FAIL at L3** — `peer-A=false peer-B=false; owner lists 0 authorized member(s)` |
| `RELAYS=2` | **FAIL at L3** — `Block default/CadrePeer is unavailable (claimed-elsewhere)` — upstream, see below |
| `DRONES=3` | **FAIL at L3** — same cause, so breadth is not it |

The `ENROLL=0` arm is the negative control, and it matters: it is the exact failure mode
seen in a real n=4 device run, and it proves the gate can actually fail. A green gate
that cannot go red proves nothing.

The default PASS establishes that **the n=4 topology does replicate on these versions**
when peers are properly enrolled — so a deployment that still fails should be checked for
a missing enrolment ceremony before anything upstream is suspected.

### Root-caused: `RELAYS=2` trips an upstream read-repair deadlock

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

### Known flake, handled — same root cause

The enrolment ceremony genuinely fails run-to-run: each step writes owner-signed control state
and then reads it back, and a read issued once the writer's cohort view has widened past 2 hits
the deadlock above. `ENROLL_ATTEMPTS` retries with linear backoff, which wins while the view is
still narrow. This is not masking a defect — a peer that is genuinely un-enrollable exhausts
every attempt and L3 still fails — but it is the same upstream bug, not a race.

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
