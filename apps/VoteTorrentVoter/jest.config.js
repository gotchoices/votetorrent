module.exports = {
  preset: 'react-native',
  // @react-navigation/* ships ESM-only (package.json "main" points at lib/module/index.js,
  // no commonjs build) and react-native-vector-icons' per-family entry files (e.g.
  // FontAwesome6.js) are also plain ESM source — Babel must transform both like first-party
  // RN source. Needed for the App.test.tsx full-tree smoke test (39-09) which now mounts
  // NavigationContainer/RootNavigator (which imports react-native-vector-icons/FontAwesome6).
  // Phase 44 plan 44-01 (D-02/D-04): extended with the authority app's engine-stack
  // transform exceptions (@quereus/@optimystic/@votetorrent/@noble/inheritree/moat-maker/
  // multiformats/@serfab/jose) ahead of the engine-factory port landing in a later plan.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-vector-icons|@quereus|@optimystic|@votetorrent|@noble|inheritree|moat-maker|multiformats|@serfab|jose)/)',
  ],
  moduleNameMapper: {
    // Phase 45 plan 45-07 (Rule 3 — blocking): `packages/attestation-native` declares its own
    // `react-native`/`react`/`@react-native/typescript-config` devDependencies (45-05's Rule-3
    // tsc-infra fix), which gives it its OWN local `node_modules/react-native` copy under
    // `nmHoistingLimits: workspaces`. Node/jest module resolution walks UP from the requiring
    // file, so `packages/attestation-native/src/specs/NativeAttestation.ts`'s `import {
    // TurboModuleRegistry } from 'react-native'` resolves to that PRIVATE copy — a different
    // module identity than the app's own `react-native` (and than the one this test file's own
    // `jest.mock('react-native', ...)` intercepts), so `TurboModuleRegistry.getEnforcing` inside
    // the package hits the REAL (unmocked) module and throws `__fbBatchedBridgeConfig is not
    // set`. Redirecting every `react-native` require to the single app-hoisted copy closes the
    // multi-copy binding gap — same class of fix as the @noble/hashes/@quereus entries below.
    '^react-native$': '<rootDir>/node_modules/react-native/index.js',
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^react-native-safe-area-context$': '<rootDir>/__mocks__/react-native-safe-area-context.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    // Phase 44 plan 44-01 — native/ESM engine modules newly added to package.json that lack
    // a Jest-resolvable form. Mirrors apps/VoteTorrentAuthority/jest.config.js (39-04 precedent).
    '^rn-leveldb$': '<rootDir>/__mocks__/rn-leveldb.js',
    // Phase 44 plan 44-07 (D-02/D-04): VoterAppProvider now imports hideSplash from this native
    // TurboModule — mapped globally (not per-test-file) so every test that transitively requires
    // VoterAppProvider.tsx (even indirectly, e.g. via jest.requireActual in a partial mock, or an
    // unrelated screen importing useVoterApp) resolves an inert stub instead of crashing at
    // require-time. See __mocks__/react-native-splash-view.js for the full rationale.
    '^react-native-splash-view$': '<rootDir>/__mocks__/react-native-splash-view.js',
    '^@quereus/plugin-react-native-leveldb$':
      '<rootDir>/node_modules/@quereus/plugin-react-native-leveldb/dist/src/index.js',
    '^@optimystic/db-p2p$': '<rootDir>/__mocks__/@optimystic/db-p2p.js',
    '^@multiformats/multiaddr$': '<rootDir>/__mocks__/@multiformats/multiaddr.js',
    '^@votetorrent/vote-core$':
      '<rootDir>/node_modules/@votetorrent/vote-core/dist/src/index.js',
    '^@votetorrent/vote-engine$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/index.js',
    '^@votetorrent/vote-engine/rn$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/rn-entry.js',
    // Phase 44 plan 44-06 (Rule 3 — blocking-issue fix): the engine barrels above
    // transitively require these ESM-only ("import"-condition-only exports, no
    // "require"/"default" fallback) packages — Jest's default CJS resolver cannot
    // find them without an explicit redirect to their physical dist entry. Mirrors
    // apps/VoteTorrentAuthority/jest.config.js's identical fix (39-04 precedent) —
    // same package versions (root-resolutions-pinned), copied verbatim.
    '^@quereus/quereus$':
      '<rootDir>/node_modules/@quereus/quereus/dist/src/index.js',
    '^@quereus/quereus/(.*)$':
      '<rootDir>/node_modules/@quereus/quereus/dist/src/$1',
    '^@quereus/store$':
      '<rootDir>/node_modules/@quereus/store/dist/src/index.js',
    '^@quereus/isolation$':
      '<rootDir>/node_modules/@quereus/isolation/dist/src/index.js',
    '^@optimystic/quereus-plugin-crypto$':
      '<rootDir>/node_modules/@optimystic/quereus-plugin-crypto/dist/index.js',
    '^@optimystic/quereus-plugin-crypto/plugin$':
      '<rootDir>/node_modules/@optimystic/quereus-plugin-crypto/dist/plugin.js',
    '^inheritree$': '<rootDir>/node_modules/inheritree/dist/index.js',
    '^moat-maker$': '<rootDir>/node_modules/moat-maker/build/index.js',
    '^@noble/curves$': '<rootDir>/node_modules/@noble/curves/index.js',
    '^@noble/curves/(.*)$': '<rootDir>/node_modules/@noble/curves/$1',
    '^@noble/hashes$': '<rootDir>/node_modules/@noble/hashes/index.js',
    '^@noble/hashes/(.*)$': '<rootDir>/node_modules/@noble/hashes/$1',
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    '^multiformats/cid$': '<rootDir>/node_modules/multiformats/dist/src/cid.js',
    '^multiformats/bases/base16$': '<rootDir>/node_modules/multiformats/dist/src/bases/base16.js',
    '^multiformats/bases/base32$': '<rootDir>/node_modules/multiformats/dist/src/bases/base32.js',
    '^multiformats/bases/base58$': '<rootDir>/node_modules/multiformats/dist/src/bases/base58.js',
    '^multiformats/bases/base64$': '<rootDir>/node_modules/multiformats/dist/src/bases/base64.js',
    '^multiformats/hashes/digest$': '<rootDir>/node_modules/multiformats/dist/src/hashes/digest.js',
  },
};
