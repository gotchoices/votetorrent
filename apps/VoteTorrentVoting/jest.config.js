module.exports = {
  preset: 'react-native',
  // @react-navigation/* ships ESM-only (package.json "main" points at lib/module/index.js,
  // no commonjs build) and react-native-vector-icons' per-family entry files (e.g.
  // FontAwesome6.js) are also plain ESM source — Babel must transform both like first-party
  // RN source. Needed for the App.test.tsx full-tree smoke test (39-09) which now mounts
  // NavigationContainer/RootNavigator (which imports react-native-vector-icons/FontAwesome6).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-vector-icons)/)',
  ],
  moduleNameMapper: {
    '^react-native-localize$': '<rootDir>/__mocks__/react-native-localize.js',
    '^@react-native-async-storage/async-storage$': '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
  },
};
