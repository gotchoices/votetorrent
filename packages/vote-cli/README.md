# vt (@votetorrent/vote-cli)

`vt` is a headless test and profiling tool that runs the shipped officer, keyholder and voter workflows on Node, over a real libp2p relay, with no React Native and no device. It is not a product surface: it never runs a real election, and no app depends on it.

## Local relay (loopback, automated tier)

1. Build in order, then build this package. `vt` refuses a stale dist (see Build freshness).
   ```sh
   yarn --cwd packages/vote-core build
   yarn --cwd packages/vote-engine build
   yarn --cwd packages/workflows build
   yarn --cwd packages/vote-cli build
   ```
2. Pick a scratch directory OUTSIDE the repo and create it with mode 0700. The relay refuses a key or bootstrap path inside the repo.
   ```sh
   scratch="$(mktemp -d)" && chmod 700 "$scratch"
   ```
3. From `packages/p2p-probe-host`, start the relay on a free port between 1024 and 65535 that is never 8081, 8091 or 8097 (the shared Metro ports), with `FORCE_COLOR=0` and with `NODE_OPTIONS` and `DEBUG` unset. Wait for the `RELAY_READY` line.
   ```sh
   cd packages/p2p-probe-host
   env -u NODE_OPTIONS -u DEBUG FORCE_COLOR=0 node relay-only.mjs \
     --key-file "$scratch/relay-key.pb" --port <port> --lan-ip 127.0.0.1 \
     --bootstrap-out "$scratch/bootstrap.json"
   ```
4. Write `$scratch/relay.env` (mode 0600) holding the one `RELAY_MULTIADDR=` line the relay printed. This is the lean rig's format, so a `VT_LEAN_RELAY_ENV` file keeps working.
5. Stop the relay with SIGTERM and expect `RELAY_STOPPED`.

Rules:

- Never point `--bootstrap-out` at an app's `bootstrap.config.json`.
- A loopback relay address and its peer id are treated as secrets: never paste them into logs, commits or issues, and show a peer id by its last 8 characters only.
- Specs use `startLoopbackRelay()` from `test/support/loopback-relay.ts`, which does all of the above on an ephemeral port, in a temp dir, and writes the child's output to a 0600 `relay.log` there.
- Every spec, every `vt run election` rehearsal and every parallel run uses this tier. The public tier below is for one acceptance run only.

## Relay tiers

- **Automated tier.** The loopback relay above. It is the tier for every spec, rehearsal and parallel run. It starts on an ephemeral port, keeps its files in a private scratch dir and never leaves this host.
- **Acceptance tier.** The public acceptance relay, used only for the single full-election acceptance run, host-only. Its `relay.env` lives outside the repo; this README carries no host name or address for it. Use a unique `--party`, never run while another run with the same party id is live, and make a quiet-host check first.
- Both tiers hand the daemon the same file format: one `RELAY_MULTIADDR=` line in a 0600 `relay.env`. The lean rig reads the same file.

## Roles and daemons

- One daemon per device: a phone holds one role's keys and node state. `officer`, `keyholder` and `voter` are the roles. For a single-process rehearsal, `--colocate` puts several authority roles in one process; voters are never colocated.
- `vt <role> start --state <dir> --relay <relay.env>` starts a daemon. The state dir basename is the peer label and its parent basename is the party id.
- The local command is `vt <role> start ...`; remote commands are `vt <role> <verb> --peer <dir>`, with `VT_PEER` as the default for `--peer`.
- Each daemon serves one control endpoint on 127.0.0.1, gated by a per-peer token file. It writes its port file **last**, so the presence of a port file means the daemon is ready.
- Secrets go by file path only (for example `--code-file <path>`, `--token-file <path>`). Plain strings carry ids, counts, booleans and timings.

## Verbs

`vt <role> verbs --peer <dir>` lists what a running daemon actually serves. The built-in `verbs` listing is on every role and is not a row in the table. Each row names the user-facing workflow the verb drives; the verb body calls the same shared workflow the app screen calls.

