// uint8arrays v6 (ESM, dist/src layout) is mapped by physical path below. WHICH workspace
// holds a nested v6 copy is a node-modules-linker layout artefact that moves on any install
// (2026-10-01: a vote-engine devDependency add re-nested 3.1.1 — cjs/ layout, no dist/ —
// under packages/vote-engine and broke 21 suites), so locate the first v6 copy at load time.
const path = require('path');
const fs = require('fs');
const UINT8ARRAYS_DIST = (() => {
  const candidates = [
    'packages/vote-engine',
    'packages/web-data',
    'packages/attestation-native',
    'apps/VoteTorrentDashboard',
    '.',
  ].map(d => path.resolve(__dirname, '../..', d, 'node_modules/uint8arrays/dist/src'));
  const found = candidates.find(d => fs.existsSync(path.join(d, 'index.js')));
  if (!found) {
    throw new Error('jest.config: no uint8arrays v6 (dist/src) copy found in ' + candidates.join(', '));
  }
  return found;
})();

module.exports = {
  preset: '@react-native/jest-preset',
  // 2026-08-29 (Phase 51 Nyquist audit). Jest's implicit per-test budget is 5000ms, which this
  // app's render-heavy screen/navigation suites cannot hold on a COLD cache: a clean
  // `yarn jest --clearCache && yarn jest` runs ~98 suites whose Babel transforms all miss at
  // once, and whichever suite loses the worker-scheduler lottery blows the default and fails.
  // Measured repeatedly this session: suites that time out in the full cold run pass solo, still
  // cold, with large margin (ProvisionSigningKeyScreen 4.134s total / 2285ms for its slowest
  // test; the navigation suites ~23s each). So this is parallel-worker CPU contention, NOT a
  // hang and NOT a perf regression -- isolated cold times are stable and fast.
  //
  // Patching files one at a time was whack-a-mole: budgeting the five known offenders simply
  // moved the failure onto the next-unluckiest suite (ProvisionSigningKeyScreen, then
  // RegistrationRequestApprovalScreen), because the defect is the global default, not any one
  // file. This sets a contention-tolerant floor for every suite. Files needing more than this
  // (the four navigation suites, at 60_000) still override locally and document their own
  // measurement.
  testTimeout: 30_000,
  // cadre-core-node.smoke.spec.ts (STR-02 D-12/D-13) is a dedicated
  // Node-environment test that imports the REAL @serfab/cadre-core with no
  // virtual mock — it must run ONLY under jest.node.config.js (testEnvironment
  // 'node', no RN preset). Excluded here so the RN preset's default resolver
  // (which has no mapper/mock for a real @serfab/cadre-core load) doesn't pick
  // it up and fail with a spurious "Cannot find module" (D-13 isolation).
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/src/engines/__tests__/cadre-core-node.smoke.spec.ts',
    // Guards jest.node.config.js's own ESM mappers; runs only under that config.
    '<rootDir>/src/engines/__tests__/node-config-esm-mappers.spec.ts',
    // Phase 64: Node-only specs with REAL cadre-core, written by 64-04 and 64-07 and registered in
    // jest.node.config.js by 64-07. They must not run under the RN preset.
    '<rootDir>/src/engines/__tests__/join-code-prefix.spec.ts',
    '<rootDir>/src/engines/__tests__/owner-trust-store.spec.ts',
    // replication-proof-runner.test.ts was excluded here by Phase 39 plan 39-04 because
    // "Phase 41 is PAUSED (P2P-11 open at 41-11)". It stayed excluded for months and rotted:
    // its CadreNode mock lost getMultiaddrs(), so the runner threw at the relay-reservation
    // marker and its own catch-all swallowed the rest of the proof — 4 of 8 tests red, and
    // NO live behavioural coverage of the runner at all. That is how the runner drifted
    // undetected through two cadre-core majors. Repaired and re-enabled 2026-09-03; the
    // exclusion's premise (a paused P2P track) no longer holds.
  ],
  // Allow Babel to transform ESM-only workspace packages and quereus packages
  // so tests can import them without ESM/CJS resolver failures.
  // Includes: @quereus/* (quereus engine), @optimystic/* (plugin), @votetorrent/* (workspace),
  // @noble/* (@optimystic/quereus-plugin-crypto peer), inheritree + moat-maker (quereus deps),
  // multiformats (ESM-only dep of @optimystic/quereus-plugin-crypto),
  // @react-navigation (ESM-only; App.test.tsx imports NavigationContainer from it),
  // jose (ESM-only, no CJS build at all in v6.x — @votetorrent/vote-engine/rn now
  // transitively pulls it in via association/verifiers/play-integrity.ts, Phase 43).
  // uint8arrays (ESM-only dep of @optimystic/quereus-plugin-crypto, first exercised by
  // an app-Jest test in 46-09 — see the moduleNameMapper entry below for detail).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|@quereus|@optimystic|@votetorrent|@noble|inheritree|moat-maker|multiformats|@serfab|jose|uint8arrays)/)',
  ],
  moduleNameMapper: {
    // Phase 49 plan 49-07 (Rule 3 — blocking), mirroring apps/VoteTorrentVoter/jest.config.js's
    // identical, already-documented Phase 45-07 fix: `packages/attestation-native` declares its
    // own `react-native` devDependency, giving it its OWN local `node_modules/react-native`
    // copy — a different module identity than this app's own `react-native` (and than the one
    // a test file's own `jest.mock('react-native', ...)` intercepts). Without this mapper,
    // `packages/attestation-native/src/specs/NativeAttestation.ts`'s
    // `import { TurboModuleRegistry } from 'react-native'` resolves to that PRIVATE copy, so
    // `TurboModuleRegistry.getEnforcing` inside it is the REAL implementation (unmocked) and
    // throws `__fbBatchedBridgeConfig is not set`. Redirecting every `react-native` require to
    // the single app-hoisted copy closes the gap.
    '^react-native$': '<rootDir>/node_modules/react-native/index.js',
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^@optimystic/db-p2p$': '<rootDir>/__mocks__/@optimystic/db-p2p.js',
    // Spike 093: native Noise crypto. The real module needs react-native-quick-crypto (Nitro/JSI),
    // which cannot load under Jest; the mock keeps the mode contract.
    '^@serfab/cadre-rn/noise-crypto$': '<rootDir>/__mocks__/@serfab/cadre-rn-noise-crypto.js',
    // The REAL module (pure JS, no native import): its exports map is import-only, which
    // Jest's CJS resolver cannot follow. polyfills/__tests__/native-crypto.test.js needs the
    // real tag check, not a stand-in.
    '^@serfab/cadre-rn/native-digest$': '<rootDir>/node_modules/@serfab/cadre-rn/dist/native-digest.js',
    // Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — native TurboModules pulled in
    // transitively by App.test.tsx's full navigation tree (every screen module is
    // eagerly required by src/navigation/index.tsx, not lazily).
    '^@react-native-clipboard/clipboard$': '<rootDir>/__mocks__/@react-native-clipboard/clipboard.js',
    // Phase 64 plan 64-01 (D-03, D-04): native bindings (share sheet, cache files, keep-awake) that
    // jest cannot load, and transformIgnorePatterns does not transform them.
    '^react-native-share$': '<rootDir>/__mocks__/react-native-share.js',
    '^@dr.pogodin/react-native-fs$': '<rootDir>/__mocks__/@dr.pogodin/react-native-fs.js',
    '^@sayem314/react-native-keep-awake$': '<rootDir>/__mocks__/@sayem314/react-native-keep-awake.js',
    '^@react-native-community/datetimepicker$': '<rootDir>/__mocks__/@react-native-community/datetimepicker.js',
    '^react-native-vector-icons/FontAwesome$': '<rootDir>/__mocks__/react-native-vector-icons/FontAwesome.js',
    '^@multiformats/multiaddr$': '<rootDir>/__mocks__/@multiformats/multiaddr.js',
    // Allow importing vote-engine test fixtures from the app workspace Jest suite.
    // The package exports field blocks subpath access; this mapper resolves the TS source directly.
    '^@votetorrent/vote-engine/test/fixtures/test-context$':
      '<rootDir>/../../packages/vote-engine/test/fixtures/test-context.ts',
    // Phase 64 (planning notes 4.3): the real-encoder join-code fixtures that plan 64-04 generates.
    // Pure data with no imports.
    '^@votetorrent/vote-engine/test/fixtures/join-code-fixtures$':
      '<rootDir>/../../packages/vote-engine/test/fixtures/join-code-fixtures.generated.ts',
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
    // 50-07 (D-07/D-13): the browser-facing bootstrap barrel. Jest's CJS
    // resolver does not follow the package's "exports" map for this
    // subpath (same class of gap the "./rn" mapper above already works
    // around), so `@votetorrent/vote-engine/bootstrap` must be mapped
    // explicitly to its built entry point.
    '^@votetorrent/vote-engine/bootstrap$':
      '<rootDir>/node_modules/@votetorrent/vote-engine/dist/bootstrap/index.js',
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
    // @quereus/plugin-react-native-leveldb — ESM-only ("import"-only exports map, no
    // "require" condition); App.test.tsx now reaches AppProvider → engine-factory →
    // rn-db-factory.ts, which imports it directly (Phase 39 plan 39-04, unmasked by the
    // @react-navigation transformIgnorePatterns fix).
    '^@quereus/plugin-react-native-leveldb$':
      '<rootDir>/node_modules/@quereus/plugin-react-native-leveldb/dist/src/index.js',
    // @react-native-async-storage/async-storage — native module that cannot load under Jest's
    // Node environment. Map to the provided jest mock so compliance-strand.spec.ts can import
    // @votetorrent/vote-engine/rn (which exports LocalStorageReact that imports AsyncStorage).
    '^@react-native-async-storage/async-storage$': '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    // uint8arrays — ESM-only ("import"/"module-sync" only exports map, no "require"
    // condition) transitive dep of @optimystic/quereus-plugin-crypto (dist/index.js,
    // dist/plugin.js). First exercised by an app-Jest test in 46-09 (RegistrationPolicyScreen.test.tsx),
    // which is the first screen test to require the real MockRegistrationEngine —
    // its selective-disclosure methods import setCommit/setDisclose/randomBytes from
    // quereus-plugin-crypto, which imports { toString, fromString } from 'uint8arrays'.
    '^uint8arrays$': UINT8ARRAYS_DIST + '/index.js',
    // uint8arrays' own dist/src/index.js internally imports its INTERNAL "#foo"
    // self-references (package.json "imports" map) — that map has "types"/"node"/
    // "import" conditions only, no "require", so Jest's default CJS condition set
    // matches none of them ("No known conditions for '#alloc' specifier"). Map each
    // self-reference straight to its physical dist file, same idiom as the
    // @noble/curves / multiformats subpath mappers above.
    '^#util/as-uint8array$': UINT8ARRAYS_DIST + '/util/as-uint8array.js',
    '^#alloc$': UINT8ARRAYS_DIST + '/alloc.js',
    '^#compare$': UINT8ARRAYS_DIST + '/compare.js',
    '^#concat$': UINT8ARRAYS_DIST + '/concat.js',
    '^#from-string$': UINT8ARRAYS_DIST + '/from-string.js',
    '^#to-string$': UINT8ARRAYS_DIST + '/to-string.js',
    // multiformats — ESM-only subpath imports used by @optimystic/quereus-plugin-crypto.
    // The exports field has no "require" condition; map subpaths to their physical dist files.
    '^multiformats/basics$': '<rootDir>/node_modules/multiformats/dist/src/basics.js',
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
