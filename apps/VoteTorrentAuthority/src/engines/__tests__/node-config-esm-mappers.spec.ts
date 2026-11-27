/**
 * Guards jest.node.config.js's hand-written moduleNameMapper entries for the
 * ESM-only packages that have no `require` condition (so Jest cannot resolve
 * them without a mapper). The `uint8-varint` and `protons-runtime` mappers once
 * pointed into `@libp2p/crypto/node_modules/`; when hoisting moved both
 * packages to the app level, the stale paths broke every suite under this
 * config with "Could not locate module", and nothing noticed. Importing them
 * directly here fails on a stale mapper, independently of how far the heavier
 * cadre-core smoke gets through its own import chain.
 */
import { decode, encode, encodingLength } from 'uint8-varint';
import { decodeMessage, encodeMessage, message } from 'protons-runtime';

describe('jest.node.config.js ESM mappers', () => {
  it('uint8-varint resolves and round-trips a multi-byte varint', () => {
    const bytes = encode(300);
    expect(encodingLength(300)).toBe(2);
    expect(Array.from(bytes)).toEqual([0xac, 0x02]);
    expect(decode(bytes)).toBe(300);
  });

  it('protons-runtime resolves and exposes its codec entry points', () => {
    expect(typeof encodeMessage).toBe('function');
    expect(typeof decodeMessage).toBe('function');
    expect(typeof message).toBe('function');
  });
});
