/**
 * owner-trust-store.spec.ts - phase 64 plan 07 (D-08). Node-only: run by jest.node.config.js and
 * ignored by the RN config (64-01).
 *
 * It exercises cadre-core 1.15's REAL PersistentTrustedOwnerStore over this app's real
 * AsyncStorageDurableSlot and the jest AsyncStorage mock that the node config maps.
 *
 * WHY THE PACKAGE ROOT IS NARROWED. Under this config the @serfab/cadre-core root cannot load: it
 * dies with "Cannot find module 'p2p-fret'" (the same wall that fails cadre-core-node.smoke.spec.ts).
 * Repairing the root load needs about 33 mappers and is out of scope. The two leaf modules this
 * test needs load standalone, so the mock below serves exactly those, by a relative path. S-9 ties
 * the narrowed module to the root: the package's index.js must still re-export the same class
 * from the same file.
 */
jest.mock('@serfab/cadre-core', () => ({
  ...jest.requireActual('../../../node_modules/@serfab/cadre-core/dist/trusted-owner-store.js'),
  ...jest.requireActual('../../../node_modules/@serfab/cadre-core/dist/strand-network-state.js'),
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PersistentTrustedOwnerStore } from '@serfab/cadre-core'
import { AsyncStorageDurableSlot, openTrustedOwnerStore } from '../rn-durable-slot'

const PARTY = 'votetorrent'
const SCOPE = 'votetorrent-cadre-node'
const SLOT_KEY = '@votetorrent/trustedOwners/votetorrent-cadre-node/votetorrent'

// 43-char base64url strings from fixed filler. Not real keys.
const KEY_A = 'A'.repeat(43)
const KEY_B = 'B'.repeat(43)

describe('Authority trusted-owner store over the AsyncStorage slot', () => {
  beforeEach(async () => {
    await AsyncStorage.clear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('opens empty on a cold AsyncStorage and is the real persistent class', async () => {
    const store = await openTrustedOwnerStore(PARTY, SCOPE)
    expect(store.partyId).toBe(PARTY)
    expect(store.all().size).toBe(0)
    expect(store).toBeInstanceOf(PersistentTrustedOwnerStore)
  })

  it('keeps an operator pin, with its source, after the store is reopened', async () => {
    const first = await openTrustedOwnerStore(PARTY, SCOPE)
    await first.trust(KEY_A, 'operator')
    expect(typeof (await AsyncStorage.getItem(SLOT_KEY))).toBe('string')
    const second = await openTrustedOwnerStore(PARTY, SCOPE)
    expect(second.has(KEY_A)).toBe(true)
    expect(second.sources().get(KEY_A)).toBe('operator')
  })

  it('keeps the first provenance when a genesis pin lands over an operator pin', async () => {
    const first = await openTrustedOwnerStore(PARTY, SCOPE)
    await first.trust(KEY_A, 'operator')
    await first.trust(KEY_A, 'genesis')
    const second = await openTrustedOwnerStore(PARTY, SCOPE)
    expect(second.sources().get(KEY_A)).toBe('operator')
  })

  it('keeps an invite pin after the store is reopened', async () => {
    const first = await openTrustedOwnerStore(PARTY, SCOPE)
    await first.trust(KEY_B, 'invite')
    const second = await openTrustedOwnerStore(PARTY, SCOPE)
    expect(second.has(KEY_B)).toBe(true)
    expect(second.sources().get(KEY_B)).toBe('invite')
  })

  it('rejects when AsyncStorage cannot be read, instead of opening an empty store', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('planted-io'))
    await expect(openTrustedOwnerStore(PARTY, SCOPE)).rejects.toThrow('planted-io')
  })

  it('opens empty, without rejecting, for a foreign-party record and for unparseable text', async () => {
    const owner = await openTrustedOwnerStore(PARTY, SCOPE)
    await owner.trust(KEY_A, 'operator')
    const foreign = await PersistentTrustedOwnerStore.open(new AsyncStorageDurableSlot(SLOT_KEY), 'other')
    expect(foreign.all().size).toBe(0)

    await AsyncStorage.setItem(SLOT_KEY, '{not json')
    const corrupt = await openTrustedOwnerStore(PARTY, SCOPE)
    expect(corrupt.all().size).toBe(0)
  })

  it('does not share a pin between two scopes', async () => {
    const app = await openTrustedOwnerStore(PARTY, SCOPE)
    await app.trust(KEY_A, 'operator')
    const probe = await openTrustedOwnerStore(PARTY, 'votetorrent-cadre-probe-replication')
    expect(probe.has(KEY_A)).toBe(false)
    expect(probe.all().size).toBe(0)
  })

  it('shows the pin in memory at once when the write behind it fails', async () => {
    const store = await openTrustedOwnerStore(PARTY, SCOPE)
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('planted-io'))
    await expect(store.trust(KEY_A, 'operator')).rejects.toThrow('planted-io')
    expect(store.has(KEY_A)).toBe(true)
  })

  it('is the same class the cadre-core package root re-exports', () => {
    const indexJs = fs.readFileSync(
      path.join(__dirname, '../../../node_modules/@serfab/cadre-core/dist/index.js'),
      'utf8',
    )
    expect(indexJs).toContain(
      "export { MemoryTrustedOwnerStore, PersistentTrustedOwnerStore } from './trusted-owner-store.js';",
    )
  })
})
