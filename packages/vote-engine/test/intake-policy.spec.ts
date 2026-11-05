/**
 * intake-policy.spec.ts — Phase 62 Plan 14 Task 2 (D-29, D-46)
 *
 * The intake policy reader/writer over `src/intake/policy.ts` and
 * `IntakeEngine.readIntakePolicy`/`setIntakePolicy`.
 */

import { expect } from 'chai'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { IntakeError, REST_BRIDGE_URL_MAX_LENGTH } from '../src/intake/types.js'
import { intakeQueryPortFromDb } from '../src/intake/query-port.js'
import { isValidRestBridgeUrl, normalizeIntakePolicyRow, reassociationRouteFor, readIntakePolicyFrom } from '../src/intake/policy.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

async function countRows (fx: ThresholdAuthorityFixture, table: 'AdminSigning' | 'OfficerSignature'): Promise<number> {
  const row = await fx.elec.ctx.db.prepare(`select count(*) as c from ${table}`).get({})
  return Number(row!.c)
}

describe('src/intake/policy.ts — AuthorityIntakePolicy reader/writer (D-29, D-46)', () => {
  describe('default (D-46)', () => {
    it('with no row, readIntakePolicy and readIntakePolicyFrom both report the default', async () => {
      const fx = await createThresholdAuthority({
        holderCount: 1,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
      const expected = {
        authorityId: fx.authorityId,
        revision: 0,
        restBridgeUrl: null,
        reassociationMode: 'manual' as const,
        setAt: null,
        isDefault: true
      }
      const viaEngine = await new IntakeEngine({ db: fx.elec.ctx.db }).readIntakePolicy(fx.authorityId)
      expect(viaEngine).to.deep.equal(expected)
      const viaPort = await readIntakePolicyFrom(intakeQueryPortFromDb(fx.elec.ctx.db), fx.authorityId)
      expect(viaPort).to.deep.equal(expected)
    })
  })

  describe('setIntakePolicy writes (D-29)', () => {
    let fx: ThresholdAuthorityFixture

    beforeEach(async () => {
      fx = await createThresholdAuthority({
        holderCount: 3,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }, { policy: 'vrg', threshold: 1 }]
      })
    })

    it('a vrg holder sets an https URL: revision 1, mode stays manual, readback from a second holder and through the port match', async () => {
      const engine0 = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
      const view = await engine0.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example/intake' }, fx.holders[0]!.sign)
      expect(view.revision).to.equal(1)
      expect(view.restBridgeUrl).to.equal('https://bridge.example/intake')
      expect(view.reassociationMode).to.equal('manual')
      expect(view.isDefault).to.equal(false)

      const engine1 = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[1]!.user })
      expect(await engine1.readIntakePolicy(fx.authorityId)).to.deep.equal(view)
      expect(await readIntakePolicyFrom(intakeQueryPortFromDb(fx.elec.ctx.db), fx.authorityId)).to.deep.equal(view)

      const second = await engine0.setIntakePolicy({ authorityId: fx.authorityId, reassociationMode: 'automatic' }, fx.holders[0]!.sign)
      expect(second.revision).to.equal(2)
      expect(second.restBridgeUrl).to.equal('https://bridge.example/intake')
      expect(second.reassociationMode).to.equal('automatic')

      const third = await engine0.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: null }, fx.holders[0]!.sign)
      expect(third.revision).to.equal(3)
      expect(third.restBridgeUrl).to.equal(null)
      expect(third.reassociationMode).to.equal('automatic')
    })

    it('no-op: writing values identical to the current non-default revision returns it unchanged and adds no AdminSigning row', async () => {
      const engine0 = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
      const first = await engine0.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example/intake', reassociationMode: 'manual' }, fx.holders[0]!.sign)
      const before = await countRows(fx, 'AdminSigning')
      const repeat = await engine0.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example/intake', reassociationMode: 'manual' }, fx.holders[0]!.sign)
      const after = await countRows(fx, 'AdminSigning')
      expect(repeat).to.deep.equal(first)
      expect(after).to.equal(before)
    })

    describe('refusals — zero new AdminSigning/OfficerSignature rows', () => {
      async function expectRefusal (
        fxLocal: ThresholdAuthorityFixture,
        input: Parameters<IntakeEngine['setIntakePolicy']>[0],
        sign: Parameters<IntakeEngine['setIntakePolicy']>[1],
        expectedCode: string,
        userForEngine = fxLocal.holders[0]!.user
      ): Promise<void> {
        const beforeAS = await countRows(fxLocal, 'AdminSigning')
        const beforeOS = await countRows(fxLocal, 'OfficerSignature')
        let caught: unknown
        try {
          await new IntakeEngine({ db: fxLocal.elec.ctx.db, user: userForEngine }).setIntakePolicy(input, sign)
        } catch (err) {
          caught = err
        }
        expect(caught, `expected a throw for ${JSON.stringify(input)}`).to.be.instanceOf(IntakeError)
        expect((caught as IntakeError).code).to.equal(expectedCode)
        expect(await countRows(fxLocal, 'AdminSigning')).to.equal(beforeAS)
        expect(await countRows(fxLocal, 'OfficerSignature')).to.equal(beforeOS)
      }

      it('http:// (non-https) gives invalid-policy', async () => {
        await expectRefusal(fx, { authorityId: fx.authorityId, restBridgeUrl: 'http://bridge.example' }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it('a URL with userinfo (user:pw@) gives invalid-policy', async () => {
        await expectRefusal(fx, { authorityId: fx.authorityId, restBridgeUrl: 'https://user:pw@bridge.example' }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it('a 2049-character https URL gives invalid-policy', async () => {
        const longUrl = `https://bridge.example/${'a'.repeat(REST_BRIDGE_URL_MAX_LENGTH)}`
        expect(longUrl.length).to.be.greaterThan(REST_BRIDGE_URL_MAX_LENGTH)
        await expectRefusal(fx, { authorityId: fx.authorityId, restBridgeUrl: longUrl }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it('a URL containing a space gives invalid-policy', async () => {
        await expectRefusal(fx, { authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example/a b' }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it("mode 'auto' (not in the vocabulary) gives invalid-policy", async () => {
        await expectRefusal(fx, { authorityId: fx.authorityId, reassociationMode: 'auto' as never }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it('an input with neither field gives invalid-policy', async () => {
        await expectRefusal(fx, { authorityId: fx.authorityId }, fx.holders[0]!.sign, 'invalid-policy')
      })

      it('the nonHolder (current officer, mel only) gives not-authorized', async () => {
        await expectRefusal(
          fx,
          { authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' },
          fx.nonHolder.sign,
          'not-authorized',
          fx.nonHolder.user
        )
      })

      it('the outsider gives not-authorized', async () => {
        await expectRefusal(
          fx,
          { authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' },
          async (digest) => ({ signature: 'a'.repeat(128), signerKey: 'invalid', signerUserId: fx.outsider.id }),
          'not-authorized',
          fx.outsider
        )
      })

      it('a stale expectedRevision gives policy-revision-conflict', async () => {
        const engine0 = new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
        await engine0.setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' }, fx.holders[0]!.sign)
        await expectRefusal(
          fx,
          { authorityId: fx.authorityId, reassociationMode: 'automatic', expectedRevision: 0 },
          fx.holders[0]!.sign,
          'policy-revision-conflict'
        )
      })

      it('a fixture at the default vrg threshold (2) gives threshold-requires-co-sign', async () => {
        const thresholdFx = await createThresholdAuthority()
        await expectRefusal(
          thresholdFx,
          { authorityId: thresholdFx.authorityId, restBridgeUrl: 'https://bridge.example' },
          thresholdFx.holders[0]!.sign,
          'threshold-requires-co-sign'
        )
      })
    })

    it('tier 1 still holds without the engine: a raw insert with no ceremony context throws', async () => {
      let caught: unknown
      try {
        await fx.elec.ctx.db.exec(
          `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
           values (:authorityId, 1, :url, 'manual', :setAt)`,
          { authorityId: fx.authorityId, url: 'https://bridge.example', setAt: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(Error)
    })
  })

  describe('isValidRestBridgeUrl', () => {
    it('accepts a plain https URL and rejects http/userinfo/overlong/whitespace', () => {
      expect(isValidRestBridgeUrl('https://bridge.example/intake')).to.equal(true)
      expect(isValidRestBridgeUrl('http://bridge.example')).to.equal(false)
      expect(isValidRestBridgeUrl('https://user:pw@bridge.example')).to.equal(false)
      expect(isValidRestBridgeUrl(`https://bridge.example/${'a'.repeat(REST_BRIDGE_URL_MAX_LENGTH)}`)).to.equal(false)
      expect(isValidRestBridgeUrl('https://bridge.example/a b')).to.equal(false)
      expect(isValidRestBridgeUrl(null)).to.equal(false)
      expect(isValidRestBridgeUrl(42)).to.equal(false)
    })
  })

  describe('isValidRestBridgeUrl — private and local hosts (initial/G1 IN-03)', () => {
    const REFUSED = [
      'https://127.0.0.1/x', 'https://127.1/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://0177.0.0.1/x',
      'https://localhost/x', 'https://localhost./x', 'https://foo.localhost', 'https://printer.local/x', 'https://nas.lan/x',
      'https://svc.internal/x', 'https://router.home.arpa/x', 'https://bridge/x', 'https://bridge./x',
      'https://10.1.2.3', 'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.2', 'https://169.254.169.254/x',
      'https://100.64.0.1', 'https://0.0.0.0', 'https://192.0.0.8', 'https://192.0.2.1', 'https://198.51.100.7',
      'https://203.0.113.9', 'https://198.18.0.1', 'https://198.19.255.255', 'https://224.0.0.1', 'https://240.0.0.1',
      'https://255.255.255.255'
    ]
    const ACCEPTED = [
      'https://bridge.example.org/x', 'https://bridge.example.org./x', 'https://8.8.8.8/x', 'https://172.15.0.1',
      'https://172.32.0.1', 'https://100.63.255.255', 'https://100.128.0.1', 'https://192.0.3.1', 'https://192.0.1.1',
      'https://198.17.255.255', 'https://198.20.0.1', 'https://198.51.101.1', 'https://203.0.114.1',
      'https://example.com:8443/path', 'https://bridge.example', 'https://lan.example.org'
    ]
    for (const url of REFUSED) {
      it(`refuses ${url}`, () => { expect(isValidRestBridgeUrl(url)).to.equal(false) })
    }
    for (const url of ACCEPTED) {
      it(`accepts ${url}`, () => { expect(isValidRestBridgeUrl(url)).to.equal(true) })
    }

    it('a stored row whose bridge URL is now refused reads without throwing and offers no REST bridge', () => {
      const view = normalizeIntakePolicyRow('auth-z', { Revision: 2, RestBridgeUrl: 'https://192.168.1.2/x', ReassociationMode: 'automatic', SetAt: '2026-01-01T00:00:00.000Z' })
      expect(view.restBridgeUrl).to.equal(null)
      expect(view.revision).to.equal(2)
      expect(view.reassociationMode).to.equal('automatic')
    })
  })

  describe('normalizeIntakePolicyRow — defensive reader', () => {
    it('a forged row with an invalid URL and mode falls back field by field', () => {
      const view = normalizeIntakePolicyRow('auth-x', { Revision: 4, RestBridgeUrl: 'http://x', ReassociationMode: 'weird', SetAt: 'x' })
      expect(view.revision).to.equal(4)
      expect(view.restBridgeUrl).to.equal(null)
      expect(view.reassociationMode).to.equal('manual')
      expect(view.setAt).to.equal('x')
      expect(view.isDefault).to.equal(false)
    })

    it('undefined returns the default view', () => {
      expect(normalizeIntakePolicyRow('auth-y', undefined)).to.deep.equal({
        authorityId: 'auth-y',
        revision: 0,
        restBridgeUrl: null,
        reassociationMode: 'manual',
        setAt: null,
        isDefault: true
      })
    })
  })

  describe('reassociationRouteFor — D-46 routing table', () => {
    it('manual/code -> manual, manual/identity -> manual, automatic/code -> automatic, automatic/identity -> manual', () => {
      expect(reassociationRouteFor({ reassociationMode: 'manual' }, 'code')).to.equal('manual')
      expect(reassociationRouteFor({ reassociationMode: 'manual' }, 'identity')).to.equal('manual')
      expect(reassociationRouteFor({ reassociationMode: 'automatic' }, 'code')).to.equal('automatic')
      expect(reassociationRouteFor({ reassociationMode: 'automatic' }, 'identity')).to.equal('manual')
    })
  })
})
