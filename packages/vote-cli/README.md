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
- The public relay is used only for the single full-election acceptance run, and never while another run of the same party id is live.

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
