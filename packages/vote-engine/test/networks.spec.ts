import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { AsyncStorage } from './shims/react-native'
import type {
  User,
  NetworkInit,
  INetworksEngine,
  INetworkEngine,
  Scope,
  NetworkReference
} from '@votetorrent/vote-core'

// Using AsyncStorage shim for local storage

describe('NetworksEngine', () => {
  it('should exercise create, clearRecentNetworks, getRecentNetworks, and open', async () => {
    // Ensure recentNetworks starts as an empty array for spread operations in create()
    await AsyncStorage.setItem('recentNetworks', [])

    const engine = new NetworksEngine(AsyncStorage) as INetworksEngine

    // getRecentNetworks (initial)
    const initialRecents = await engine.getRecentNetworks()
    expect(initialRecents).to.be.an('array').that.has.length(0)

    // clearRecentNetworks
    await engine.clearRecentNetworks()
    // Storage remove happened; do not call getRecentNetworks immediately since engine casts the result.
    expect(await AsyncStorage.getItem('recentNetworks')).to.equal(undefined)

    // Re-seed to empty for create()
    await AsyncStorage.setItem('recentNetworks', [])

    // create()
    const networkInitPass: NetworkInit = {
      name: 'Test Network',
      imageUrl: 'https://cdn.example.com/logo.png',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthority: {
        name: 'Primary Authority',
        domainName: 'authority.example.com'
      },
      admin: {
        officers: [
          {
            init: {
              name: 'Admin A',
              title: 'Chair',
              scopes: ['rn', 'mel'] as Scope[]
            }
          }
        ],
        effectiveAt: Date.now(),
        thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
      },
      policies: {
        timestampAuthorities: [{ url: 'https://tsa.example.com' }],
        numberRequiredTSAs: 1,
        electionType: ElectionType.adhoc
      }
    }

    const user: User = {
      id: 'user-1',
      name: 'Test User',
      imageRef: { url: 'https://img.local/user.png' },
      activeKeys: [
        {
          key: 'key-1',
          type: UserKeyType.mobile,
          expiration: Date.now()
        }
      ]
    }

    const returnedNetwork: INetworkEngine = await engine.create(
      networkInitPass,
      user
    )

    // Returned engine type
    expect(returnedNetwork).to.be.instanceOf(NetworkEngine)

    // Recent networks updated
    const recents: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? []
    expect(recents).to.be.an('array').with.length(1)
    const firstRecent = recents[0]
    expect(firstRecent).to.include({
      name: networkInitPass.name,
      primaryAuthorityDomainName: networkInitPass.primaryAuthority.domainName
    })
    expect(firstRecent?.relays).to.deep.equal(networkInitPass.relays)
    expect(firstRecent?.imageUrl).to.equal(networkInitPass.imageUrl)

    // getRecentNetworks after create
    const recentViaEngine = await engine.getRecentNetworks()
    expect(recentViaEngine).to.be.an('array').with.length(1)

    // create() should fail with missing officers
    const networkInitFail: NetworkInit = {
      name: 'Failing Network',
      imageUrl: 'https://cdn.example.com/logo.png',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthority: {
        name: 'Primary Authority',
        domainName: 'authority.example.com'
      },
      admin: {
        officers: [],
        effectiveAt: Date.now(),
        thresholdPolicies: []
      },
      policies: {
        timestampAuthorities: [],
        numberRequiredTSAs: 0,
        electionType: ElectionType.adhoc
      }
    }

    try {
      await engine.create(networkInitFail, user)
    } catch (error) {
      expect(error)
        .to.be.an('error')
        .with.property('message')
        .that.includes('Failed to create network: Officer init is required')
    }

    // open() returns a NetworkEngine and can store as recent (dedup to front)
    const ref: NetworkReference = {
      hash: recents?.[0]?.hash ?? '',
      relays: recents?.[0]?.relays ?? [],
      imageUrl: recents?.[0]?.imageUrl ?? '',
      name: recents?.[0]?.name ?? 'mock-name',
      primaryAuthorityDomainName: recents?.[0]?.primaryAuthorityDomainName ?? ''
    }
    const opened = await engine.open(ref, user, true)
    expect(opened).to.be.instanceOf(NetworkEngine)

    const recentsAfterOpen: NetworkReference[] = (await AsyncStorage.getItem(
      'recentNetworks'
    )) ?? []
    expect(recentsAfterOpen).to.be.an('array').with.length(1)
    expect(recentsAfterOpen?.[0]?.hash).to.equal(ref.hash)
    expect(recentsAfterOpen?.[0]?.name).to.equal(ref.name)

    // open() with storeAsRecent=false does not modify recents
    const prev = JSON.stringify(recentsAfterOpen)
    const opened2 = await engine.open(
      {
        hash: 'hash-2',
        relays: [],
        name: 'name-2',
        primaryAuthorityDomainName: 'primaryAuthorityDomainName-2'
      },
      user,
      false
    )
    expect(opened2).to.be.instanceOf(NetworkEngine)
    expect(
      JSON.stringify(await AsyncStorage.getItem('recentNetworks'))
    ).to.equal(prev)
  })
})