| Role | Verb | What it does |
|------|------|--------------|
| officer | `found` | Found the network |
| officer | `join` | Join a second officer's network (registered, not used by a one-officer run) |
| officer | `mint` | Mint a voter join code |
| officer | `create-election` | Create the election |
| officer | `keyholder-policy` | Set the keyholder policy |
| officer | `invite-keyholder` | Invite keyholders to their seats |
| officer | `ballot-submit` | Propose and submit the ballot |
| officer | `task-sign` | Sign a ballot signature task |
| officer | `enable-intake` | Enable encrypted registration intake |
| officer | `approve` | Approve a registration |
| officer | `refuse` | Refuse a registration (negative control) |
| officer | `peer-sync` | Sync peer registrations |
| officer | `release-window` | Open the release window |
| officer | `tally` | Tally the votes |
| officer | `publish` | Publish the tally |
| officer | `results` | Read the election results |
| officer | `dashboard-code` | Mint a dashboard pairing code |
| officer | `capability` | Read the shared voter-invite capability |
| officer | `owner-setup` | Set up the network owner |
| officer | `authority-id` | Read the authority id |
| officer | `registrations` | Read the registration queue |
| officer | `readback` | Read peer readiness and memory use |
| officer | `stop` | Stop this peer daemon |
| keyholder | `join` | Join the officer's network |
| keyholder | `accept` | Accept the seat invitation |
| keyholder | `dkg` | Drive the distributed key generation |
| keyholder | `release` | Release the key share |
| keyholder | `results` | Read results for peer agreement |
| keyholder | `capability` | Read the shared voter-invite capability |
| keyholder | `readback` | Read peer readiness and memory use |
| keyholder | `stop` | Stop this peer daemon |
| voter | `join` | Join with the code |
| voter | `register` | Register the device |
| voter | `stage-association` | Stage the association request |
| voter | `answer-challenge` | Answer the registration challenge |
| voter | `read-decision` | Read the registration decision |
| voter | `cast` | Build and sign the vote |
| voter | `send` | Pool and send the vote |
| voter | `results` | Read the election results |
| voter | `readback` | Read peer readiness and memory use |
| voter | `stop` | Stop this peer daemon |

The officer's `join` verb is registered but is not called by a run: a one-officer election has no second officer to join.

## vt run election

```
vt run election --relay <relay.env> --state <dir> --party <id> \
  [--lead-ms N] [--window-ms N] [--marks-file F] [--max-peers N] \
  [--keyholders 1|2] [--voters N] [--colocate a,b] [--debug NS] \
  [--import F] [--cpu-prof] [--instruments] [--alarm-s N]
vt selfcheck
```

- A host-only run never waits for a remote leg. `LEAN-WAIT`, `LEAN-GO` and `LEAN-NOTE` appear only when a step is delegated.
- Every orchestrator line passes through the secret masker before it is written to stdout and `ev/driver.log`. The shapes are the lean rig's: a `say` line, `RUN-MARK <name> <ms>` for each name (`p1-start`, `p1-end`, `p2-start`, `p2-end`), `RESULT {json}`, and a final `SUMMARY PASS` or `SUMMARY FAIL <leg> <token>` after which no further line is written.
- Exit 0 on `SUMMARY PASS`, 1 on `SUMMARY FAIL`, 2 on a usage error. A usage error prints its code alone plus a void `RESULT` line; no argument is echoed.
- `<state>/ev/results.json` is written once, mode 0600, and never overwritten. Its nine keys are:
  - `tool` — the fixed producer name.
  - `summary` — the final `PASS` or `FAIL <leg> <token>` string.
  - `legs` — one status per leg: name, status, failure token, scan flag, reason.
  - `durations` — the measured step windows.
  - `steps` — named start and end times.
  - `secretScan` — whole-text, window and file hit counts.
  - `keys` — masked handoff keys.
  - `startedAt` — the ISO start time.
  - `endedAt` — the ISO end time.
