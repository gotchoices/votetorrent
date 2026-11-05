/**
 * founding-bundle-row-parity.spec.ts — 62-128 (PD-05, D-35, D-39).
 *
 * Device evidence (62-82 M1 / HUMAN-UAT 14) showed the network id + hash equal on
 * two devices; the rows themselves were never compared. This spec closes that
 * half host-side: the six genesis tables are read back with `select *` on the
 * exporter and on the importer, and the row arrays must be deep-equal, every
 * column, as returned (no normalisation).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import type { LocalStorage, Signature } from '@votetorrent/vote-core'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { createTestNetwork, makeTestSignCallback } from './fixtures/test-context.js'

function makeDeviceLocalStorage (): LocalStorage {
  const store = new Map<string, unknown>()
  return {
    async getItem<TValue> (key: string): Promise<TValue | undefined> {
      return store.has(key) ? (store.get(key) as TValue) : undefined
    },
    async setItem<TValue> (key: string, value: TValue): Promise<void> {
      store.set(key, value)
    },
    async removeItem (key: string): Promise<void> {
      store.delete(key)
    },
    async clear (): Promise<void> {
      store.clear()
    }
  }
}

const TABLES: ReadonlyArray<{ table: string; pk: string }> = [
  { table: 'Admin', pk: 'AuthorityId, EffectiveAt' },
  { table: 'Authority', pk: 'Id' },
  { table: 'Network', pk: 'Id' },
  { table: 'Officer', pk: 'AuthorityId, AdminEffectiveAt, UserId' },
  { table: 'User', pk: 'Id' },
  { table: 'UserKey', pk: 'UserId, PubKey' }
]

async function readAll (db: Database, table: string, pk: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const row of db.eval(`select * from ${table} order by ${pk}`)) {
    out.push(row as Record<string, unknown>)
  }
  return out
}

describe('founding rows read back byte-identical after import (PD-05)', () => {
  it('B1: Admin, Authority, Network, Officer, User and UserKey are deep-equal on exporter and importer', async function () {
    this.timeout(30_000)
    const net = await createTestNetwork()
    const exporter = {
      userId: net.user.id,
      signerKey: net.user.activeKeys[0]!.key,
      sign: makeTestSignCallback(net.user)
    }
    const { text, bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

    const engineB = new NetworksEngine(makeDeviceLocalStorage())
    const result = await engineB.importFoundingBundle(text, undefined, { expectedDigest: bundle.digest })
    expect(result.ok, 'import must succeed').to.equal(true)

    const ctxB = engineB.getEstablishedContext(bundle.descriptor.networkHash)
    if (!ctxB) throw new Error('B1: device B context not established')

    for (const { table, pk } of TABLES) {
      const rowsA = await readAll(net.ctx.db, table, pk)
      const rowsB = await readAll(ctxB.db, table, pk)
      expect(rowsA.length, `${table}: exporter has rows`).to.be.greaterThan(0)
      expect(rowsB, `${table} rows`).to.deep.equal(rowsA)
    }

    const netB = await readAll(ctxB.db, 'Network', 'Id')
    expect(netB[0]!.Id).to.equal(bundle.descriptor.networkId)
    expect(netB[0]!.Hash).to.equal(bundle.descriptor.networkHash)
  })

  it('B2 (negative control): a bundle with one changed row value is refused, so B1 is not vacuous', async function () {
    this.timeout(30_000)
    const net = await createTestNetwork()
    const exporter = {
      userId: net.user.id,
      signerKey: net.user.activeKeys[0]!.key,
      sign: makeTestSignCallback(net.user) as (digest: Uint8Array) => Promise<Signature>
    }
    const { text, bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

    const tampered = JSON.parse(text)
    tampered.rows.User[0].Name = `${String(tampered.rows.User[0].Name)}x`
    const engineB = new NetworksEngine(makeDeviceLocalStorage())
    const result = await engineB.importFoundingBundle(JSON.stringify(tampered), undefined, { expectedDigest: bundle.digest })
    expect(result.ok, 'tampered import must be refused').to.equal(false)
    if (!result.ok) {
      // refused for the tamper itself, not for a missing anchor or a prior join
      expect(result.reason).to.not.equal('anchor-required')
      expect(result.reason).to.equal('digest-mismatch')
    }
  })
})
