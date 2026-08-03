# Multi-Peer Replication — Status Report

**Generated:** 2026-07-16 15:33 (+0545)
**Milestone:** v4.0 — Quereus v4 Upgrade + Cross-Peer Replication
**Scope:** Where the multi-peer (cross-peer replication) implementation stands, what has been resolved, what remains, and the downstream workflow paths that unlock once it is green.

---

## TL;DR

Multi-peer is **one blocker from green**, and as of plan 41-10 that blocker's root cause is pinned and reproduced on localhost.

- **Closed:** P2P-08 (emu↔emu addressing), P2P-09 (peer↔drone stream survival), P2P-10 (sibling dial hardening) — plus 13 consensus/relay sub-walls walked down across Phases 38–41.
- **Open:** **P2P-11** — cross-peer replication `REPLICATION VERDICT: PASS` at super-majority on real devices.
- **Root cause (new, 41-10):** a **shared-PeerId / shared-relay hop-connect collision** — reproduced on loopback with no NAT, which explains why every earlier NAT-focused fix moved the wall without closing it.
- **To green:** 2 plans — **41-11** (land the fix, Node-first) + **41-12** (on-device n=4 re-prove).
- The single-node engine already writes networks, authorities, elections, and ballots correctly on-device (`FULL-CHAIN VERDICT: PASS`). Multi-peer adds the *collaborative* dimension on top.

---

## Where it stands today — the one remaining blocker

**P2P-11 — OPEN — root cause confirmed.**

### Shared-PeerId / shared-relay hop-connect collision

A `CadreNode`'s control node and every per-strand libp2p node **share one PeerId and dial the same relay**. `@libp2p/circuit-relay-v2` keys hop-connect delivery *solely by PeerId*, so a peer's relayed stream meant for the strand connection is delivered to the **control** connection instead — the strand FRET protocol never negotiates, so no strand cohort forms (`strandPeers = 0`).

