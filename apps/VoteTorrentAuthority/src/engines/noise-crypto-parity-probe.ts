/**
 * Spike 093: on-device parity + cost probe for native Noise crypto. Dev-only; OFF unless
 * `NOISE_PARITY_PROBE_ENABLED` below is flipped for a run. Never commit it enabled.
 *
 * Two questions, both answerable only on Hermes:
 *   1. PARITY. Does `@serfab/cadre-rn/noise-crypto` (react-native-quick-crypto) produce the
 *      SAME bytes as noise's own pure-JS implementation, for every primitive a Noise
 *      handshake and transport use? A silent mismatch would present as handshakes failing
 *      for no visible reason, so this is checked before any device run relies on the switch.
 *      Ciphertexts are also CROSS-decrypted (native decrypts pure, and vice versa).
 *   2. COST. How much JS-thread time does each primitive take, native vs pure JS, on this
 *      runtime? These are the numbers behind spikes 071/072's thread blocks.
 *
 * Logs under [noise-parity]; the final line is `NOISE PARITY: PASS|FAIL`.
 */
import { buildNoiseCrypto } from '@serfab/cadre-rn/noise-crypto';
import { noisePureJsCrypto } from '@optimystic/db-p2p';
import { Uint8ArrayList } from 'uint8arraylist';

export const NOISE_PARITY_PROBE_ENABLED = false;

const L = (...args: unknown[]) => console.log('[noise-parity]', ...args);

type Crypto = typeof noisePureJsCrypto;

function fill(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (seed + i * 31) & 0xff;
  return out;
}

