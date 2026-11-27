/**
 * libp2p-closure-probe.js — the Wave-1 A2 instrument's ONLY real import site.
 *
 * BUILD-ONLY. This module is never served in production, never linked from
 * `src/`, and is reachable only through `libp2p-closure-probe.html` ->
 * `vite.closure.config.ts`. Its sole job is to give Rollup a genuine entry
 * graph that reaches all seven newly declared packages — including the
 * `connectToStrand` -> `StrandDatabase` path `56-16` (Wave 4) will build —
 * so `scripts/assert-libp2p-closure.mjs` can settle RESEARCH Assumption A2
 * against a REAL browser module graph rather than an empty one. Declaring a
 * dependency does not put it in a bundle; only something the entry graph
 * reaches does.
 *
 * FIVE HARD CONSTRAINTS (each load-bearing, do not "clean up" any of them):
 *
 * 1. `@optimystic/db-p2p/rn` ONLY, never the package root. `/rn` is the
 *    bring-your-own-transport entrypoint and is transport-agnostic despite
 *    its name; the root entry is where Node-only transports live. Which
 *    subpath a closure came through is one of the five items a negative A2
 *    verdict must record.
 * 2. NOTHING IS CALLED. No invocation of any imported function, no `new` on
 *    any imported class. This plan settles BUNDLING, not runtime. Executing
 *    the closure in a browser is 56-05's and 56-11's job; a probe that runs
 *    is a different, unauthorised experiment.
 * 3. `loadOrCreateBrowserPeerKey` (also exported by `@optimystic/db-p2p-storage-web`,
 *    re-exported through `identity.js`) MUST NOT appear as an import anywhere
 *    in this file. It is the persisted-identity path D-08 forbids. Naming it
 *    here, in prose, is fine — importing it is not.
 * 4. Both `@serfab/*` packages are imported at their ROOT specifier (`.`)
 *    ONLY. Never `@serfab/quereus-plugin-sereus/plugin`, never
 *    `/plugin-browser` (a 4,482,803-byte pre-bundle that inlines most of the
 *    libp2p stack and would duplicate the closure), and never any of
 *    `@serfab/cadre-core`'s `-file` or `push-node` subpaths (every `node:`
 *    specifier in that package lives behind one of those subpaths — importing
 *    one would manufacture an A2 failure the product does not have).
 * 5. Every import is a VALUE import. `StrandConnectionOptions`,
 *    `SereusPluginResult`, `StrandTransactor` and `StrandDatabaseConfig` are
 *    type-only exports that TypeScript erases; a probe built out of type
 *    imports would produce an empty graph and a vacuous green — precisely the
 *    failure mode `assert-libp2p-closure.mjs` section 5's anti-vacuity check
 *    exists to catch, so this file must not rely on that check to catch it.
 *
 * `@quereus/plugin-indexeddb/plugin` is also imported below (default export,
 * matching `packages/web-data/src/open-db.js:30` exactly). It is not one of
 * the seven declared packages; it is here so `assert:single-quereus:closure`
 * (Task 3) has both of ITS watched packages present in the graph.
 * `@quereus/quereus` itself is deliberately NOT imported directly: the two
 * `@serfab/*` packages already pull it as a real runtime dependency
 * (`quereus-plugin-sereus/dist/connect.js:1` imports `registerPlugin`;
 * `cadre-core/dist/strand-database.js` imports `Database`), and a redundant
 * direct import here would make it impossible to tell whether the engine
 * arrived through the closure or through the probe itself.
 */

import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { edgeProfile } from '@optimystic/db-core';
import { openOptimysticWebDb, IndexedDBRawStorage } from '@optimystic/db-p2p-storage-web';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { connectToStrand, resolveStrandClusterSize } from '@serfab/quereus-plugin-sereus';
import { StrandDatabase, canonicalJson } from '@serfab/cadre-core';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';

// Retain every import against tree-shaking by publishing them as OBJECT
// LITERAL PROPERTY VALUES, with the sentinel as a quoted PROPERTY KEY (not a
// local-variable value). This is required, not stylistic:
// `project_esbuild_minifier_defeats_naive_dist_controls` measured that
// esbuild renames bare local bindings, so a sentinel held in a local variable
// is falsely inert after minification, while a quoted object-literal
// property key survives. Do not use a `typeof` probe for the same reason.
globalThis.__LIBP2P_CLOSURE_PROBE__ = {
	'vtx-libp2p-closure-probe': true,
	createLibp2pNode,
	edgeProfile,
	openOptimysticWebDb,
	IndexedDBRawStorage,
	webSockets,
	generateKeyPair,
	privateKeyToProtobuf,
	privateKeyFromProtobuf,
	connectToStrand,
	resolveStrandClusterSize,
	StrandDatabase,
	canonicalJson,
	indexeddbPlugin,
};
