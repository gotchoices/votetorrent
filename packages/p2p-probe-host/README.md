# p2p-probe-host

Host-side CadreNode drone for the P2P dial proof. Internal dev tooling — private (`"private": true`), version `0.0.1`, not published.

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

- `STRAND_ID` — the test-network hash to host as the VoteTorrent strand. Defaults to the placeholder `UPDATE_WITH_TEST_NETWORK_HASH`; set it to the network hash exported by the device peer that creates the network so the drone's strand matches.

## Dial-probe workflow

The drone is the host endpoint for `scripts/run-dial-probe.sh`:

1. Start the drone and read the WebSocket multiaddr from its startup output.
2. Update `CONTROL_ADDR` in `apps/VoteTorrentAuthority/src/engines/dial-probe.ts` with the `/ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID>` form (the emulator host mapping). Re-build / hot-reload the app.
3. Run `./scripts/run-dial-probe.sh` from the repo root.

`scripts/run-dial-probe.sh` parses the machine-readable `PROOF_WS_ADDR=` line and rewrites `127.0.0.1` → `10.0.2.2` for the emulator. See that script's header comments for the full procedure and troubleshooting notes.