- `ev/debug.log` keeps the `<ISO> <namespace> <msg>` shape, so the profile tools (`prof/netstats.mjs`, `prof/cpuslice2.mjs`) read it unchanged. Authority stderr goes there; every other peer writes `ev/<label>.log`, and every call is recorded in `ev/commands.log` without its arguments.
- `--instruments` is opt-in. Without it no preload is installed.
- `vt selfcheck` runs offline and checks the line grammar, masking, scan, results keys and write-once rule.

## State layout

Both the run state and each peer home are created 0700; every file below is 0600.

```
<state-dir>/                     run root (outside the repo, never reused)
├── ev/
│   ├── results.json             written once, 0600, the nine keys above
│   ├── driver.log               the orchestrator's masked lines
│   ├── debug.log                <ISO> <namespace> <msg> from authority stderr
│   ├── commands.log             one line per verb call, arguments removed
│   └── <label>.log              per-peer output, one per daemon label
└── secrets/                     created-once secret files, handed over by path
    └── <label>.token            one approval token per peer

<run>/<party>/<label>/           one peer home; the basename is the label
├── ctl.port                     the control port, written last = ready
├── ctl.token                    the per-peer control token
├── daemon.lock                  single-process lock
├── daemon.json                  the booted peer description
├── crash.jsonl                  redacted crash records
├── boot-<n>.json                one record per boot
├── secrets/                     codes, shares and other handoff files
├── node/
│   ├── peer-key.json            the peer's key material
│   ├── user.json                the authority user record
│   ├── async-storage.json       the async storage mirror
│   ├── local-storage.json       the local storage mirror
│   └── store/scope-<name>/      per-scope strand stores
└── vault/
    ├── vault.salt               the at-rest salt
    ├── at-rest.key              the at-rest key
    ├── token.check              the token-derived check value
    └── keyvault-storage.sealed.json   the sealed identity store
```

The `--state` dir is outside the repo; an in-repo dir or a dir already holding an `ev/` is refused. A stopped daemon restarts on the same home because both the vault and the sealed key-vault storage persist.

## Approval token

- A 256-bit random value stands in for user presence. `generateApprovalToken()` makes it and `writeApprovalTokenFile()` writes it once, 0600, in a 0700 parent; a second write refuses rather than overwrite.
- It is read afresh per approval-class action: from a 0600 file by default (`--token-file <path>`), from stdin (`--token-stdin`), or from the variable named by `APPROVAL_TOKEN_ENV` (`VT_APPROVAL_TOKEN`). An env var is visible to same-user process listings, so prefer the file.
- A group-readable or other-readable token, a symlink, a foreign-owned file and a short value are all refused before any write.
- Approval-class actions are officer signatures, keyholder seat unlock and release, and voter signing. Each call proves the token again; nothing is cached across calls.

## Test postures

- **Token attestation.** `--accept-token-attestations` on an officer daemon accepts a voter's token-attested association. It is a **TEST** posture and is refused for the production party `votetorrent` at flag parse, before any node boots. A production network never accepts one, because no app contains the token verifier.
- **Token signer and file vault.** Both live only in this package. Neither app depends on it, and neither app's release bundle contains it. The check is `scripts/assert-vt-cli-release-absence.mjs`.
- **`--party`.** `vt run election` refuses the production party id with a usage error. A bare `vt <role> start` on the production party is **allowed** and logs `posture=production`, because that is how phones join a host-officer network; any test-posture flag on that party is refused. This is read from `src/daemon/posture.ts`, not inferred from the run rule.
- **`requireSignedSchemas:false`.** This is not a vt-only switch. Both shipped apps set it on the production party as a recorded project decision, so an absent schema signature is tolerated while a present but invalid one is still rejected. `vt` inherits the same setting through the shared node-option builder the apps use, so it tests the apps' real signature policy; under `vt` it only ever runs on a non-production party.

## Parallel runs

- Give each run its own `--state` dir and a unique `--party`. A reused dir or a repeated party id is refused.
- Control ports are ephemeral; no run binds a fixed port.
- `--max-peers` defaults to 0.45 of total memory divided by 700 MiB per peer. A topology above the limit is refused before any state dir, file or process exists.

