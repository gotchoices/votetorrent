/**
 * Jest manual mock for `@serfab/cadre-rn/noise-crypto` (spike 093).
 *
 * The real module imports `react-native-quick-crypto`, a Nitro/JSI native module that
 * cannot load under Jest. This stand-in keeps the module's CONTRACT — the three modes,
 * the `symmetric` default, and `off` meaning `undefined` (stock pure-JS noise) — so a
 * test can assert what a CadreNode was built with. The byte-level parity of the real
 * implementation is proven on-device by the noise-crypto parity probe, not here.
 */
const DEFAULT_NOISE_CRYPTO_MODE = 'symmetric';

function buildNoiseCrypto(mode) {
  if (mode === 'off') return undefined;
  return { __mockNoiseCrypto: mode };
}

module.exports = { DEFAULT_NOISE_CRYPTO_MODE, buildNoiseCrypto };
