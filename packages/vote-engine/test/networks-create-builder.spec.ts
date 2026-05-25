/**
 * TDD RED — NetworksCreateBuilder behavioral tests.
 * These tests import the not-yet-created builder and will fail until
 * the GREEN phase implements the class.
 */
import { expect } from 'chai'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionType
} from '@votetorrent/vote-core'
import type {
  INetworksEngine,
  INetworkEngine,
  NetworkInit,
  User,
  Scope
} from '@votetorrent/vote-core'
import { NetworksCreateBuilder } from '../src/networks/builders/networks-create-builder.js'

// Stub engine satisfying INetworksEngine minimally
function makeStubNetworksEngine (): INetworksEngine {
  return {
    async clearRecentNetworks () {},
    async create (_init: NetworkInit, _user: User): Promise<INetworkEngine> {
      return {} as INetworkEngine
    },
    async getRecentNetworks () { return [] },
    async open () { return {} as INetworkEngine },
    buildCreate () { return new NetworksCreateBuilder(this) }
  }
}

function makeNetworkInit (): NetworkInit {
  return {
    name: 'Test Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com'
    },
    admin: {
      officers: [{ init: { name: 'Admin', title: 'Chair', scopes: ['rn'] as Scope[] } }],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

function makeUser (): User {
  return {
    id: 'user-1',
    name: 'Test User',
    activeKeys: [{ key: 'abc123', type: 'M' as any, expiration: Date.now() + 86400000 }]
  }
}

describe('NetworksCreateBuilder (TDD RED)', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const engine = makeStubNetworksEngine()
    const builder = new NetworksCreateBuilder(engine)
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields()
    expect(missing.map(m => m.path)).to.include('networkInit')
    expect(missing.map(m => m.path)).to.include('user')
  })

  it('setNetworkInit with valid value clears per-setter errors for networkInit', () => {
    const engine = makeStubNetworksEngine()
    const b1 = new NetworksCreateBuilder(engine)
    const b2 = b1.setNetworkInit(makeNetworkInit())
    // After setting networkInit, missingFields should no longer include 'networkInit'
    expect(b2.missingFields().map(m => m.path)).to.not.include('networkInit')
  })

  it('cross-field: TSA mismatch surfaces cross-field error', () => {
    const engine = makeStubNetworksEngine()
    const ni = makeNetworkInit()
    ni.policies.numberRequiredTSAs = 5 // more than timestampAuthorities.length (1)
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(ni)
      .setUser(makeUser())
    expect(b.isValid()).to.equal(false)
    const crossFieldErrors = b.errors().filter(e => e.kind === 'cross-field')
    expect(crossFieldErrors.length).to.be.greaterThan(0)
    expect(crossFieldErrors.some(e => e.code === 'TSA_MISMATCH')).to.equal(true)
  })

  it('toJSON excludes committed INetworkEngine from envelope', () => {
    const engine = makeStubNetworksEngine()
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeNetworkInit())
      .setUser(makeUser())
    const json = b.toJSON()
    expect(json).to.have.property('kind', 'networks.create')
    expect(json).to.have.property('version', 1)
    expect(json).to.have.property('draft')
    // No engine reference in serialized output
    expect(json).to.not.have.property('engine')
    expect(json).to.not.have.property('output')
  })

  it('round-trip: fromJSON reproduces draft and validation state', () => {
    const engine = makeStubNetworksEngine()
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeNetworkInit())
      .setUser(makeUser())
    const json = b.toJSON()
    const restored = NetworksCreateBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(b.isValid())
    expect(restored.toJSON()).to.deep.equal(json)
  })

  it('double-commit throws BuilderAlreadyCommittedError synchronously', async () => {
    const engine = makeStubNetworksEngine()
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeNetworkInit())
      .setUser(makeUser())
    await b.commit()
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })
})
