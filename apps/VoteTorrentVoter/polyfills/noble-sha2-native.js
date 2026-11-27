/**
 * noble-sha2-native.js — what `@noble/hashes/sha2.js` resolves to for the app's own code and its
 * dependencies (metro.noble-sha256.js decides who; noble's own modules and this file still get the
 * real one). Exactly noble's exports, with `sha256` swapped for polyfills/native-backends.js's
 * `makeNativeSha256`: one-shot hashing through react-native-quick-crypto, everything else noble.
 *
 * Why at the resolver: the hottest sha256 caller on a phone is
 * `@optimystic/db-p2p/dist/src/cluster/certified-claims.js`, which hashes about 2 KB of JSON per
 * call to build a memo key, imports noble directly, and is published code we do not patch. A
 * resolver redirect reaches it and every other direct importer without touching any of them.
 *
 * The export list is noble 2.x's, pinned by polyfills/__tests__/native-crypto.test.js against
 * the installed module, so a noble upgrade that adds an export fails a test instead of a boot.
 * `globalThis[Symbol.for('votetorrent/noble-sha256')]` records 'native' or 'js' for the
 * `[native-crypto]` boot line.
 *
 * BYTE-IDENTICAL in both apps.
 */
import * as noble from '@noble/hashes/sha2.js';
import { createHash } from 'react-native-quick-crypto';
import { makeNativeSha256 } from './native-backends';

const made = makeNativeSha256(noble.sha256, createHash);
globalThis[Symbol.for('votetorrent/noble-sha256')] = made.status;

export const sha256 = made.sha256;
export const _SHA224 = noble._SHA224;
export const _SHA256 = noble._SHA256;
export const _SHA384 = noble._SHA384;
export const _SHA512 = noble._SHA512;
export const _SHA512_224 = noble._SHA512_224;
export const _SHA512_256 = noble._SHA512_256;
export const sha224 = noble.sha224;
export const sha384 = noble.sha384;
export const sha512 = noble.sha512;
export const sha512_224 = noble.sha512_224;
export const sha512_256 = noble.sha512_256;