## Secrecy

- `vt` never prints a join code, invitation, seat share, key, signature or ciphertext. They are written to 0600 files under `secrets/` and handed over by path.
- Peer ids are shown by their last 8 characters only.
- The end-of-run secret scan turns any leak into `SUMMARY FAIL <leg> secret-leak`.

## Shared workflow code

- The workflows `vt` runs are the apps' own, imported from `@votetorrent/workflows` and `@votetorrent/vote-engine`. `vt` never copies one; `scripts/audit-no-mirrors.mjs` enforces that.
- No loader hooks are used: `dist` loads under plain Node.

## Exit codes

| code | meaning |
|------|---------|
| 0 | PASS |
| 1 | FAIL |
| 2 | usage (missing or unknown command, bad flags) |
| 3 | daemon unreachable |

`vt` with no command prints the usage to stderr and exits 2; `vt --help` prints it to stdout and exits 0. An unknown command is never echoed back, since an argument may be a code or a path to a secret.

## Build freshness

Both apps and this CLI consume the BUILT packages: `package.json` `main`/`exports` point at `dist/`, and `dist/` is gitignored, so a stale build never shows in `git status`. Before a daemon starts or `vt run` begins, `assertFreshBuild()` (in `src/engine.ts`) checks, in build order, that

- `packages/vote-core/dist/src/index.js`,
- `packages/vote-engine/dist/rn-entry.js`, and
- the `packages/workflows` entry named by its manifest's `exports["."].import`

each exist and are no older than the newest file under that package's `src/`. It refuses with a `StaleBuildError` whose `code` is `not-built`, `stale` or `src-missing` and whose message names the package and the fix, never a path. Importing `src/engine.ts` has no side effect; `vt --help` works on an unbuilt tree.

The fix is always the build order above: vote-core, then vote-engine, then workflows.

## Replaced tools

`tools/vote-cli` (the daemon-per-device JSON-RPC CLI), `tools/lean-rig` (the all-host election driver) and `scripts/seed-election.sh` were deleted at the end of the vt CLI work, after the CLI-06 acceptance run on 2026-11-26. `vt` replaces them. Do not re-create them: extend `vt` instead.

To read the deleted files from history: `git log --diff-filter=D --oneline -- tools/lean-rig tools/vote-cli` gives the deletion commit, and `git show <commit>^:tools/lean-rig/README.md` reads a file as it was. The committed old E2E reports (`tools/vote-cli/reports/*`) are read the same way.

### Rig legs to `vt` verbs

| Rig entry | `vt` replacement |
|---|---|
| lean-part1 `found` | `vt officer found` |
| lean-part1 `mint` | `vt officer mint` |
| lean-part1 `join` | `vt officer join`, `vt keyholder join` |
| lean-part1 `owner-setup` | `vt officer owner-setup` |
| lean-part1 `authority-id` | `vt officer authority-id` |
| lean-part1 `readback` | `vt officer readback`, `vt keyholder readback`, `vt voter readback` |
| lean-part1 `capability` | `vt officer capability`, `vt keyholder capability` |
| lean-part1 `stop` | `vt officer stop`, `vt keyholder stop`, `vt voter stop` |
| lean-part2 `legReopen` | restart a daemon on its existing state dir with `vt officer start --state <dir>` (its `ctl.port` and `ctl.token` are kept) |
| lean-part2 `legElection` | `vt officer create-election`, `vt officer keyholder-policy`, `vt officer invite-keyholder`, `vt officer ballot-submit`, `vt officer task-sign`, `vt officer enable-intake` |
| lean-part2 `legAccept` | `vt keyholder accept` |
| lean-part2 `legDkg` | `vt keyholder dkg` |
| lean-part2 `legVoters` | `vt voter join`, `vt voter register`, `vt voter stage-association`, `vt voter answer-challenge`, `vt voter read-decision`, `vt voter cast`, `vt voter send`; officer `vt officer registrations`, `vt officer approve`, `vt officer refuse`, `vt officer peer-sync` |
| lean-part2 `legRelease` | `vt officer release-window`, `vt keyholder release`, `vt officer tally`, `vt officer publish`, then `vt officer results`, `vt keyholder results` and `vt voter results` on every peer |
| `host-kh.ts` | a keyholder daemon, now restartable between accept and release because of the file vault (CLI-03) |
| `host-voter.ts` stages | `vt voter join`, `vt voter register`, `vt voter stage-association`, `vt voter answer-challenge`, `vt voter read-decision`, `vt voter cast`, `vt voter send`, `vt voter results` |
| `run-lean.sh run` | `vt run election` |
| `run-lean.sh selfcheck` | `vt selfcheck` |
| the three retired loader hooks (the s63, authority and hr5 hook files) | none needed: the shared code lives in `@votetorrent/workflows`, so `dist` loads under plain Node |
| the in-memory vault | `FileKeyVault`, held by the daemon between calls |

