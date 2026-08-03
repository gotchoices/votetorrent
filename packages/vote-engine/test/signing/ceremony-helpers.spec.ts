/**
 * WR-01/WR-04 (42-REVIEW): unit-locks the consolidated signing-ceremony helpers
 * that the three Phase-42 engines (Registration/Association/AuthorityConfig) now
 * share. Before consolidation, `toIsoZDatetime` was copy-pasted and the
 * registration copy DIVERGED — it lost the bare-ISO (no-`Z`) read-back branch,
 * which is exactly WR-01. This spec pins that branch (and the rest of the shared
 * surface) so the single canonical copy can never silently regress.
 */

import { expect } from 'chai'
import type { Signature } from '@votetorrent/vote-core'
import {
  toIsoZDatetime,
  toDeferredCheckDatetime,
  reZuluDatetime,
  resolveSign,
  requireCtx,
  rethrow
} from '../../src/signing/ceremony-helpers.js'
import type { EngineContext } from '../../src/types.js'

describe('ceremony-helpers (WR-01/WR-04 shared surface)', () => {
  describe('toIsoZDatetime', () => {
    it('converts a numeric epoch-ms Timestamp to a Z-suffixed ISO string', () => {
      const ms = Date.UTC(2026, 6, 20, 12, 34, 56)
      expect(toIsoZDatetime(ms)).to.equal('2026-07-20T12:34:56.000Z')
    })

    it('returns an already-Z-suffixed ISO string unchanged', () => {
      expect(toIsoZDatetime('2026-07-20T12:34:56.789Z')).to.equal('2026-07-20T12:34:56.789Z')
    })

    // WR-01: the load-bearing branch the divergent registration copy had lost.
    // A bare (Z-stripped) DB read-back must get `Z` APPENDED directly — never be
    // re-parsed through `new Date(...)`, which reads the bare string as LOCAL
    // time and shifts the instant by the host's UTC offset.
    it('appends Z to a bare (Z-stripped) ISO read-back WITHOUT shifting the instant (WR-01)', () => {
      expect(toIsoZDatetime('2026-07-20T12:34:56')).to.equal('2026-07-20T12:34:56Z')
      expect(toIsoZDatetime('2026-07-20T12:34:56.5')).to.equal('2026-07-20T12:34:56.5Z')
    })

    it('returns a genuinely unparseable string unchanged (last-resort passthrough)', () => {
      expect(toIsoZDatetime('not-a-datetime')).to.equal('not-a-datetime')
    })
  })

  describe('reZuluDatetime', () => {
    it('appends Z to a bare stored value and leaves a Z-suffixed one alone', () => {
      expect(reZuluDatetime('2026-07-20T12:34:56')).to.equal('2026-07-20T12:34:56Z')
      expect(reZuluDatetime('2026-07-20T12:34:56Z')).to.equal('2026-07-20T12:34:56Z')
    })
  })

  describe('toDeferredCheckDatetime', () => {
    it('strips Z and trims trailing fractional zeros to minimal precision', () => {
      // .000 -> whole fractional part dropped; .500 -> .5; integer seconds stay bare.
      expect(toDeferredCheckDatetime('2026-07-20T12:34:56.000Z')).to.equal('2026-07-20T12:34:56')
      expect(toDeferredCheckDatetime('2026-07-20T12:34:56.500Z')).to.equal('2026-07-20T12:34:56.5')
      expect(toDeferredCheckDatetime('2026-07-20T12:34:56Z')).to.equal('2026-07-20T12:34:56')
    })
  })

  describe('resolveSign', () => {
    it('wraps a completed Signature in a callback that returns it', async () => {
      const sig: Signature = { signerUserId: 'u', signerKey: 'k', signature: 's' }
      const cb = resolveSign(sig)
      expect(await cb(new Uint8Array([1, 2, 3]))).to.deep.equal(sig)
    })

    it('passes a callback through unchanged', () => {
      const cb = async (): Promise<Signature> => ({ signerUserId: 'u', signerKey: 'k', signature: 's' })
      expect(resolveSign(cb)).to.equal(cb)
    })
  })

  describe('requireCtx', () => {
    it('throws an engine-labelled error when ctx is undefined', () => {
      expect(() => requireCtx(undefined, 'RegistrationEngine', 'register'))
        .to.throw(/RegistrationEngine\.register: no EngineContext bound/)
    })

    it('does not throw when a ctx is bound', () => {
      const ctx = { db: {} as unknown } as EngineContext
      expect(() => requireCtx(ctx, 'AssociationEngine', 'associate')).to.not.throw()
    })
  })

  describe('rethrow', () => {
    it('re-labels a generic Error with the engine + method', () => {
      expect(() => rethrow(new Error('boom'), 'AuthorityConfigEngine', 'addAuthorityPeer'))
        .to.throw(/AuthorityConfigEngine\.addAuthorityPeer: boom/)
    })

    it('labels a non-Error thrown value', () => {
      expect(() => rethrow('weird', 'RegistrationEngine', 'register'))
        .to.throw(/RegistrationEngine\.register: unknown error: weird/)
    })
  })
})