function hex(b: Uint8Array | Uint8ArrayList): string {
  const bytes = b instanceof Uint8Array ? b : b.subarray();
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function timed(iterations: number, fn: () => void): number {
  fn(); // warm-up
  const t0 = Date.now();
  for (let i = 0; i < iterations; i++) fn();
  return (Date.now() - t0) / iterations;
}

export async function runNoiseParityProbe(): Promise<void> {
  if (!(__DEV__ && NOISE_PARITY_PROBE_ENABLED)) return;

  const native = buildNoiseCrypto('full') as Crypto | undefined;
  const pure = noisePureJsCrypto as Crypto;
  if (!native) {
    L('NOISE PARITY: FAIL — buildNoiseCrypto(full) returned undefined');
    return;
  }

  const failures: string[] = [];
  const check = (label: string, a: string, b: string) => {
    const ok = a === b && a.length > 0;
    L(`${ok ? 'OK  ' : 'FAIL'} ${label}`, ok ? `(${a.length / 2}B)` : `native=${a.slice(0, 32)} pure=${b.slice(0, 32)}`);
    if (!ok) failures.push(label);
  };

  try {
    const frame = fill(512, 9);
    const key = fill(32, 3);
    const nonce = fill(12, 5);
    const ad = fill(32, 7);
    // Noise hands the cipher a Uint8ArrayList (a rope of chunks) as well as flat arrays.
    const rope = new Uint8ArrayList(frame.subarray(0, 100), frame.subarray(100, 400), frame.subarray(400));

    // ── PARITY ────────────────────────────────────────────────────────────────────────
    check('sha256(512B flat)', hex(native.hashSHA256(frame)), hex(pure.hashSHA256(frame)));
    check('sha256(512B rope)', hex(native.hashSHA256(rope)), hex(pure.hashSHA256(rope)));
    check('sha256(0B)', hex(native.hashSHA256(new Uint8Array(0))), hex(pure.hashSHA256(new Uint8Array(0))));

    const ctNative = native.chaCha20Poly1305Encrypt(frame, nonce, ad, key);
    const ctPure = pure.chaCha20Poly1305Encrypt(frame, nonce, ad, key);
    check('chacha20poly1305 encrypt(512B flat)', hex(ctNative), hex(ctPure));
    check('chacha20poly1305 encrypt(512B rope)',
      hex(native.chaCha20Poly1305Encrypt(rope, nonce, ad, key)), hex(pure.chaCha20Poly1305Encrypt(rope, nonce, ad, key)));
    check('chacha20poly1305 encrypt(0B)',
      hex(native.chaCha20Poly1305Encrypt(new Uint8Array(0), nonce, ad, key)),
      hex(pure.chaCha20Poly1305Encrypt(new Uint8Array(0), nonce, ad, key)));
    check('decrypt: native opens pure ciphertext', hex(native.chaCha20Poly1305Decrypt(ctPure, nonce, ad, key)), hex(frame));
    check('decrypt: pure opens native ciphertext', hex(pure.chaCha20Poly1305Decrypt(ctNative, nonce, ad, key)), hex(frame));

    // A tampered tag must be REJECTED by the native path, as it is by the pure one.
    const tampered = new Uint8Array(ctPure instanceof Uint8Array ? ctPure : ctPure.subarray());
    tampered[tampered.length - 1] ^= 0x01;
    let nativeRejected = false;
    try { native.chaCha20Poly1305Decrypt(tampered, nonce, ad, key); } catch { nativeRejected = true; }
    check('decrypt: native rejects a tampered tag', String(nativeRejected), 'true');

    const seed = fill(32, 11);
    const kpN = native.generateX25519KeyPairFromSeed(seed);
    const kpP = pure.generateX25519KeyPairFromSeed(seed);
    check('x25519 keypair from seed (public)', hex(kpN.publicKey), hex(kpP.publicKey));
    const peer = pure.generateX25519KeyPair();
    check('x25519 shared secret',
      hex(native.generateX25519SharedKey(kpN.privateKey, peer.publicKey)),
      hex(pure.generateX25519SharedKey(kpP.privateKey, peer.publicKey)));
    // A fresh native keypair must interoperate with a pure one in both directions. This is the
    // `full`-mode-only path (Noise mints an ephemeral keypair per handshake), so its failure is
    // recorded without aborting the probe: `symmetric` never calls it.
    try {
      const fresh = native.generateX25519KeyPair();
      check('x25519 fresh native keypair agrees with pure peer [full only]',
        hex(native.generateX25519SharedKey(fresh.privateKey, peer.publicKey)),
        hex(pure.generateX25519SharedKey(peer.privateKey, fresh.publicKey)));
    } catch (err) {
      // What did quick-crypto actually hand back? Reported so the upstream fix is specific.
      let shape = 'unprobed';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const qc = require('react-native-quick-crypto');
        const kp = qc.generateKeyPairSync('x25519', {
          publicKeyEncoding: { type: 'spki', format: 'der' },
          privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        });
        const describe = (v: unknown) =>
          `${Object.prototype.toString.call(v)}/${(v as object)?.constructor?.name}/u8=${v instanceof Uint8Array}/ab=${v instanceof ArrayBuffer}`;
        shape = `pub=${describe(kp.publicKey)} priv=${describe(kp.privateKey)}`;
      } catch (e2) {
        shape = 'probe threw: ' + (e2 instanceof Error ? e2.message : String(e2));
      }
      L('FAIL x25519 fresh native keypair [full only]:', err instanceof Error ? err.message : String(err), '|', shape);
      failures.push('x25519 fresh keypair [full only]');
    }

    // ── COST (JS-thread ms per op) ──────────────────────────────────────────────────────
    const rows: Array<[string, number, number]> = [
      ['sha256 512B', timed(200, () => native.hashSHA256(frame)), timed(200, () => pure.hashSHA256(frame))],
      ['chacha seal 512B', timed(200, () => native.chaCha20Poly1305Encrypt(frame, nonce, ad, key)),
        timed(200, () => pure.chaCha20Poly1305Encrypt(frame, nonce, ad, key))],
      ['chacha open 512B', timed(200, () => native.chaCha20Poly1305Decrypt(ctPure, nonce, ad, key)),
        timed(200, () => pure.chaCha20Poly1305Decrypt(ctPure, nonce, ad, key))],
      ['x25519 shared', timed(20, () => native.generateX25519SharedKey(kpN.privateKey, peer.publicKey)),
        timed(20, () => pure.generateX25519SharedKey(kpP.privateKey, peer.publicKey))],
    ];
    for (const [label, n, p] of rows) {
      L(`COST ${label.padEnd(18)} native=${n.toFixed(3)}ms pure=${p.toFixed(3)}ms speedup=${(p / Math.max(n, 0.001)).toFixed(1)}x`);
    }
    // A strand bring-up pushes thousands of frames: ~7000 is the figure sereus-chat measured.
    const frames = 7000;
    const perFrameMs = (col: 1 | 2) => rows[0][col] + rows[1][col]; // one hash + one seal per frame
    L(`COST per ${frames} frames: native=${(perFrameMs(1) * frames / 1000).toFixed(2)}s` +
      ` pure=${(perFrameMs(2) * frames / 1000).toFixed(2)}s`);
  } catch (err) {
    failures.push('threw: ' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    L('probe threw', err instanceof Error ? err.stack : String(err));
  }

  // Two verdicts, because the modes differ in what they override: `symmetric` (the default this
  // app runs) is judged only on the checks it depends on; `full` also needs fresh keypairs.
  const symmetricFailures = failures.filter(f => !f.includes('[full only]'));
  L(`NOISE PARITY: symmetric=${symmetricFailures.length === 0 ? 'PASS' : 'FAIL'}` +
    ` full=${failures.length === 0 ? 'PASS' : 'FAIL'}` +
    (failures.length ? ` — ${failures.join(', ')}` : ''));
}
