# Sereus / Quereus / Optimystic upgrade — findings (2026-08-12)

Upgrade of the three dependency families, and what it did to the long-standing multi-peer
blocker (P2P-11).

Full investigation trail, artifacts and reproduction scripts live in `.planning/spikes/059`–`062`.

## The bump

The three families are **welded** — `@serfab/cadre-core@0.10.0` *requires* `@optimystic/* ^0.22.0`
and `@quereus/quereus ^4.10.0` — so this is one atomic move, not three independent ones.

| Family | Was | Now |
|---|---|---|
| `@serfab/*` | 0.9.0 | **0.10.0** |
| `@optimystic/*` | 0.18.0 | **0.22.0** |
| `@quereus/*` | 4.4.1 | **4.11.0** |

**Patches:**

- `@serfab-cadre-core-npm-0.9.0-*.patch` — **RETIRED**. It added the `strandNetwork` override
  (the 41-11 workaround). Upstream fixed the root cause differently; the key no longer exists.
- `@quereus-quereus-npm-4.4.1-*.patch` → `@quereus-quereus-npm-4.11.0-aa7a775655.patch` —
  forward-ported, and **shrank 274 → 207 lines** because upstream absorbed VT's
  view-qualification fix as `applyViewSchemaDefault()`. What remains is the datetime
  immediate-CHECK coercion restoration.

## The peerId correction (supersedes the earlier "peer id duplication" framing)

Earlier diagnoses described this as a *peer id duplication* problem and tangled it up with
authority/owner identity. That framing was wrong, and the fix upstream chose makes the
distinction explicit:

**A peerId is not the cadre's authority key.** A `CadreNode` runs several libp2p nodes — one
control node and one per strand — and each now holds **its own transport identity**. Cadre
*authority* is untouched: it stays with the control node, and the `peerId → authority`
derivation (`ed25519PublicKeyB64FromPeerId`) is a control-network path only.

The collision was never an authority or ownership problem. It was **one identity being reused
across several libp2p nodes**, and `@libp2p/circuit-relay-v2` keys reservations and hop-connects
by peerId — so a control node and a strand node reserving through one relay collided and the
relay misrouted one's streams onto the other's connection. It is resolved by letting **each node
have its own id**, independent of any authority/owner conflation.

Mechanically (`cadre-core/strand-transport-key.ts`):

```
strandTransportKey(identityKey, strandId)
  = generateKeyPairFromSeed('Ed25519',
      sha256('sereus.strand-transport-key.v1', <identity PRIVATE seed>, strandId))
```

Deterministic, so a strand's transport peerId survives process restarts (peer-store entries and
`MemberPeer` rows that name it stay valid). It takes the *private* seed so no third party can
enumerate a member's strand peerIds from public data.

**Verified at runtime**, not just from source — one `CadreNode` (the probe drone) now reports two
different peerIds where 0.9.0 reported one:

```
control peerId : 12D3KooWCaxtMTRrVASXP6nq5uhxe4JR6EkV1H4atzE2aBhj7ZuV  (:61068)
strand  peerId : 12D3KooWAcW6sZJ1skorSUZnfJ4XfZ4PTrvBhwjBpTCLDxC7uJts  (:61070)
```

This closes upstream `gotchoices/sereus#1`, which the fix's own doc comment cites by URL.

## Dead config — read this before any device run

Two keys VT depended on **no longer exist** in cadre-core 0.10.0 (zero occurrences in the
published types/dist):

- **`strandNetwork`** — the key the retired yarn-patch added.
- **`strandBootstrapNodes`** — how VT had always seeded strand peers.

Strand cohort seeding now derives from the **control cohort**:

```
resolveCohortSeed(strandId, delegatePeerId)
  → controlDatabase.queryCadrePeers()
  → siblings with a LIVE control connection
  → /sereus/strand-addr/1.0.0 RPC (collectStrandAddrs)
  → bootstrapNodes
```

**Leaving the old `strandNetwork` block in place guarantees `strandPeers=0` for a configuration
reason**, which reads exactly like "the substrate is still broken." Both app providers and the
replication proof runner have had the block removed; strand nodes now inherit the single control
relay, which is the topology upstream's delegate-admission path expects.

## Other upstream changes that landed with this bump

