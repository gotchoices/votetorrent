/**
 * native-crypto.js — native SHA-256/512 and Ed25519 for the sereus/Optimystic stack, through
 * react-native-quick-crypto. index.js imports it right after polyfills.bootstrap.js.
 *
 * The reference is sereus-health's `apps/mobile/src/polyfills/native-crypto.js` (sereus-chat's
 * fix, adopted there before its cadre-node testing). Optimystic hashes every block it stores or
 * compares (`canonicalBlockHash`) and verifies signatures on its reads, so on Hermes, with no
 * JIT, both dominated the JS thread: 47% of all JS time in sereus-chat's device profile, the
 * thread blocked up to 43 s, a two-phone exchange taking minutes instead of about a second.
 * VoteTorrent's own 2026-10-02 profile found the same pair (noble sha256 at 29 ms per 24 KB
 * block). A blocked thread also outlasts the relay reservation and the strand first-sync
 * budgets a phone depends on, which is the P2P-11 failure shape.
 *
 * Two hooks, each replacing only what polyfills.bootstrap.js put there:
 *   1. `crypto.subtle.digest` via `@serfab/cadre-rn/native-digest`. Metro serves multiformats'
 *      BROWSER sha2, so this is the digest behind Optimystic's block hashes, p2p-fret's ring
 *      and libp2p peer ids. The kit replaces only a digest carrying its tag; the bootstrap's
 *      carried none, so `@serfab/cadre-rn/noise-crypto`'s own call to it was a no-op and every
 *      block hash stayed in JavaScript.
 *   2. Ed25519 in `crypto.subtle` via polyfills/native-ed25519.js. Must run before
 *      `@libp2p/crypto` evaluates: it probes WebCrypto Ed25519 once, at module load.
 *
 * Each hook checks the native code against a known answer first and keeps the JavaScript
 * implementation if it fails. The one-line summary below is the on-device proof of which
 * path is live (logcat `ReactNativeJS`, tag `[native-crypto]`). polyfills/node-crypto.js stays
 * pure JS: only the attestation verifiers reach it.
 *
 * BYTE-IDENTICAL in both apps, as is polyfills/native-ed25519.js; the Authority's
 * polyfills/__tests__/native-crypto.test.js guards that. The Voter took both on 2026-10-29: its
 * iPhone profile spent about 18% of JS time in noble's pure-JS Ed25519 `verify`, reached from
 * Optimystic's commit-proof `countApprovals` through `@libp2p/crypto`'s `publicKey.verify`.
 */
import { createHash, subtle as nativeSubtle } from 'react-native-quick-crypto';
import { installNativeDigest } from '@serfab/cadre-rn/native-digest';
import { installNativeEd25519 } from './native-ed25519';

const digest = installNativeDigest(name => createHash(name));
const ed25519 = installNativeEd25519(nativeSubtle);

ed25519.ready.then(native => {
	console.log(`[native-crypto] subtle.digest=${digest} ed25519=${ed25519.status}:${native ? 'native' : 'js'}`);
});
