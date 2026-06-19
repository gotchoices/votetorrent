# Portal-Source Setup: VoteTorrentAuthority on Sereus 0.8.0

Status: VERIFIED on Android/Hermes (Pixel_8 emulator), 2026-06-19.
Commits: 27fbca2 (spike-010) + f3c1ac6 (spike-011)

These two commits are the PORT-01 implementation — they wire the `portal:` dependencies,
Metro config, and Hermes polyfills. This runbook documents the boundary + the
connectionGater re-apply steps + the acceptance gate; it does NOT re-describe what the
commits themselves do.


## 1. Prerequisites

### Node version

Portal-source resolution requires Node ≥ 20.19. The recipe was validated under Node 22.

```bash
nvm use 22.15.0   # .nvmrc in repo root pins this version
node --version    # should print v22.15.0
```

A root `.nvmrc` (`22.15.0`) and `engines: { node: ">=20.19" }` field (root + app
`package.json`) document the floor. Yarn 4.7.0 emits a warning at install time if Node
is below the declared minimum; no hard preinstall gate is in place (soft pin only).

### Sibling repo layout

The portal symlinks resolve through this directory tree:

```
<super-root>/            ← parent directory holding all three repos
  votetorrent/           ← this repo
  sereus/                ← Sereus/Optimystic monorepo (cadre-core, strand-proto, quereus-plugin-sereus)
  Optimystic/            ← Optimystic monorepo (db-core, db-p2p, db-p2p-storage-rn)
```

The root `resolutions` block and the app `package.json` direct deps use relative
`portal:` paths — e.g. `portal:../sereus/packages/cadre-core`. Metro's `superRoot`
(`path.resolve(__dirname, '../../..')`) watches the sibling trees via `watchFolders`.

Both sibling working trees must be present (cloned, not just installed) for the
portal symlinks and Metro watch to work. Phase 27 addresses reproducibility from a
clean clone (vendoring).


## 2. Portal Dependency Boundary

The published/portal split is load-bearing. Changing it breaks type resolution and
loses the composite-PK patch.

| Package | Source | Why |
|---------|--------|-----|
| `@serfab/cadre-core` | `portal:../sereus/packages/cadre-core` | portal |
| `@serfab/quereus-plugin-sereus` | `portal:../sereus/packages/quereus-plugin-sereus` | portal |
| `@serfab/strand-proto` | `portal:../sereus/packages/strand-proto` | portal |
| `@optimystic/db-core` | `portal:../Optimystic/packages/db-core` | portal |
| `@optimystic/db-p2p` | `portal:../Optimystic/packages/db-p2p` | portal |
| `@optimystic/db-p2p-storage-rn` | `portal:../Optimystic/packages/db-p2p-storage-rn` | portal |
| `@quereus/quereus` | `3.3.0` (published) | **PUBLISHED — load-bearing boundary** |
| `@optimystic/quereus-plugin-crypto` | `0.13.5` (published) | **PUBLISHED — load-bearing boundary** |
| `@optimystic/quereus-plugin-optimystic` | `0.13.5` (published, patched) | **PUBLISHED — load-bearing boundary** |

**Rationale for keeping quereus + the two plugins published:**
The portal-source types in `../sereus` target quereus `~0.16.2`. Portalling
`@quereus/quereus` would break type resolution across the entire monorepo graph.
Additionally, `@optimystic/quereus-plugin-optimystic` carries the composite-PK
point-lookup fix (`.yarn/patches/...optimystic-quereus-plugin-optimystic-...`) which
only applies to the published artifact; portalling the plugin would lose the patch.

**Live guard:** `yarn lint:peers` (wired into `postinstall` and root `lint`) via
`scripts/check-peer-requirements.mjs` — exits non-zero on unexpected
`@optimystic/quereus-plugin-*` peer mismatches. Run it any time you suspect the
boundary has drifted.

```bash
yarn lint:peers   # should exit 0 with "OK — @optimystic/quereus-plugin-* peer mismatches match the known-allowed set"
```


## 3. PORT-02: connectionGater Re-apply