- **Membership gating is now unconditional.** `createMembershipConnectionGater` is wired with no
  feature flag (`cadre-node.js:856`), and a caller-supplied `connectionGater` is passed as its
  *second* argument — composed **under** it. An app can no longer opt out with a permissive
  `denyDialMultiaddr`. In practice this did not block bring-up (no admission denials observed).
- **Strand nodes need a delegate admission grant.** A derived strand peerId is unknown to a
  relay, so the member's control node announces it over `/sereus/strand-addr/1.0.0` and the
  receiver holds a short-lived grant (30 min TTL). Without it the reservation is denied and
  `libp2p.start()` fails.
- **The relay-reservation deadlock is addressed.** db-p2p gives cadre nodes a namespaced identify
  id (`/optimystic/control-<partyId>/id/1.0.0`) while a stock relay runs `/ipfs/id/1.0.0`, so the
  two never identify, the peer store stays empty of protocols, and `RelayDiscovery` never
  nominates the relay — which surfaced as a generic timeout. 0.10.0 requests the reservation
  directly (`driveRelayReservation`) with a supervised retry loop.
- **cadre-core dropped its hardcoded `clusterSize: 3`.**
- **quereus ≥ 4.7.0 resolves `create assertion` function references eagerly**, at CREATE time
  (4.4.1–4.6.0 were lazy). Any consumer that registers UDFs *after* applying a schema now fails
  with `Function not found: <fn>/<arity>`. This is why the mock StrandHost in
  `compliance-strand.spec.ts` needed `registerPlugin(db, cryptoPlugin, …)` before its schema
  apply — the real path (`connectToStrand`) always did this.

## Device result — P2P-11

n=4 on real hardware (2 emulators + 2 drones), stack verified **installed**, not merely declared.

| Checkpoint | Result |
|---|---|
| `relayReservation` (both peers) | ✅ `true` |
| D-05 peerId stable across restart | ✅ |
| D-06 control cohort | ✅ `peers=1` |
| **REPL-01 strand cohort** | ✅ **`strandPeers=1` on both** |
| End-to-end row replication | ❌ FAIL |

`strandPeers=1` is the headline: P2P-11 had been device-REFUTED **three times**, always at
`strandPeers=0`, including the most recent attempt (optimystic 0.17→0.18, `a987530`) which closed
the membership gate but left the number unmoved. **This is the first run in four where the strand
cohort forms on device.**

**P2P-11 is not closed.** The proof's PASS bar is stricter than cohort formation: a peer must
*read the other peer's* row. Neither did. What is closed is the cohort-formation blocker.

### The proof-harness collision (fixed here)

Peer A logged `UNIQUE constraint failed: Authority.Id`. That is a **harness** defect the new
stack exposed, not a substrate failure:

- `proofAuthId` is `repl-auth-${peerTail}` — deterministic per peer.
- D-05 deliberately proves the peerId is **stable** across restart, and the strand store
  **survives** the relaunch by design.
- So the D-05 relaunch leg re-inserted the same row and aborted the write phase.

A per-run-unique id would **not** have fixed it: `Authority.InsertValid`'s shoe-in branch requires
`(select count(*) from Authority) = 1`, so a second Authority row is rejected regardless of its
Id — whether it is this peer's own row from a prior boot **or the sibling's once replication
works**. The write is now **idempotent**: it checks for its own row first, skips the insert when
present, and treats an Id collision as benign. Any other error still surfaces.

## Suite state on this branch

- `votetorrent-authority`: **79/79 suites, 1005/1005** — green.
- `vote-engine`: **1306 passing / 6 failing / 58 pending.**

The 6 are known and are **not regressions** — each characterizes upstream behaviour that has since
been fixed, or was vacuous and is now exposed. They are follow-up work, listed so they are not
mistaken for breakage:

| Test | Why it fails now |
|---|---|
| `InviteSlot` / `AdminSigning` InsertOnly (×2) | Vacuous — both mutate an **empty** table, and were green only because a missing-mutation-context error fired incidentally. Every `InsertOnly` test that operates on a **seeded** row still passes, so append-only enforcement is intact. |
| CID Probe 3b | The quereus `json_extract` TEXT-comparability limitation the probe documents is fixed upstream. |
| `clusterSize: 3` hardcode | cadre-core no longer hardcodes it — the assertion's own message says to close the upstream issue and wire the option through. |
| composite-PK DELETE (×2) | `extractPrimaryKey` now throws a helpful diagnostic instead of silently deriving a wrong key, so the bug repro's shape changed. |

