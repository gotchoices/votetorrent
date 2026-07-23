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
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^react-native-safe-area-context$': '<rootDir>/__mocks__/react-native-safe-area-context.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    // Phase 44 plan 44-01 — native/ESM engine modules newly added to package.json that lack
    // a Jest-resolvable form. Mirrors apps/VoteTorrentAuthority/jest.config.js (39-04 precedent).
    '^rn-leveldb$': '<rootDir>/__mocks__/rn-leveldb.js',
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
  },
};