The Sereus `cadre-core` 0.8.0 source does not forward a caller-supplied
`connectionGater` to `createLibp2pNode`. Without this forward, React Native nodes
cannot dial insecure-ws or private/loopback addresses (the AVD emulator host is a
private address). The fix is a three-file edit in `../sereus/packages/cadre-core`.

**The edit is already applied** in the working tree (but uncommitted — see
Phase 27 for vendoring). Both call sites are mandatory (if only `cadre-node.ts` is
patched, strand-plane dials still fail).

### File 1: `src/types.ts` — add `connectionGater` field to `NetworkConfig`

```diff
--- a/packages/cadre-core/src/types.ts
+++ b/packages/cadre-core/src/types.ts
@@ NetworkConfig interface @@
+  /**
+   * Optional libp2p connectionGater forwarded to createLibp2pNode for both the
+   * control node and each strand node. React Native nodes supply a permissive
+   * gater (e.g. `{ denyDialMultiaddr: async () => false }`) so they can dial
+   * insecure-ws / private addresses — VoteTorrent spike 009/011.
+   */
+  connectionGater?: unknown;
```

(Insert before `enableRelay`; after `relayAddrs`.)

### File 2: `src/cadre-node.ts` — control node createLibp2pNode (line ~514)

```diff
--- a/packages/cadre-core/src/cadre-node.ts
+++ b/packages/cadre-core/src/cadre-node.ts
@@ control createLibp2pNode call @@
-      ...(network?.listenAddrs && { listenAddrs: network.listenAddrs })
+      ...(network?.listenAddrs && { listenAddrs: network.listenAddrs }),
+      // VoteTorrent spike 010/011: forward connectionGater so RN nodes can dial
+      // insecure-ws / private addrs (the spike-009 device↔host fix; absent in 0.8.0).
+      ...(network?.connectionGater && { connectionGater: network.connectionGater })
```

### File 3: `src/strand-instance-manager.ts` — strand node createLibp2pNode (line ~263)

```diff
--- a/packages/cadre-core/src/strand-instance-manager.ts
+++ b/packages/cadre-core/src/strand-instance-manager.ts
@@ strand createLibp2pNode call @@
-        ...(config.network?.listenAddrs && { listenAddrs: config.network.listenAddrs })
+        ...(config.network?.listenAddrs && { listenAddrs: config.network.listenAddrs }),
+        // VoteTorrent spike 010/011: forward connectionGater to the STRAND libp2p node
+        // (key-network-strand dials on this node; the spike-009 fix, absent in 0.8.0).
+        ...(config.network?.connectionGater && { connectionGater: config.network.connectionGater })
```

### Dist rebuild command

After editing the three src files, rebuild the dist with tsc (NOT esbuild):

```bash
cd ../sereus/packages/cadre-core
yarn build   # → tsc -p tsconfig.build.json; outputs dist/*.js + dist/*.d.ts
```

The dist is **gitignored** in the sereus repo. The working-tree dist already carries
the edit (confirmed by Plan 01 verification — no rebuild was needed at execution time).

**Fragility warning:** A `git clean -fd` inside `../sereus` will wipe BOTH the
uncommitted src edits AND the built dist, leaving the repo in a broken state. This is
the core Phase 27 reproducibility concern. Until Phase 27 vendors the dist, never run
`git clean` in the sereus tree without first saving the diffs.

### Dist verification greps

After any rebuild (or to confirm the current state), run:

```bash
grep connectionGater ../sereus/packages/cadre-core/dist/cadre-node.js
grep connectionGater ../sereus/packages/cadre-core/dist/strand-instance-manager.js
grep connectionGater ../sereus/packages/cadre-core/dist/types.d.ts
```

Each should return at least one matching line. Zero matches = the dist does not carry
the fix and Metro will bundle the broken dist.


## 4. Acceptance Gate Commands

Run the full acceptance gate via the one-shot script:

```bash
./scripts/verify-portal-adoption.sh
```

This script (added in Phase 25 Plan 02, commit ed85674) codifies the four SC gates:

