// jest.node.config.js — Node-environment Jest project for STR-02 (D-12/D-13).
//
// Diverges from jest.config.js (the react-native preset config) in two ways:
//   1. NO `preset: 'react-native'` — the RN preset wraps native-module mocking
//      machinery (rn-leveldb, AsyncStorage, etc.) that a plain-Node cadre-core
//      smoke does not need and that would mask a real native-load failure.
//   2. `testEnvironment: 'node'` explicit — this project's whole point is to
//      prove @serfab/cadre-core actually LOADS under plain Node (D-12), not
//      under the RN preset's jsdom-adjacent native-mock environment.
//
// Scoped via testMatch to ONLY the cadre-core-node.smoke.spec.ts file so this
// config never picks up the RN-preset specs (compliance-strand.spec.ts, etc.).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/engines/__tests__/cadre-core-node.smoke.spec.ts'],
  // Same-style ESM transform exception as jest.config.js — @serfab/cadre-core's
  // own dependency tree (libp2p, multiformats, @quereus/*) is ESM-only.
  transformIgnorePatterns: [
    'node_modules/(?!(@quereus|@optimystic|@votetorrent|@noble|inheritree|moat-maker|multiformats|@serfab|@libp2p|@multiformats|@chainsafe|libp2p|uint8arrays|uint8arraylist|uint8-varint|it-[^/]*|p-[^/]*|any-signal|race-signal|race-event|delay|interface-datastore|datastore-core|nanoid|main-event|progress-events|protons-runtime|get-iterator|merge-options|blockstore-core)/)',
  ],
  moduleNameMapper: {
    // Allow importing vote-engine test fixtures from the app workspace Jest suite.
    '^@votetorrent/vote-engine/test/fixtures/test-context$':
      '<rootDir>/../../packages/vote-engine/test/fixtures/test-context.ts',
    // registerDbPlugins is internal to vote-engine (not in its package `exports`
    // map) — deep-map to the built dist file so the smoke can call it explicitly
    // on the strand-built Database (D-04 crypto-UDF-wiring obligation).
    '^@votetorrent/vote-engine/database/initialize$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/database/initialize.js',
    // @serfab/cadre-core — ESM-only portal package (`"exports"` map has no bare
    // "require"/CJS condition). Jest's default (non-ESM) resolver can't resolve
    // its exports map the way plain Node ESM does, so map to the `main` entry
    // directly (same pattern as @quereus/quereus above) — the ESM→CJS transform
    // exception in transformIgnorePatterns still applies so Babel can process it.
    '^@serfab/cadre-core$':
      '<rootDir>/node_modules/@serfab/cadre-core/dist/index.js',
    // @optimystic/quereus-plugin-optimystic — transitive dep of the real
    // @serfab/cadre-core (StrandDatabase registers it internally). Same
    // exports-map/CJS-resolver mismatch as above; map both subpaths.
    '^@optimystic/quereus-plugin-optimystic$':
      '<rootDir>/node_modules/@optimystic/quereus-plugin-optimystic/dist/index.js',
    '^@optimystic/quereus-plugin-optimystic/plugin$':
      '<rootDir>/node_modules/@optimystic/quereus-plugin-optimystic/dist/plugin.js',
    // @optimystic/db-p2p / db-core — transitive deps of the real @serfab/cadre-core
    // (CadreNode's libp2p/strand transport stack). db-core is portal-vendored and
    // only hoisted to the monorepo ROOT node_modules (not the app workspace), so
    // its mapper target points one level further up than the app-local ones above.
    '^@optimystic/db-p2p$':
      '<rootDir>/node_modules/@optimystic/db-p2p/dist/src/index.js',
    '^@optimystic/db-p2p/testing$':
      '<rootDir>/node_modules/@optimystic/db-p2p/dist/src/testing/index.js',
    '^@optimystic/db-p2p/(.*)$':
      '<rootDir>/node_modules/@optimystic/db-p2p/dist/src/$1.js',
    '^@optimystic/db-core$':
      '<rootDir>/../../node_modules/@optimystic/db-core/dist/src/index.js',
    // @libp2p/* — transitive deps of the real @serfab/cadre-core (CadreNode's
    // libp2p transport/crypto/peer-id stack); ESM-only `exports` map, no CJS
    // condition. Generic subpath mapper covers the whole `dist/src/<sub>.js`
    // shape used consistently across the @libp2p/* package family.
    '^@libp2p/crypto$':
      '<rootDir>/node_modules/@libp2p/crypto/dist/src/index.js',
    '^@libp2p/crypto/keys$':
      '<rootDir>/node_modules/@libp2p/crypto/dist/src/keys/index.js',
    '^@libp2p/crypto/ciphers$':
      '<rootDir>/node_modules/@libp2p/crypto/dist/src/ciphers/index.js',
    '^@libp2p/crypto/hmac$':
      '<rootDir>/node_modules/@libp2p/crypto/dist/src/hmac/index.js',
    '^@libp2p/crypto/(.*)$':
      '<rootDir>/node_modules/@libp2p/crypto/dist/src/$1.js',
    '^@libp2p/peer-id$':
      '<rootDir>/node_modules/@libp2p/peer-id/dist/src/index.js',
    '^@libp2p/interface$':
      '<rootDir>/node_modules/@libp2p/interface/dist/src/index.js',
    '^@libp2p/interface/(.*)$':
      '<rootDir>/node_modules/@libp2p/interface/dist/src/$1.js',
    '^@multiformats/multiaddr$':
      '<rootDir>/node_modules/@multiformats/multiaddr/dist/src/index.js',
    // main-event — bare ESM-only leaf dep of @libp2p/interface.
    '^main-event$':
      '<rootDir>/node_modules/main-event/dist/src/index.js',
    // uint8arrays as required by @libp2p/crypto — a SEPARATE nested copy
    // (@libp2p/crypto/node_modules/uint8arrays@6.1.1) from the app-level
    // 3.1.1 copy the rest of the libp2p tree uses; this nested copy has NO
    // "require"/CJS condition at all (pure `import`/`module-sync`), so Jest's
    // default resolver can't find it without an explicit mapper. Scoped via
    // the `@libp2p/crypto/` require-stack path so it does not shadow the
    // app-level 3.1.1 copy other packages resolve correctly on their own.
    '^uint8arrays$':
      '<rootDir>/node_modules/@libp2p/crypto/node_modules/uint8arrays/dist/src/index.js',
    '^uint8arrays/(.*)$':
      '<rootDir>/node_modules/@libp2p/crypto/node_modules/uint8arrays/dist/src/$1.js',
    '^uint8arraylist$':
      '<rootDir>/node_modules/uint8arraylist/dist/src/index.js',
    '^protons-runtime$':
      '<rootDir>/node_modules/@libp2p/crypto/node_modules/protons-runtime/dist/src/index.js',
    '^uint8-varint$':
      '<rootDir>/node_modules/@libp2p/crypto/node_modules/uint8-varint/dist/src/index.js',
    // it-* — libp2p's streaming-iterable utility packages, ESM-only `exports`
    // map, no CJS condition. Generic mapper covers the whole family
    // (it-pipe, it-pushable, it-length-prefixed, it-stream-types, ...) via
    // their consistent `dist/src/index.js` (or subpath) shape.
    '^(it-[^/]*)$':
      '<rootDir>/node_modules/$1/dist/src/index.js',
    '^(it-[^/]*)/(.*)$':
      '<rootDir>/node_modules/$1/dist/src/$2.js',
    // ESM-only packages: map to their `main` entry so Jest's CJS resolver can find them.
    '^@quereus/quereus$':
      '<rootDir>/node_modules/@quereus/quereus/dist/src/index.js',
    '^@quereus/quereus/(.*)$':
      '<rootDir>/node_modules/@quereus/quereus/dist/src/$1',
    '^@quereus/store$':
      '<rootDir>/node_modules/@quereus/store/dist/src/index.js',
    // quereus-plugin-crypto lives in packages/vote-engine/node_modules/ (not app's node_modules).
    '^@optimystic/quereus-plugin-crypto$':
      '<rootDir>/../../packages/vote-engine/node_modules/@optimystic/quereus-plugin-crypto/dist/index.js',
    '^@optimystic/quereus-plugin-crypto/plugin$':
      '<rootDir>/../../packages/vote-engine/node_modules/@optimystic/quereus-plugin-crypto/dist/plugin.js',
    '^@votetorrent/vote-core$':
      '<rootDir>/node_modules/@votetorrent/vote-core/dist/src/index.js',
    '^@votetorrent/vote-engine$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/index.js',
    '^@votetorrent/vote-engine/rn$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/rn-entry.js',
    // ESM-only transitive deps of @quereus/quereus — map to their main entry for CJS resolver.
    '^inheritree$': '<rootDir>/node_modules/inheritree/dist/index.js',
    '^moat-maker$': '<rootDir>/node_modules/moat-maker/build/index.js',
    // @noble/* subpath imports (used by @optimystic/quereus-plugin-crypto).
    '^@noble/curves$': '<rootDir>/node_modules/@noble/curves/index.js',
    '^@noble/curves/(.*)$': '<rootDir>/node_modules/@noble/curves/$1',
    '^@noble/hashes$': '<rootDir>/node_modules/@noble/hashes/index.js',
    '^@noble/hashes/(.*)$': '<rootDir>/node_modules/@noble/hashes/$1',
    // @babel/runtime — hoisted to app workspace node_modules but not to root/packages.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    // @quereus/isolation — ESM-only dep of @quereus/store; no "require" condition in exports map.
    '^@quereus/isolation$': '<rootDir>/node_modules/@quereus/isolation/dist/src/index.js',
    // multiformats — ESM-only subpath `exports` map, no CJS condition. cadre-core's
    // transitive tree (db-core, db-p2p, quereus-plugin-optimystic) pulls many
    // subpaths beyond the handful jest.config.js maps individually — a single
    // generic mapper covers the whole `dist/src/<subpath>.js` shape.
    '^multiformats$': '<rootDir>/node_modules/multiformats/dist/src/index.js',
    '^multiformats/(.*)$': '<rootDir>/node_modules/multiformats/dist/src/$1.js',
    // Strip .js extension from relative imports inside vote-engine TypeScript source files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // @react-native-async-storage/async-storage — native RN module pulled in
    // transitively by @votetorrent/vote-engine/rn (rn-entry.ts re-exports
    // LocalStorageReact, which imports AsyncStorage at module top level,
    // alongside the VOTETORRENT_SCHEMA_SQL export this smoke actually needs).
    // Same jest-provided mock jest.config.js already uses for the RN preset —
    // it is plain CJS (only depends on merge-options, itself plain CJS with a
    // proper `require` exports condition), so it loads fine under plain Node.
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    // Generic fallback for the remaining small libp2p-ecosystem ESM-only leaf
    // packages (race-signal, race-event, any-signal, delay, nanoid,
    // interface-datastore, datastore-core, blockstore-core, get-iterator,
    // progress-events, ...) that all follow the same `dist/src/index.js`
    // convention with no CJS `require` condition. Listed explicitly in
    // transformIgnorePatterns above (Babel must still transform them ESM→CJS);
    // this mapper handles Jest's module RESOLUTION separately.
    // NOTE: merge-options is deliberately NOT in this list — it is plain CJS
    // with a proper `require` exports condition (`./index.js`, no dist/src
    // subpath) and resolves natively; mapping it to a nonexistent
    // dist/src/index.js path breaks the async-storage-mock's own `require('merge-options')`.
    // Placed LAST so none of the more specific mappers above are shadowed.
    '^(race-signal|race-event|any-signal|delay|nanoid|interface-datastore|datastore-core|blockstore-core|get-iterator|progress-events)$':
      '<rootDir>/node_modules/$1/dist/src/index.js',
  },
};
