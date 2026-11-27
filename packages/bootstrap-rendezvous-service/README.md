# @votetorrent/bootstrap-rendezvous-service

Holds one sealed blob it cannot read, for at most ten minutes, and hands it over exactly once. Internal deployable — private (`"private": true`), version `0.0.1`, not published.

**This is not the libp2p circuit relay.** It has no peers, no multiaddrs, no strand and no cadre, and it never dials anything. "Relay" elsewhere in this repository means something else entirely; nothing here participates in it.

Part of the [VoteTorrent](https://github.com/gotchoices/votetorrent) monorepo.

## Purpose

An officer's phone mints a one-time sign-in code and, at the moment of minting, pushes the sealed voter-roll snapshot to this service. The service stores the ciphertext under an opaque look-up identifier derived from the code's secret half — not the secret itself.

A browser that has never met that phone then redeems the code. It sends only the same derived look-up identifier; the service answers with the ciphertext and marks the code spent, atomically, in that order. The content key is derived from the code's secret under a different domain label and never leaves the phone or the browser, so this service holds ciphertext and the wrong half of the split. It can read none of it.

One process, one port, two roles: the same process also serves the dashboard's built `dist/`. That is forced rather than chosen — the dashboard reads its API base URL from `window.location.origin` at runtime (`apps/VoteTorrentDashboard/src/screens/Bootstrap.tsx:55`), so the API and the built client must share an origin or the shipped client cannot reach the API at all. There is consequently no CORS story and no second port.

## Deploying

See [`OPERATOR.md`](./OPERATOR.md) — the environment, the eight deployment steps, the reverse-proxy example, and what the operator can and cannot see. The procedure is not duplicated here: two copies of a deployment procedure is exactly how one of them goes stale.

`scripts/run-bootstrap-operator-smoke.sh` (repository root) executes that document's own fenced steps against a clean target.

## Development

```bash
yarn workspace @votetorrent/bootstrap-rendezvous-service build
yarn workspace @votetorrent/bootstrap-rendezvous-service test
yarn workspace @votetorrent/bootstrap-rendezvous-service start
```

`build` emits `dist/` with `tsc`; `test` runs the mocha suite under `ts-node`; `start` runs `node dist/main.js` and is what a deployment actually invokes. The package depends on `@votetorrent/vote-engine` (workspace), so build that first in a clean checkout.

### Environment

Every operator knob is documented in `OPERATOR.md`. All of them carry the `BOOTSTRAP_RENDEZVOUS_` prefix; three are required (the upload bearer token, the data directory and the dashboard build directory) and the rest have defaults.
