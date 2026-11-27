module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Metro's experimentalImportSupport ESM→CJS pass (enabled transitively via
  // unstable_enablePackageExports in metro.config.js) throws "Export namespace should
  // be first transformed by @babel/plugin-transform-export-namespace-from" on the real
  // engine's transitive deps that use `export * as ns from './x.js'` (e.g. the nested
  // packages/vote-engine/node_modules/@peculiar/utils/build/esm/encoding/index.js) —
  // a release-bundle build failure that the jest suite never exercises (own transform).
  // Listing the plugin explicitly guarantees it runs before Metro's import-export
  // transform. Mirrors apps/VoteTorrentVoter/babel.config.js.
  plugins: [
    '@babel/plugin-transform-export-namespace-from',
    // @optimystic/db-p2p 0.27.0 ships a static class block (`static { ... }`) in
    // dist/src/storage/block-latch.js. @react-native/babel-preset does not enable the
    // transform for it, so the RELEASE bundle build dies with "Static class blocks are
    // not enabled" — `yarn build` -> :app:createBundleReleaseJsAndAssets FAILED. Nothing
    // in the jest suite bundles node_modules, so no test sees this. Listed explicitly for
    // the same reason as the export-namespace plugin above.
    '@babel/plugin-transform-class-static-block',
  ],
};