Plan 41-10 **refuted** the earlier hypothesis (that the strand node's `listenAddrs` weren't relay-qualified — they are; the config reaches the strand node's `addresses.listen`) and **confirmed** this collision instead, reproducing it on localhost with **no NAT required**:

```
replication-proof-runner.ts   listenAddrs: STRAND_RELAY_LISTEN_ADDRS  → reaches the strand node ✓ (hypothesis refuted)

control node  ─┐
strand node   ─┴─  share one PeerId + one relay
                      ↓
circuit-relay-v2 server   server/index.js:236  connections[0]  — keyed only by PeerId
                      ↓
strand hop-connect  →  delivered to the CONTROL connection  →  UnsupportedProtocolError  →  strandPeers = 0
```

A Node probe (`relay-multi-peer-smoke.js`, `STRAND-RELAY-ROUTING SHARED-IDENTITY SUB-CHECK`) now reproduces the exact `UnsupportedProtocolError` device signal byte-for-byte on loopback and is regression-locked.

### Pinned fix locus (for 41-11)

Additive `strandNetwork` override on `CadreNodeConfig`:

```
// @serfab/cadre-core cadre-node.js:1916
network: this.config.strandNetwork ?? this.config.network
```

This gives the strand node a **distinguishable relay target** from the control node's, breaking the shared-PeerId collision. Delivered as a D-03 yarn-patch to `@serfab/cadre-core`.

### Remaining to green

| Plan | Type | Gate |
|------|------|------|
| **41-11** | Fix (Node-first, static-locked) | Land the `strandNetwork` override; loopback repro flips to PASS |
| **41-12** | On-device n=4 re-prove | `grep -c 'REPLICATION VERDICT: PASS' == 2` across both emulators |

---

## Blockers resolved on the way here

The "wall-walk" — each device run localized the next sub-blocker, which a code plan then closed.

| Ref | Resolved | Evidence |
|-----|----------|----------|
| **P2P-08** (Phase 38) | Emulator↔emulator address discovery | dial no longer fails with `no valid addresses for peer` |
| **P2P-09** (Phase 38) | Peer↔drone consensus stream survives block creation | no `stream has been reset` mid-consensus |
| **P2P-10** (Phase 38) | Sibling dial sites hardened for non-branded PeerIds | `libp2p-node-base` restoration adapter + `repo/service.getPeerAddrs` |
| 38-14 | First strand cohort forms | `strandPeers 0 → 2` (cohort connected for the first time) |
| 38-16 / 38-18 | Consensus race + vote-delivery addressing | stale-revision pend race closed; `c.direct` dead-code fix took `no valid addresses 920× → 0` |
| 38-20 / 41-02 | Circuit-relay reservation on both sides | `relayReservation → true` on both emulators; `NO_RESERVATION` class + per-drone asymmetry cleared |
| 41-04 | identifyPush restored | patched into `@optimystic/db-p2p`; gossipsub `fns.shift 24× → 0` |
| 41-06 | Malformed protocol string | single-slash `protocolPrefix`; malformed `//optimystic/…/id/1.0.0 6× → 0×` |
| 41-08 / 41-09 | FRET limited-connection dials + `p2p-fret ^0.6.0` adoption | `runOnLimitedConnection` (now native in 0.6.0); FRET `UnsupportedProtocol 89 → 52`, `NoValidAddresses 177 → 56` (~halved) |
| **41-10** (today) | Root cause pinned & loopback-reproduced | refuted listenAddrs hypothesis; confirmed shared-PeerId collision; vote-engine held `812 / 0 / 46`; no fix landed (diagnosis only) |

> **Why it took a walk:** the failure was never really about the NAT. Each earlier fix was correct and necessary — it cleared its target class and exposed the next layer — but the load-bearing defect (shared identity at the relay hop-connect) only became visible once the layers above it were clear, and only 41-10's loopback repro proved it definitively.

---

## What already works single-node

The vote-engine drives the full write → persist → read chain correctly on **one node**, proven on-device (Hermes) across restart. Multi-peer does **not** block any of this.

- Network creation
- Authority creation
- Election creation
- Ballot question round-trip
- Signing seams & digest parity
- Restart persistence

```
[proof] ========== FULL-CHAIN VERDICT: PASS (network=1, authority=1, election=1, crypto=true, digestParity=true, ballotQuestions=true) ==========
```

---

## Workflow paths to test & close once multi-peer lands

The engine builders for these collaborative flows **already exist**; they are gated on cross-peer consensus to be end-to-end testable. Each row lists the concrete close criteria (the test to run once P2P-11 is green).

### 1. Multi-authority network formation — *gated*
- **Builders:** `network-create-authority`, `network-pin/unpin-authority`, `network-respond-to-invite`
- **Unlocks:** multiple authorities join and replicate a shared network cadre across peers (vs. one solo authority).
- **Close criteria:** 2+ authority peers form one network; the authority set replicates and reads back identically on every peer.

### 2. Authority & officer invitations — *gated*
- **Builders:** `authority-create-authority-invite`, `authority-create-officer-invite`, `authority-save-invite-with-signing`
- **Unlocks:** a signed invite delivered to an invitee on another peer, who joins as a real `User` and replicates in.
- **Close criteria:** invite issued on peer A is accepted on peer B; invitee becomes a persisted `User`; membership converges.

### 3. Keyholder invitation & the cadre key ceremony — *throwaway scaffold today*
- **Builders:** `election-invite-keyholder`, `election-revoke-keyholder`
- **Current state:** keyholders are **not** persisted by the engine — a disposable app-only scaffold (`apps/VoteTorrentAuthority/src/engines/local-keyholders.ts`) stores keyholder names per election in AsyncStorage for dev/demo visibility only.
- **Unlocks:** the real signed `InviteSlot → User → Keyholder` chain, which cadre P2P provides "for free" once real peers exist.
- **Close criteria:** keyholder invited on peer A appears (signed, persisted) on peer B; then **delete the `local-keyholders.ts` scaffold**.

### 4. Ballot proposal — *gated*
- **Builders:** `election-propose-ballot`
- **Unlocks:** a proposed ballot reaches the cadre, gathers signatures, and is accepted as a replicated revision — not just written on one node.
- **Close criteria:** ballot proposed on peer A reaches super-majority approval and reads back as the accepted revision on peer B.

### 5. Election & network revisions — *gated*
- **Builders:** `election-propose-revision`, `network-propose-revision`
- **Unlocks:** multi-signer revision consensus — co-signed changes to election or network state converge across the cadre.
- **Close criteria:** a revision proposed and co-signed by the required quorum is accepted and identical on all peers.

### 6. Voting & verifiable tally — *the P2P-11 payoff*
- **Path:** vote submission → cross-peer replication → tally
- **Unlocks:** the core promise — votes replicate across peers and the tally is independently verifiable. This *is* what the `REPLICATION VERDICT: PASS` gate proves.
- **Close criteria:** n=4 device run emits `REPLICATION VERDICT: PASS` at super-majority on both peers; tally verifiable end-to-end.

---

## Requirement ledger (v4.0 milestone)

- **Closed networking:** P2P-08, P2P-09, P2P-10
- **Open networking:** **P2P-11** (fix locus pinned; 41-11 + 41-12 remain)
- **Open tech-debt (orthogonal to multi-peer):** DEBT-08 (`ballot-questions-not-populated` debug), DEBT-09 (~8 pending todos), DEBT-10 (on-device create-election UI walkthrough), DEBT-11

---

## Next step

```
/gsd-plan-phase 41 --gaps      # plan 41-11 (land the strandNetwork fix) + 41-12 (device re-prove)
```

The next fix has a precise, loopback-reproduced target and a locked repro to verify against — the strongest position P2P-11 has been in across Phases 38 and 41.