### Old JSON-RPC commands to `vt` verbs

| Old command | `vt` replacement |
|---|---|
| `network create` | `vt officer found` |
| `network join-code` | `vt officer mint` |
| `network join <code>` | `vt voter join`, `vt keyholder join` |
| `officer invite`, `keyholder invite` | `vt officer invite-keyholder` |
| `invite accept <share>`, `keyholder accept` | `vt keyholder accept` |
| `intake-key register` | not carried (part of the officer's intake setup) |
| `admin set-scopes` | not carried as a standalone verb; the keyholder policy is `vt officer keyholder-policy` |
| `election create` | `vt officer create-election` |
| `election list`, `election show`, `network show`, `network revise`, `admin show` | not carried as standalone verbs |
| `ballot propose`, `ballot submit`, `ballot confirm` | `vt officer ballot-submit` |
| `tasks list`, `tasks sign` | `vt officer task-sign` |
| `registration field-add` | not carried |
| `registration sync` | `vt officer peer-sync` |
| `registration approve`, `registration reject` | `vt officer approve`, `vt officer refuse` |
| `registrants list` | `vt officer registrations` |
| `keyholder dkg` | `vt keyholder dkg` |
| `keys release` | `vt keyholder release` |
| `register`, `registration status` | `vt voter register`, `vt voter read-decision` |
| `vote cast` | `vt voter cast` |
| `vote send` | `vt voter send` |
| `election results` | `vt officer results`, `vt keyholder results`, `vt voter results` |

### What is not carried over

- Partial seeding with a hold on party `votetorrent` and the seeder's interactive menu. For a non-production party, start the daemons and run the verbs up to the stage you want; they stay live until `vt officer stop`, `vt keyholder stop` or `vt voter stop`.
- A seed that phones can join: it needs party `votetorrent`, which `vt run election` refuses, and token-attested voters are refused there by design. This is deferred with the phone-role work; see the pending todo `2026-11-24-vt-seed-election-for-device-uat`.
- The `LEAN_PHONE`, `LEAN_PHONE_KH`, `LEAN_PHONE_KH2` and `LEAN_PHONE_VOTER` phone modes. `vt run` keeps the `LEAN-WAIT` / `LEAN-GO` delegation lines so they can return.

### Relay and run dirs (kept)

`VT_LEAN_RELAY_ENV` still names a relay.env file with the four keys `RELAY_MULTIADDR=`, `PEER_ID=`, `LAN_IP=` and `STARTED_AT=`. Pass it as `--relay "$VT_LEAN_RELAY_ENV"`; the multiaddr names a DNS host, a TCP port, a wss transport and a relay peer id, written only as angle-bracket placeholders (`<host>`, `<port>`, `<relay peer id>`). Run state goes outside the repo, conventionally under `VT_LEAN_RUNS` (default `<checkout>/../vt-lean-runs`), and `vt` refuses an in-repo state dir. "One party at a time" is replaced by `--party`.
