# p2p-probe-host

Host-side CadreNode drone for the P2P dial and replication proofs. Internal dev tooling — private (`"private": true`), version `0.0.1`, not published.

Part of the [VoteTorrent](https://github.com/gotchoices/votetorrent) monorepo.

## Purpose

`drone.mjs` boots a single storage-profile `CadreNode` (from `@serfab/cadre-core`) that listens on an ephemeral WebSocket address (`/ip4/0.0.0.0/tcp/0/ws`) so an Android emulator can dial it (the emulator reaches the host at `10.0.2.2`). On startup it prints the control peerId and its WebSocket multiaddrs, then stays alive until interrupted.

The drone hosts the same VoteTorrent strand schema (`packages/vote-core/schema/votetorrent.qsql`) that device peers apply, so its strand is replication-compatible with the in-app transaction peers. This lets the device-side dial probe connect to a known, always-on node and prove a direct WebSocket dial (and strand replication) work end to end.

## Running

The package is a normal yarn workspace, so dependencies install from the repo root:

```bash
yarn install
```

Start the drone (Node 22):

```bash
yarn workspace p2p-probe-host start   # runs `node drone.mjs`
```

On boot it logs the control peerId and the listening multiaddrs, e.g.:

```
[drone] control peerId = <PEER_ID>
[drone] control addrs  = ["/ip4/127.0.0.1/tcp/<PORT>/ws/p2p/<PEER_ID>", ...]
[drone] PROOF_WS_ADDR=/ip4/127.0.0.1/tcp/<PORT>/ws/p2p/<PEER_ID>
[drone] READY — ...
```

Keep it running in its own terminal. Stop it with Ctrl-C (`SIGINT`) or `kill <pid>` (`SIGTERM`) — both shut the node down gracefully.

### Environment

- `DRONE_STRAND_ROLE` — `found` | `join`. With `STRAND_ID` set, it is required: the drone refuses to start without it, because a guessed role can fork a strand a device already founded. The role is inferred only when `STRAND_ID` is unset: the control founder founds the strand, and a joiner drone (one with `DRONE_BOOTSTRAP_CONTROL_ADDR`) leaves founder-ness to cadre-core's derivation. An invalid value exits before the node starts. The drone logs `STRAND_ROLE=<role>` before the strand-started line.
  `scripts/run-replication-proof.sh` passes `DRONE_STRAND_ROLE=found` to drone-A and `join` to drone-B by default. Its `STRAND_ID` is the fixed proof strand, and Peer A's only history under it (the Step-1 solo boot) is wiped before the networked run, so drone-A must found it: with drone-A joining, no node holds the founding Header and every strand acquire hangs on the first-sync gate (2026-10-08). Run it with `DRONE_STRAND_ROLE=join` to reproduce the 62-85 variant. A drone started directly with `STRAND_ID` and no role is not refused yet, so set the role yourself (see below).
- `STRAND_ID` — the test-network hash to host as the VoteTorrent strand. Defaults to the placeholder `UPDATE_WITH_TEST_NETWORK_HASH`; set it to the network hash exported by the device peer that creates the network so the drone's strand matches.

### Joining a strand a device already founded

When `STRAND_ID` is the hash of a network a device created, the drone must NOT found it again:

```
STRAND_ID=<the device network's hash from Network details> DRONE_STRAND_ROLE=join node drone.mjs
```

Without it the drone creates a second, independent history under the same strand id; while peered, the device's own committed rows read as missing (round-3 UAT test 15: a pending officer and the officer card vanished) and return after the drone stops. `join` passes `founder: false`, so the drone waits for the device's history (the device is the founder: it wrote the Header). Only use it for a strand a device really founded; with no founder anywhere every node deadlocks waiting for a Header. Devices still enrol through the drone's control cadre (control owner genesis is unchanged).

## Dial-probe workflow

The drone is the host endpoint for `scripts/run-dial-probe.sh`:

1. Start the drone and read the WebSocket multiaddr from its startup output.
2. Update `CONTROL_ADDR` in `apps/VoteTorrentAuthority/src/engines/dial-probe.ts` with the `/ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID>` form (the emulator host mapping). Re-build / hot-reload the app.
3. Run `./scripts/run-dial-probe.sh` from the repo root.

`scripts/run-dial-probe.sh` parses the machine-readable `PROOF_WS_ADDR=` line and rewrites `127.0.0.1` → `10.0.2.2` for the emulator. See that script's header comments for the full procedure and troubleshooting notes.

## Wall proof (D-07, Phase 56 Plan 01)

`wall-proof.mjs` is the Node-side `@serfab/cadre-core` + `@optimystic/db-p2p` integration harness
that proves the current admission wall BEFORE `56-04` scopes its patch. It stands a gateway whose
every unconditional-admit branch is verifiably closed, probes an unauthorized outsider against all
three gate layers, answers CONTEXT Finding 4, and decides the gateway's relay posture on measured
behaviour — leaving behind a recorded artifact (`wall-proof-record.json` +
`.planning/phases/56-public-election-view-as-a-live-libp2p-edge-subscriber/56-01-WALL-PROOF.md`)
that `56-04` reads to scope its patch.

### Three invocations

```bash
yarn workspace p2p-probe-host proof:wall --preconditions-only   # boot + RUNG_P only, then exit
yarn workspace p2p-probe-host proof:wall --self-test             # RUNG_P's inversion (see below)
yarn workspace p2p-probe-host proof:wall                         # the full rung sequence
```

`--relay=on|off` forces which relay posture `RUNG_RELAY` measures (default: `on` — `off` is
already covered by the default unauthorized probe against the shared gateway). `--json <path>`
overrides where the machine-readable record is written (default `./wall-proof-record.json`).

### What each rung means

| Rung | Kind | Meaning |
|------|------|---------|
| `RUNG_P` | assertion | Every one of the eight unconditional-admit branches (interface doc comment on `admitInboundControlConnection`) is verified closed against the probe peer, by direct reads that THROW rather than skip on a missing member. |
| `RUNG_L1` | measurement | Protocol-blind connection admission — dial the gateway's control multiaddr directly and classify by racing the connection's own `close` event. |
| `RUNG_L2` | measurement | `authorizeInboundControlStream` — measured behaviourally (does `/sereus/strand-addr` even open on an admitted connection) AND by a comment-stripped source scan with its own positive control. |
| `RUNG_L3` | measurement | The strand-addr protocol handler's own `isMember` gate — a hand-framed raw exchange alongside the product-shaped `collectStrandAddrs` path. |
| `RUNG_POS` | assertion | Positive control: seed the outsider itself as an authorized member and re-run L1/L2/L3, requiring ADMITTED/STREAM_OPENED/SERVED. No L1/L2/L3 verdict above may be reported as evidence unless this passes. |
| `RUNG_RELAY` | measurement | The gateway's relay posture (`network.enableRelay`), measured across 3 consecutive attempts, decided on observed behaviour rather than assumption. |
| `RUNG_F4` | measurement | CONTEXT Finding 4 — can a peer that already holds valid strand addresses complete a real strand-mesh repo operation? |

`RUNG_P` and `RUNG_POS` are **assertions** — the run fails if they don't hold. `RUNG_L1`/`RUNG_L2`/
`RUNG_L3`/`RUNG_RELAY`/`RUNG_F4` are **measurements** — an unexpected result there is a *finding* to
record, not a failure to hide; only an UNCLASSIFIABLE outcome (e.g. an infrastructure dial failure
misread as a wall decision) fails the run, because a wall proof that shrugs is worse than no proof.

### `--self-test`

Boots the SAME gateway shape with the owner-genesis/seeding block skipped entirely and requires
`RUNG_P` to FAIL and `admitInboundControlConnection` to return `'admit'` via the resulting
cold-start/empty-trust-anchor carve-outs. A precondition rung that cannot fail is not a control —
this is the harness's key instrument inversion.

### Quiet host

CadreNode boot is CPU-heavy and a busy host has previously manufactured false failures — do not run
`proof:wall` concurrently with `nx run-many` or other CPU-heavy tasks.

## Gateway reactivity origination (`strandCohortTopic`)

`gateway.mjs` also carries a node-local `strandCohortTopic: { enabled }` config key: a REQUIRED
master switch — never defaulted — for whether this gateway's strand node originates reactivity
notifications. It is passed to cadre-core's own `strandReactivity` option (cadre-core 1.12+; the
strand-cohort-topic yarn patch that used to provide it is retired). `--self-check` proves it took
effect on the STARTED strand node (its `EFFECT_COHORT` rung), not merely that the config was
accepted. A `minSigs` key is refused: `strandReactivity` takes no host tuning, and upstream states
`cohortTopic.host.minSigs` does not govern the reactivity root.
