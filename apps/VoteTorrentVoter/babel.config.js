module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Metro's experimentalImportSupport ESM→CJS pass (enabled transitively via
  // unstable_enablePackageExports in metro.config.js) throws "Export namespace should
  // be first transformed by @babel/plugin-transform-export-namespace-from" on the real
  // engine's transitive deps that use `export * as ns from './x.js'` (e.g. the nested
  // packages/vote-engine/node_modules/@peculiar/utils/build/esm/encoding/index.js) —
  // a cold-start bundle 500 that the jest suite never exercises (own transform). Listing
  // the plugin explicitly guarantees it runs before Metro's import-export transform.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