| Step | Command | Expected result |
|------|---------|-----------------|
| SC1 — install | `yarn install` | exit 0, no ERR |
| SC1 — Metro bundle | `yarn workspace votetorrent-authority react-native bundle --platform android --dev false --entry-file index.js --bundle-output /tmp/vt-portal.bundle --reset-cache` | exit 0; **3199 `__d()` module defines** (count noted; not pinned) |
| SC2 — vote-engine suite | `cd packages/vote-engine && yarn test` | **676 passing (11s), 18 pending, 0 failing** (count at 2026-06-19 execution; gate condition is `0 failing`, not the exact total) |
| Boundary | `yarn lint:peers` | exit 0 |

Run with `--skip-install` to bypass the install step on a known-good tree:

```bash
./scripts/verify-portal-adoption.sh --skip-install
```

The script emits `PORTAL ADOPTION GATE: PASS` when all four steps succeed.

**On-device boot (SC2, boot-only):** the app boots on Android/Hermes (Pixel_8 AVD)
with the `[rn-smoke] All /rn exports resolve on Hermes: PASS` marker visible in
logcat. Known/expected: `secp256k1.sign` is FATAL on Hermes — this does not block
boot and is tracked in Phase 28. The device↔host dial-completes proof is Phase 23.


## 5. Phase-17 Yarn Patch Orphan

The file `.yarn/patches/@serfab-cadre-core-npm-0.7.1-518fb48136.patch` still exists
on disk but is **not referenced** in `package.json` or `.yarnrc.yml`. No `yarn install`
invocation applies it.

This patch targeted the now-superseded published `0.7.1` line of `@serfab/cadre-core`.
The portal switch to `0.8.0` (spike-010) made it obsolete; the src-edit approach
(PORT-02 above) supersedes what the patch did. It is an inert orphan — it causes no
harm and can be deleted for cleanliness, but doing so is not a correctness concern.


## 6. Security Caveat

The VoteTorrent RN app passes this gater to `CadreNode`:

```typescript
connectionGater: { denyDialMultiaddr: async () => false }
```

This is a **permissive gater** — it re-enables dials to insecure-ws (`ws://`) and
private/loopback addresses. Specifically:

- It allows the app to dial the AVD emulator host (`10.0.2.2`) and the drone running
  on the dev machine over unencrypted WebSocket.
- It does **NOT** bypass libp2p's Noise encryption or peer authentication. The address
  filter is relaxed; the protocol security layer is unchanged.
- The RN client is a **transaction-profile node** — it dials out, it does not listen.
  The gater relaxes only the outbound address filter for the client side.

This configuration is appropriate for **development / AVD** environments. For
production, tighten the gater to whitelist only the known relay/drone address:

```typescript
connectionGater: {
  denyDialMultiaddr: async (addr) => {
    // Only allow the known relay/drone multiaddr prefix
    return !addr.toString().startsWith('/ip4/<relay-ip>');
  }
}
```


## 7. Phase 27 Reproducibility

### What stays fragile until Phase 27

The connectionGater fix in `../sereus/packages/cadre-core/` is:
- **Uncommitted** in the sereus git repo (3 modified src files: `cadre-node.ts`,
  `strand-instance-manager.ts`, `types.ts`).
- **Gitignored dist** — the built `dist/` is not tracked in sereus. It carries the
  fix in the current working tree but a `git clean -fd` or a fresh clone of sereus
  will lose it.

A developer cloning this repo from scratch cannot reproduce the working setup without
also checking out `../sereus`, applying the three-file diff above, and running
`yarn build` in `cadre-core`.

### What Phase 27 fixes

Phase 27 (Reproducibility & Vendoring) addresses this by vendoring the three fragile
`@serfab` dist packages into `vendor/@serfab/` (or upstreaming/publishing them).

### Proper landing options

1. **Minimal vendor (preferred for Phase 27):** copy the built dist for
   `cadre-core`, `strand-proto`, and `quereus-plugin-sereus` into `vendor/@serfab/`
   in this repo, update `resolutions` to point at the vendor copies, and commit the
   connectionGater edit as part of the vendored dist. No sibling checkout required
   from a clean clone.

2. **Upstream and publish:** submit the connectionGater forward to the upstream
   `sereus` repo (`packages/cadre-core`) and wait for a new published version.
   Switches back to a published dep (removes the portal / sibling checkout requirement
   entirely) but requires upstream cooperation and a new release.
