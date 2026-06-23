# Vendored portal packages

These are the `@serfab/*` and `@optimystic/db-*` packages VoteTorrentAuthority previously consumed
as `portal:`-against-sibling-source (`../sereus`, `../Optimystic`). They are vendored here so the app
— and a release APK — builds from a **clean votetorrent clone with no sibling checkout** (spike 014,
full-vendoring "option C").

Only built `dist/` + `package.json` (+ LICENSE/README where present) are copied. Each package.json is
preserved verbatim; its internal `workspace:^` deps are satisfied by the bare-name `portal:./vendor/...`
entries in the root `package.json` `resolutions`.

## Source commits (re-sync against these)

| Package | Source repo | Commit |
|---------|-------------|--------|
| `@serfab/cadre-core` | sereus | `80efcc496e9c8efe5ac9117002c0f6bd5855d696` (v0.8.0-92-g80efcc4, **dirty**) |
| `@serfab/strand-proto` | sereus | `80efcc496e9c8efe5ac9117002c0f6bd5855d696` |
| `@serfab/quereus-plugin-sereus` | sereus | `80efcc496e9c8efe5ac9117002c0f6bd5855d696` |
| `@optimystic/db-core` | Optimystic | `0e26fffa06771e618da76ce7ee875c153f596d71` (v0.13.5-345, clean) |
| `@optimystic/db-p2p` | Optimystic | `0e26fffa06771e618da76ce7ee875c153f596d71` |
| `@optimystic/db-p2p-storage-rn` | Optimystic | `0e26fffa06771e618da76ce7ee875c153f596d71` |

> The `sereus` tree was **dirty** at vendor time — it carries source edits not yet committed upstream.
> The most important is the **`connectionGater` forward** (spike 011), which is baked into the vendored
> `@serfab/cadre-core/dist/cadre-node.js` + `strand-instance-manager.js` and `types.d.ts`. This edit
> MUST travel with any re-vendored cadre-core.

## Rebuild steps (when re-syncing from upstream)

The sereus monorepo ships these three without a committed `dist`, so re-vendoring requires building first:

1. `@serfab/strand-proto`, `@serfab/quereus-plugin-sereus` — esbuild transpile:
   `esbuild src/*.ts --outdir=dist --format=esm --platform=node`
2. `@serfab/cadre-core` — emit the missing `.d.ts`:
   `tsc -p tsconfig.build.json --emitDeclarationOnly --declaration`
   and ensure the `connectionGater` forward is present in `dist/cadre-node.js`,
   `dist/strand-instance-manager.js`, and `dist/types.d.ts`.
3. `@optimystic/db-*` — git-clean with committed `dist`; copy `dist/` + `package.json` as-is.

Then copy each `dist/` + `package.json` into `vendor/<scope>/<pkg>/` and `yarn install`.

## D-01 reconciliation

Commit `5b1b0ee` vendored a **superset** of the CONTEXT-scoped minimal-B approach. CONTEXT.md D-01
specified vendoring only the 3 `@serfab` packages (`cadre-core`, `strand-proto`,
`quereus-plugin-sereus`); approach C (full-vendor including `@optimystic/*`) was explicitly rejected.
The commit additionally vendored `@optimystic/db-core`, `@optimystic/db-p2p`, and
`@optimystic/db-p2p-storage-rn`.

**Disposition: accepted, not reverted.** The superset vendoring still satisfies PORT-03 / SC1
(clean-clone reproducibility) — it is a strict superset of the minimal requirement and introduces no
source-edit fragility. The `@optimystic/db-*` packages are git-clean with committed upstream `dist`
(Optimystic commit `0e26fffa06771e618da76ce7ee875c153f596d71`, clean) and carry no local patches; their
vendored dist is identical to what the sibling checkout would provide. Removing them would require
re-wiring the app manifest and resolutions to point back to a sibling tree, trading reproducibility
for a minimal vendor footprint — not a worthwhile trade.

**Summary:** on-disk vendor state = 3 `@serfab` packages (minimal-B) + 3 `@optimystic/db-*` packages
(superset). Both sets satisfy PORT-03/SC1. The extra `@optimystic/db-*` packages are accepted and
retained.

## Boundary (NOT vendored — stay PUBLISHED)

`@quereus/quereus@3.3.0` and the two quereus-interfacing plugins
(`@optimystic/quereus-plugin-crypto`, `@optimystic/quereus-plugin-optimystic`) remain on published
ranges (+ the `.yarn/patches`). Their source types target quereus `~0.16.2` and would not match the
pinned 3.3.0 `VirtualTable`; their patches (incl. composite-PK) must persist. Do not vendor or portal them.
