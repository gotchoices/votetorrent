/**
 * Jest manual mock for react-native-nitro-modules (Phase 64 plan 64-01, D-05).
 *
 * The Nitro runtime is native-only (JSI HybridObjects) and cannot load under jest;
 * `transformIgnorePatterns` does not transform it. Any code path that reaches a HybridObject
 * under jest throws loudly instead of silently succeeding. Production uses the real module.
 * Never calls console.*.
 */
const UNAVAILABLE = 'react-native-nitro-modules is native-only and unavailable under jest';

module.exports = {
  __esModule: true,
  NitroModules: {
    createHybridObject() {
      throw new Error(UNAVAILABLE);
    },
    hasHybridObject() {
      return false;
    },
    getHybridObjectConstructor() {
      throw new Error(UNAVAILABLE);
    },
  },
};
