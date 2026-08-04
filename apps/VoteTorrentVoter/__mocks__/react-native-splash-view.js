/**
 * Jest manual mock for react-native-splash-view (Phase 44-07, D-02/D-04).
 *
 * react-native-splash-view is a native TurboModule binding — its real entry point calls
 * `TurboModuleRegistry.getEnforcing('SplashView')` at MODULE LOAD time (not first call), which
 * throws under Jest's default RN environment (no native module autolinked). Once
 * `VoterAppProvider.tsx` started importing `hideSplash` from this package (Phase 44-07's real
 * composition-root swap), every test that transitively requires that module — even ones that
 * never render `<VoterAppProvider>` (e.g. via `jest.requireActual` in a partial mock, or an
 * unrelated screen that imports `useVoterApp`) — crashed at require-time. Mirrors the
 * `rn-leveldb.js` mock's rationale/convention in this same directory.
 *
 * Production behavior: the real native SplashView binding is used at Metro/RN runtime — this
 * mock is Jest-only.
 */
module.exports = {
	hideSplash: jest.fn(),
};
