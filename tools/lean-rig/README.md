# lean-rig: an all-host election driver

`lean-rig` runs a whole VoteTorrent election on this machine. Every role is a Node peer: officer, keyholders kh-a and kh-b, and
three host voters. The peers talk through a real libp2p relay. The rig loads the shipped Authority and vote-engine source directly.
Nothing here is a mock of the protocol. The only stand-ins are the device parts:

- an in-memory key vault instead of the hardware keystore
- a stub attestation verifier
- synthetic Android attestations for the host voters

The easiest way to use it is `scripts/seed-election.sh`. It asks which stage to stop at and how long the election should run, then
keeps the peers live so you can carry on by hand.

It moved here from the scratch rig `vt65-uat/rehearsal-2026-10-14/{64-lean,64-62}` on 2026-11-03. The code is unchanged except for
paths and the cuts noted below.

## Layout

| Dir | What | From |
|---|---|---|
| `lean/` | `lean-part1.sh`: officer founds the network, mints the join code, kh-a (and kh-b with `with-khb`) join. `run-lean.sh` + `lean-part2.ts`: election, keyholder accept, DKG, voters, release, decrypt, results. | 64-lean |
| `part1/` | The part-1 peer process (`hr5-peer.ts`), its control client (`hr5-ctl.mjs`), the network opener, the Node hooks, `verbs/`, and the shell helpers part 1 uses (`leg.sh`, `legs.sh`) | 64-62 (the rehearsal-only legs and the quiet-host / D-14 leg helpers were not carried) |
| `host-voter/` | One host voter process: join, register, associate, vote | `.planning` phase 64 `64-rig/host-voter` |
| `lib/` | `control-leaf.mjs` (fork precheck), `classify.mjs` (wall classifier), both unchanged | phase 64 `64-rig`, spike 106 |

Every path is relative to the rig's own location. The repo is `../..` from `tools/lean-rig`. `lean-part1.sh` and `run-lean.sh`
create `node_modules` links (gitignored) in `lean/`, `part1/` and `host-voter/` that point at `packages/vote-engine/node_modules`.
That way every package resolves to one copy. Run `yarn install` first.

## Inputs (machine-local, never in the repo)

- **A relay**: a `relay.env` file named by `VT_LEAN_RELAY_ENV`. The seeder defaults to `$VT_LEAN_RUNS/relay.env`.
  ```
  RELAY_MULTIADDR=/dns4/<host>/tcp/<port>/wss/p2p/<relay peer id>   (or /ip4/<lan ip>/tcp/<port>/ws/p2p/...)
  PEER_ID=<relay peer id>
  LAN_IP=<this machine's LAN ip>   (redacted from every log; part 1 refuses to log a command that holds it)
  STARTED_AT=<free text, shown by the seeder>
  ```
- **Run dirs**: they hold state, keys and join codes. The seeder puts them under `VT_LEAN_RUNS`, default `<checkout>/../vt-lean-runs`.
  The scripts refuse a run or evidence dir inside the repo.

## Running it

```sh
scripts/seed-election.sh                     # interactive: stage + election length
scripts/seed-election.sh dkg --minutes 90 --yes
```

By hand, which is what the seeder does:

```sh
export VT_LEAN_RELAY_ENV=/abs/relay.env
tools/lean-rig/lean/lean-part1.sh /abs/run-dir with-khb          # prints LEAN-P1: PASS
LEAN_TITLE=t LEAN_BALLOT=b HR5_LEAD_MS=2340000 HR5_WINDOW_MS=900000 \
  tools/lean-rig/lean/run-lean.sh run /abs/run-dir/ev /abs/run-dir   # ends with SUMMARY PASS|FAIL <leg> <token>
tools/lean-rig/lean/run-lean.sh selfcheck /abs/empty-dir         # offline, no network: SELFCHECK PASS 21/21
```

Driver knobs (env):
- **Timeline:** `HR5_LEAD_MS` (election creation to votingStarts) and `HR5_WINDOW_MS` (voting window).
- **Names:** `LEAN_TITLE` / `LEAN_BALLOT` (must be unique per run), `LEAN_NET_NAME` (part 1).
- **Time limits:** `LEAN_ALARM_S` (driver hard limit), `LEAN_HV_ALARM_S` and `HV_MAX_RUNTIME_MS` (host voters).
- **Debug:** `LEAN_DEBUG` (debug namespaces to `ev/debug.log`).
- **Stop early:** `SEED_STOP=<network|election|keyholders|dkg|voters>` stops after that stage and holds the peers live until SIGINT or
  SIGTERM, `<run>/secrets/flag-seed-stop`, or the hold deadline (`SEED_HOLD_MIN`, else the election's close + 10 min).
  `SEED_HV_N` sets the number of host voters for `voters`.
- **Phone runs:** `LEAN_PHONE`, `LEAN_PHONE_KH`, `LEAN_PHONE_KH2`, `LEAN_PHONE_VOTER`. The driver prints `LEAN-WAIT <step>` and waits
  for `<run>/secrets/flag-<step>` or for the officer to see the phone's work. The phone-driving helpers (CDP scripts) are not part of
  this rig.

## Traps

- **One party at a time.** Both apps hard-code party `votetorrent`. Never run two of these at once on the same relay, and never run one
  next to phones that joined another run's network: their control networks fork and joins hang. The seeder refuses while another lean
  run is live, but it cannot see phones.
- **The pool needs 3 votes.** A run with fewer than 3 voters never forms a vote block.
- **The Voter registers for the closest-dated election.** Use one election per network.
- **Keep the keyholder modules host-loadable.** The four keyholder modules the driver loads must stay free of native value imports
  (`keyholder-session-leaf.guard.test.ts`). bcbf1902 broke every host run until 967acbf4.
