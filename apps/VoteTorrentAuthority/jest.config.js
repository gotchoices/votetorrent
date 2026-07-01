module.exports = {
  preset: 'react-native',
  // cadre-core-node.smoke.spec.ts (STR-02 D-12/D-13) is a dedicated
  // Node-environment test that imports the REAL @serfab/cadre-core with no
  // virtual mock — it must run ONLY under jest.node.config.js (testEnvironment
  // 'node', no RN preset). Excluded here so the RN preset's default resolver
  // (which has no mapper/mock for a real @serfab/cadre-core load) doesn't pick
  // it up and fail with a spurious "Cannot find module" (D-13 isolation).
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/src/engines/__tests__/cadre-core-node.smoke.spec.ts',
  ],
  // Allow Babel to transform ESM-only workspace packages and quereus packages
  // so tests can import them without ESM/CJS resolver failures.
  // Includes: @quereus/* (quereus engine), @optimystic/* (plugin), @votetorrent/* (workspace),
  // @noble/* (@optimystic/quereus-plugin-crypto peer), inheritree + moat-maker (quereus deps),
  // multiformats (ESM-only dep of @optimystic/quereus-plugin-crypto).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@quereus|@optimystic|@votetorrent|@noble|inheritree|moat-maker|multiformats|@serfab)/)',
  ],
  moduleNameMapper: {
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^@optimystic/db-p2p$': '<rootDir>/__mocks__/@optimystic/db-p2p.js',
    // Allow importing vote-engine test fixtures from the app workspace Jest suite.
    // The package exports field blocks subpath access; this mapper resolves the TS source directly.
    '^@votetorrent/vote-engine/test/fixtures/test-context$':
      '<rootDir>/../../packages/vote-engine/test/fixtures/test-context.ts',
    // ESM-only packages: map to their `main` entry so Jest's CJS resolver can find them.
    // The transformIgnorePatterns exception above then lets Babel transform them ESM→CJS.
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
    // The exports field has no "require" condition; map subpaths to their physical files.
    '^@noble/curves$': '<rootDir>/node_modules/@noble/curves/index.js',
    '^@noble/curves/(.*)$': '<rootDir>/node_modules/@noble/curves/$1',
    '^@noble/hashes$': '<rootDir>/node_modules/@noble/hashes/index.js',
    '^@noble/hashes/(.*)$': '<rootDir>/node_modules/@noble/hashes/$1',
    // @babel/runtime — hoisted to app workspace node_modules but not to root/packages.
    // Required by @votetorrent/vote-core dist (compiled with @babel/plugin-transform-runtime).
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    // @quereus/isolation — ESM-only dep of @quereus/store; no "require" condition in exports map.
    '^@quereus/isolation$': '<rootDir>/node_modules/@quereus/isolation/dist/src/index.js',
    // @react-native-async-storage/async-storage — native module that cannot load under Jest's
    // Node environment. Map to the provided jest mock so compliance-strand.spec.ts can import
    // @votetorrent/vote-engine/rn (which exports LocalStorageReact that imports AsyncStorage).
    '^@react-native-async-storage/async-storage$': '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    // multiformats — ESM-only subpath imports used by @optimystic/quereus-plugin-crypto.
    // The exports field has no "require" condition; map subpaths to their physical dist files.
    '^multiformats/cid$': '<rootDir>/node_modules/multiformats/dist/src/cid.js',
    '^multiformats/bases/base16$': '<rootDir>/node_modules/multiformats/dist/src/bases/base16.js',
    '^multiformats/bases/base32$': '<rootDir>/node_modules/multiformats/dist/src/bases/base32.js',
    '^multiformats/bases/base58$': '<rootDir>/node_modules/multiformats/dist/src/bases/base58.js',
    '^multiformats/bases/base64$': '<rootDir>/node_modules/multiformats/dist/src/bases/base64.js',
    '^multiformats/hashes/digest$': '<rootDir>/node_modules/multiformats/dist/src/hashes/digest.js',
    // Strip .js extension from relative imports inside vote-engine TypeScript source files.
    // TypeScript ESM projects use .js extensions in imports (e.g. '../../src/utils.js')
    // but the actual files are .ts. This mapper allows Jest to find them via moduleFileExtensions.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
