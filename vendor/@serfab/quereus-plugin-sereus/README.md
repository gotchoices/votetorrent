# @serfab/quereus-plugin-sereus

A [Quereus](https://github.com/nicktobey/quereus) plugin that connects a Quereus
database to a [Sereus](../../docs/architecture.md) strand for SQL access. It
composes the [@optimystic/quereus-plugin-crypto](https://github.com/nicktobey/optimystic/tree/main/packages/quereus-plugin-crypto)
and [@optimystic/quereus-plugin-optimystic](https://github.com/nicktobey/optimystic/tree/main/packages/quereus-plugin-optimystic)
plugins, manages libp2p networking, and optionally applies a sApp schema.

## Features

- **Strand connection**: Connect a Quereus database to a Sereus strand with a single call.
- **Plugin composition**: Automatically registers the crypto and optimystic plugins.
- **Node management**: Creates a libp2p node or accepts an injected one (e.g. from a CadreNode).
- **Schema application**: Wraps DDL in `declare schema App { ... } apply schema App;`.
- **Two runtimes**: A Node entry (`./plugin`) and a self-contained browser bundle
  (`./plugin-browser`) for Quoomb-web and other browser/worker hosts.
- **Two entry points**: A plugin-loader-compatible default export and a
  programmatic `connectToStrand()` API.

## Artifacts

The package ships two plugin artifacts, selected automatically by the consumer's
environment via the `exports` map:

| Artifact | Built by | Transports | Default storage | Use from |
|---|---|---|---|---|
| `dist/plugin.js` | `tsc` | TCP + WebSockets | in-memory / FS | Node (`./plugin`) |
| `dist/plugin-browser.js` | `esbuild` | WebSockets + circuit-relay | IndexedDB | Browser/worker (`./plugin-browser`) |

The browser bundle is a single self-contained ESM file (~2.5 MiB raw, ~550 KiB
gzipped). It bundles only the TCP-free libp2p surface (`@optimystic/db-p2p/rn`)
and does **not** import `@quereus/quereus` at runtime — registrations are applied
against the host-supplied `db`, so it reuses the host's Quereus instance rather
than instantiating a second one.

## Installation

```bash
npm install @serfab/quereus-plugin-sereus
# or
yarn add @serfab/quereus-plugin-sereus
```

---

## Using it from Quoomb Web (step by step)

[Quoomb Web](../../../quereus/packages/quoomb-web) loads plugins by URL: its
worker calls `import(url)` and registers the module's default export against the
live database. To connect Quoomb Web to a strand you need to (1) make the
**browser bundle** reachable at an importable URL, and (2) give it a strand id
and at least one **browser-dialable** bootstrap address.

### Prerequisites

- A **strand id** (UUID) to connect to.
- For networked use: a libp2p **bootstrap/relay reachable over secure WebSockets**
  (`/wss`) from an `https://` page. Browsers cannot dial raw TCP, and a plain
  `ws://`/`tcp` address will not dial from a TLS origin. WebSockets +
  circuit-relay are the only supported transports in v1.
- The strand's **sApp schema** (optional — only needed to bootstrap a brand-new
  strand or to expose `App.*` tables before any peer has).

### Step 1 — Make the browser bundle importable

Pick one of the hosting options below ([Hosting the browser
bundle](#hosting-the-browser-bundle)). The quickest are:

- **Published CDN URL** (recommended once published):
  `https://cdn.jsdelivr.net/npm/@serfab/quereus-plugin-sereus/dist/plugin-browser.js`
- **Local dev**: copy `dist/plugin-browser.js` into Quoomb Web's `public/` folder
  so it is served same-origin at `http://localhost:5173/plugin-browser.js`.

The URL must serve the file with `Content-Type: text/javascript` (or
`application/javascript`) and CORS that permits the page origin.

### Step 2a — Load via the Plugins panel (manual)

1. Open Quoomb Web → **Plugins** panel.
2. Paste the bundle URL into the plugin URL field and install it.
   - The manual installer validates the URL and only accepts **`https://`** (or
     `file://`) ending in `.js`/`.mjs`. A same-origin `http://localhost` URL is
     **rejected here** — use Step 2b (config) for local-dev http, or serve
     Quoomb over https.
3. Open the plugin's config and set at least:
   - `strand_id` — the strand UUID.
   - `bootstrap_nodes` — comma-separated `/wss` multiaddrs.
   - `schema` — optional sApp DDL.
4. Run a query, e.g. `select * from App.Message`.

### Step 2b — Load via `quoomb.config.json` (autoload)

The config/autoload path calls the loader directly and **bypasses the
https-only check**, so it is the right choice for local `http://localhost`
during development. In Quoomb Web, open the **Config** modal and import this
JSON (or set it as `quoomb.config.json`):

```jsonc
{
  "plugins": [
    {
      "source": "https://cdn.jsdelivr.net/npm/@serfab/quereus-plugin-sereus/dist/plugin-browser.js",
      "config": {
        "strand_id": "550e8400-e29b-41d4-a716-446655440000",
        "bootstrap_nodes": "/dns4/relay.example/tcp/443/wss/p2p/Qm...",
        "schema": "table Message (Id integer primary key, Content text not null)"
      }
    }
  ],
  "autoload": true
}
```

With `autoload: true`, the plugin loads on session start and applies the schema.

### Step 3 — Query the strand

Once loaded, the `optimystic` vtab is the default and `App.*` tables resolve
against the strand:

```sql
select * from App.Message;
insert into App.Message (Id, Content) values (1, 'hello strand');
```

### Notes & limitations

- **Storage.** When `storage` is not injected, the browser bundle opens a default
  `IndexedDBRawStorage` against an IndexedDB database named
  `sereus-strand-<strandId>`. State survives reload. The plugin treats the
  IndexedDB handle as borrowed and does **not** close it on `shutdown()` — its
  lifecycle is the page/worker.
- **Networked-only via the loader.** The plugin-loader settings expose the
  `network` transactor; offline/solo `bootstrap` mode is only reachable through
  the programmatic `connectToStrand({ mode: 'bootstrap' })` API.
- **WebRTC** requires cross-origin isolation (COOP/COEP) and is tracked as a
  follow-up; v1 is WebSockets + circuit-relay only.
- **Lifecycle.** Quoomb Web's loader keeps only the manifest and discards the
  plugin's returned `shutdown()`, so the libp2p node is torn down with the
  worker rather than on plugin unload.

---

## Hosting the browser bundle

The browser bundle is just an ESM file; it can be served from anywhere that
returns a JavaScript content type with appropriate CORS.

### Published package on a CDN (recommended)

After `yarn pub:quereus-plugin-sereus` (see [Publishing](#publishing)), the npm
package is mirrored by the public CDNs, which serve the correct content type and
CORS automatically:

- jsDelivr: `https://cdn.jsdelivr.net/npm/@serfab/quereus-plugin-sereus/dist/plugin-browser.js`
- jsDelivr (pinned): `https://cdn.jsdelivr.net/npm/@serfab/quereus-plugin-sereus@0.7.1/dist/plugin-browser.js`
- unpkg: `https://unpkg.com/@serfab/quereus-plugin-sereus/dist/plugin-browser.js`

### Self-hosted / same-origin

Copy `dist/plugin-browser.js` to any static host (or Quoomb Web's `public/`) and
reference it by URL. Same-origin hosting sidesteps CORS entirely.

### Loading from GitHub

Loading the bundle straight from a GitHub repo has a caveat: **`dist/` is
gitignored**, and `raw.githubusercontent.com` serves files as `text/plain` with
`X-Content-Type-Options: nosniff`, so the browser refuses to `import()` it as a
module. Two routes that *do* work:

1. **jsDelivr's GitHub endpoint**, which serves repo files with the correct MIME
   type and CORS — but only files that exist at the ref. Since `dist/` is not
   committed, this requires the built bundle to be present at the ref you point
   at (e.g. a CI step that commits `plugin-browser.js` to a `dist`/`gh-pages`
   branch or a tag):

   ```
   https://cdn.jsdelivr.net/gh/gotchoices/sereus@<tag-or-branch>/packages/quereus-plugin-sereus/dist/plugin-browser.js
   ```

2. **GitHub Pages**: publish `plugin-browser.js` to a Pages site, which serves it
   with a JavaScript content type and CORS.

For most cases the npm-backed CDN URL above is simpler and is the recommended
GitHub-free hosting path. (Note: GitHub *Release assets* are served as
`application/octet-stream` and cannot be imported as ESM.)

---

## Programmatic API

```typescript
import { Database } from '@quereus/quereus';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';

const db = new Database();
const strand = await connectToStrand(db, {
  strandId: '550e8400-e29b-41d4-a716-446655440000',
  schema: 'table Message (Id integer primary key, Content text not null)',
  bootstrapNodes: ['/ip4/1.2.3.4/tcp/9100/p2p/QmPeerId'],
});

for await (const row of db.eval('select * from App.Message')) {
  console.log(row);
}

await strand.shutdown();
```

### Plugin-loader (Node)

The `./plugin` export is compatible with Quereus plugin-loader:

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import sereusPlugin from '@serfab/quereus-plugin-sereus/plugin';

const db = new Database();
const result = await registerPlugin(db, sereusPlugin, {
  strand_id: '550e8400-e29b-41d4-a716-446655440000',
  schema: 'table Message (Id integer primary key, Content text not null)',
  bootstrap_nodes: '/ip4/1.2.3.4/tcp/9100/p2p/QmPeerId',
});

await result.shutdown();
```

### Bootstrap mode (solo node with persistent storage)

For a solo node (e.g. first-launch sApp init, single-host dev) that should apply
schema and accept DML without peer round trips, set `mode: 'bootstrap'` and pass
a persistent `IRawStorage`. The same storage instance is wired into both the
libp2p data path and the optimystic plugin's local transactor, so writes persist
across restart.

```typescript
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';

const storage = new FileRawStorage('./data/my-strand');
const strand = await connectToStrand(db, {
  strandId: 'abc',
  mode: 'bootstrap',
  storage,
  schema: 'table Msg (Id integer primary key, Body text not null)',
});
```

The plugin treats `storage` as borrowed: `shutdown()` releases the libp2p node
and collection factory but does **not** close the storage.

### With an injected node

When integrating with an existing CadreNode or other libp2p host:

```typescript
const strand = await connectToStrand(db, {
  strandId: 'abc',
  libp2pNode: existingNode,
  coordinatedRepo: existingRepo,
});
```

The plugin uses the injected node instead of creating one, and will not stop it
on shutdown.

---

## Configuration

### `StrandConnectionOptions` (programmatic API)

| Option | Type | Default | Description |
|---|---|---|---|
| `strandId` | string | *required* | UUID of the strand to connect to |
| `bootstrapNodes` | string[] | `[]` | Bootstrap multiaddrs for peer discovery |
| `schema` | string | — | sApp schema DDL to apply |
| `sAppId` | string | `'unknown'` | sApp author public key |
| `sAppVersion` | string | `'1.0.0'` | sApp version |
| `port` | number | `0` | libp2p listening port (0 = random) |
| `enableCache` | boolean | `true` | Enable optimystic caching |
| `fretProfile` | `'edge' \| 'core'` | `'edge'` | FRET profile |
| `libp2pNode` | Libp2p | — | Inject an existing libp2p node |
| `coordinatedRepo` | IRepo | — | Required when `libp2pNode` is provided |
| `mode` | `'bootstrap' \| 'networked'` | `'networked'` | `'bootstrap'` routes through the local transactor (no peer round trips); `'networked'` uses the network transactor |
| `storage` | IRawStorage | — | Persistent raw storage. Borrowed — not closed on `shutdown()` |

### Plugin settings (plugin-loader / Quoomb)

| Setting | Type | Default | Description |
|---|---|---|---|
| `strand_id` | string | *required* | UUID of the strand |
| `bootstrap_nodes` | string | `''` | Comma-separated bootstrap multiaddrs |
| `schema` | string | — | sApp schema DDL |
| `sapp_id` | string | `'unknown'` | sApp author public key |
| `sapp_version` | string | `'1.0.0'` | sApp version |
| `port` | number | `0` | libp2p listening port |
| `enable_cache` | boolean | `true` | Enable caching |
| `fret_profile` | string | `'edge'` | FRET profile (`'edge'` or `'core'`) |

**Bootstrap multiaddrs.** Browsers can only dial transports reachable from an
`https://` page. Use `/wss` (or `/dns/.../wss`, or a relay-fronted multiaddr).
Plain `/tcp/.../ws` over HTTP won't dial from a TLS origin, and raw TCP is
unavailable in the browser.

## Provided functions and modules

Registered automatically from the composed plugins:

- **Virtual table module**: `optimystic` (set as default vtab)
- **Functions**: `StampId()`, `digest()`, `sign()`, `verify()`, `randomBytes()`

---

## Development

```bash
yarn build    # tsc + esbuild (emits dist/plugin.js and dist/plugin-browser.js)
yarn test     # Run tests (unit + e2e projects, plus browser-bundle smoke tests)
yarn test:e2e # Run only the e2e project (real libp2p + FileRawStorage)
yarn dev:test # Watch mode
```

`build` runs `tsc -p tsconfig.build.json` (emits `dist/plugin.js`,
`dist/plugin-browser.js` declarations, and other entries) and then
`node scripts/build-browser.mjs` (overwrites `dist/plugin-browser.js` with the
bundled artifact and its sourcemap, and prints raw + gzipped size).

The browser-bundle smoke tests (`test/browser-bundle.spec.ts` and
`test/browser-shape.spec.ts`) run under the `unit` project: they build the
bundle on demand if missing, then check that the artifact parses as ESM, has no
Node-only or TCP imports, stays under the size caps, and that its default export
reaches the IndexedDB layer in a jsdom + `fake-indexeddb` environment.

The `e2e` project covers two scenarios over real libp2p + `FileRawStorage`:

- `test/e2e/bootstrap.e2e.spec.ts` — solo-node bootstrap mode, including
  cold-restart persistence across the shared storage directory.
- `test/e2e/networked.e2e.spec.ts` — two in-process peers exchanging strand data
  through a `createLibp2pNode` mesh: cross-peer replication, bidirectional
  convergence, and late-joiner catch-up.

## Publishing

From the monorepo root:

```bash
yarn pub:quereus-plugin-sereus   # clean + build + npm publish --access public
```

This is also included in the aggregate `yarn pub` release step. Publishing emits
both `dist/plugin.js` and the browser bundle `dist/plugin-browser.js` (both are
in the package `files`), so the CDN URLs under [Hosting the browser
bundle](#hosting-the-browser-bundle) resolve immediately after a successful
publish.

## License

MIT
</content>
</invoke>
