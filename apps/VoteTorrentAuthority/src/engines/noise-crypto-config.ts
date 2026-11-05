/**
 * Native crypto for libp2p-noise — the one switch every CadreNode in this app reads.
 *
 * Metro resolves `@chainsafe/libp2p-noise`'s BROWSER build, whose crypto is pure JavaScript.
 * On Hermes, which has no JIT, that is 11x-198x slower than native per primitive, as measured
 * by sereus-chat on a desktop-class emulator. A bring-up pushes thousands of Noise frames, so
 * the JS thread saturates. That is the starvation spikes 071/072 measured as multi-second
 * thread blocks during P2P-11 bring-up (worst 14.7 s).
 *
 * `@serfab/cadre-rn/noise-crypto` ports noise's own Node implementation onto
 * `react-native-quick-crypto` (C++/JSI). It is the sereus kit's module and the one sereus-chat
 * runs, adopted rather than copied (spike 093). cadre-core forwards `network.noiseCrypto` to the
 * control node AND every strand node.
 *
 *   off        stock pure JS: the state before spike 093. Kept so the old behaviour can be
 *              reproduced without reinstalling anything.
 *   symmetric  native sha256 + chacha20-poly1305, the PER-FRAME costs. The upstream default.
 *   full       adds x25519, which is paid per handshake rather than per frame.
 *
 * A mismatch between peers is safe. Each side's crypto only has to be correct, not the same.
 */
import {
  buildNoiseCrypto,
  DEFAULT_NOISE_CRYPTO_MODE,
  type NoiseCryptoMode,
} from '@serfab/cadre-rn/noise-crypto';

export type { NoiseCryptoMode };

/** Read at node CONSTRUCTION; changing it means rebuilding the node. */
export const NOISE_CRYPTO_MODE: NoiseCryptoMode = DEFAULT_NOISE_CRYPTO_MODE;

/** The `network.noiseCrypto` value for a CadreNode; `undefined` (stock) when the mode is 'off'. */
export function noiseCryptoForNode(mode: NoiseCryptoMode = NOISE_CRYPTO_MODE) {
  return buildNoiseCrypto(mode);
}