### Re-run after the fix — the artifact is gone, the failure is real

The proof was re-run from a clean state with the idempotent write in place, the served Metro
bundle verified as the new code, and the fix confirmed to survive the harness's source injection.

`REPLICATION VERDICT: FAIL` on both peers again, but for a different reason:

- Peer A logged `write phase: own row already present, skipping insert (idempotent)` — the fix
  behaves as designed, and Peer A did contribute its row on its first networked boot. Peer B wrote
  cleanly.
- `strandPeers=1` reproduced on both peers, so cohort formation is repeatable.
- Neither peer read the other's row, and the device logs are **completely clean** — no errors, no
  `super-majority` / `quorum` / `rejected by validators` / `stale revision` signals. Replication is
  not erroring; the row never arrives and the read poll expires silently.

With the write phase healthy on both peers, **the remaining blocker is genuine**: rows do not
propagate across a formed strand cohort.

**Leading hypothesis, not yet proven:** `strandPeers=1` in an n=4 topology means each emulator sees
exactly one strand peer — consistent with each being connected to a drone but **not to the other
emulator** (two partial cohorts, drones not relaying strand data between them). Confirming it needs
the drone-side strand logs, which the harness auto-cleans on exit.

### Run 3 — `strandClusterSize: 2` — hypothesis REFUTED, real blocker identified

cadre-core 0.10.0 dropped its hardcoded cluster size and exposes `strandClusterSize`. It defaults
to `DEFAULT_STRAND_CLUSTER_SIZE = 4` ("the smallest breadth whose 0.75 super-majority still
commits with one holder offline"), so breadth 4 needs 3 holders to commit while the observed
cohort has 2 — a clean explanation for a silent, error-free failure to replicate.

It was set to 2 (`MIN_CLUSTER_SIZE`) on **both** emulator peers and the drones, since every node
on a strand must agree. Verified live: `strandClusterSize` appears in the served Metro bundle.

**Result: FAIL again, unchanged.** `relayReservation=true`, `peers=1`, `strandPeers=1`, the
idempotent write behaving correctly — and still neither peer reads the other's row. **Quorum
breadth was not the blocker.**

The drone-side logs (captured this run with a background copy loop, since the harness deletes
them on exit) show where the failure actually lives:

| Drone-A signal | Count |
|---|---|
| `NoValidAddressesError` | 76 |
| `no valid addresses for peer: <Peer B>` | 57 |
| `no valid addresses for peer: <Peer A>` | 19 |
| `could not negotiate /optimystic/control-votetorrent/fret/1.0.0/ping` | 9 |
| `could not negotiate /optimystic/control-votetorrent/id/1.0.0` | 2 |
| `could not negotiate .../fret/1.0.0/neighbors/announce` | 1 |

**The drone has no dial path back to either emulator.** Both peers dial *out* successfully and
both hold relay reservations (`relayReservation=true`), but the drone — a cohort voting member —
cannot reach either of them, and its FRET `ping`/`neighbors/announce` negotiation on the CONTROL
network fails. Drone-B's log is clean and idle.

That makes the `strandPeers=1` reading concrete: each emulator is paired with the **drone**, not
with the other emulator, and the reverse path needed to complete the mesh is missing. Writes
commit locally and have nowhere to go — which is why the device logs stay clean while the read
poll silently expires.

This is the same *class* as the historical drone→peer addressing walls (38-18 / 38-21), reappearing
on the new substrate. It is an addressing/reachability problem, **not** a consensus, quorum, or
cohort-formation problem — all three of which the upgrade genuinely fixed.

## Follow-ups

1. **DONE (run 3):** drone logs captured; the two emulators are each paired with the drone, not
   with each other. Next is the drone→emulator reverse path: why a peer holding a live relay
   reservation is still `no valid addresses` from the drone's side, and why FRET
   `ping`/`neighbors/announce` fails to negotiate on the control network. Note the harness's
   `mktemp /tmp/drone-full-run-XXXXXX.log` template leaves a LITERAL `XXXXXX` (the `.log` suffix
   defeats substitution) — copy that exact filename.
2. Re-author the 6 stale/vacuous vote-engine tests against current upstream behaviour.
3. `vote-engine`'s WR-01 attestation-verdict retry-dedup test fails intermittently (~1 run in 5)
   and is **pre-existing** — a one-shot run of that package is not a floor. Untouched here.
