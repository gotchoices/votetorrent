/**
 * Aegir configuration for vote-engine
 *
 * This package has React Native as a peer dependency, which should not
 * be bundled by esbuild. We mark it (and related RN packages) as external.
 *
 * Note: Tests that depend on React Native (auth-manager, local-storage-react,
 * secure-storage-react) cannot run in Node.js and are excluded from the test suite.
 * These should be tested in the React Native app environment.
 */

export default {
  build: {
    config: {
      // Exclude React Native and related packages from bundling
      external: [
        'react-native',
        'react',
        '@react-native-async-storage/async-storage',
        'react-native-keychain',
        // Also exclude other peer dependencies that shouldn't be bundled
        '@react-native-*',
        'react-native-*'
      ],
      // Set platform to neutral since this runs in React Native, not Node.js
      platform: 'neutral'
    }
  },
  test: {
    files: [
      // Only run tests that don't depend on React Native (use built versions)
      'dist/test/crypto-utils.spec.js',
      'dist/test/logger.spec.js'
      // Excluded: auth-manager, local-storage-react, secure-storage-react
      // (these require React Native environment)
    ]
  }
}
