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
    'node_modules/(?!(@quereus|@optimystic|@votetorrent|@noble|inheritree|moat-maker|multiformats|@serfab)/)',
  ],
  moduleNameMapper: {
    // Allow importing vote-engine test fixtures from the app workspace Jest suite.
    '^@votetorrent/vote-engine/test/fixtures/test-context$':
      '<rootDir>/../../packages/vote-engine/test/fixtures/test-context.ts',
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
    // multiformats — ESM-only subpath imports used by @optimystic/quereus-plugin-crypto.
    '^multiformats/cid$': '<rootDir>/node_modules/multiformats/dist/src/cid.js',
    '^multiformats/bases/base16$': '<rootDir>/node_modules/multiformats/dist/src/bases/base16.js',
    '^multiformats/bases/base32$': '<rootDir>/node_modules/multiformats/dist/src/bases/base32.js',
    '^multiformats/bases/base58$': '<rootDir>/node_modules/multiformats/dist/src/bases/base58.js',
    '^multiformats/bases/base64$': '<rootDir>/node_modules/multiformats/dist/src/bases/base64.js',
    '^multiformats/hashes/digest$': '<rootDir>/node_modules/multiformats/dist/src/hashes/digest.js',
    // Strip .js extension from relative imports inside vote-engine TypeScript source files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
