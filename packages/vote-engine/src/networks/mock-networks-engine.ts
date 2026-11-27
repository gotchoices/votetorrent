import { MOCK_NETWORKS } from '../mock-data.js'
import { MockNetworkEngine } from '../network/mock-network-engine.js'
import type {
  INetworkEngine,
  INetworksCreateBuilder,
  NetworkInit,
  NetworkReference,
  User,
  INetworksEngine,
  FoundingBundleExporter,
  FoundingBundleExport,
  FoundingBundleImportOptions,
  FoundingBundleImportResult,
  FoundingBundleInspection,
  FoundingAnchor,
  FoundingAnchorFounder,
  JoinFromStrandOptions,
  JoinFromStrandResult,
  NetworkJoinAnchor
} from '@votetorrent/vote-core'
import { NetworksCreateBuilder } from './builders/index.js'

export class MockNetworksEngine implements INetworksEngine {
  protected recentNetworks: NetworkReference[] = []

  constructor () {
    this.recentNetworks = [...MOCK_NETWORKS]
  }

  async clearRecentNetworks (): Promise<void> {
    this.recentNetworks = []
  }

  async create (init: NetworkInit): Promise<INetworkEngine> {
    const networkRef: NetworkReference = {
      ...init,
      hash: '54321',
      primaryAuthorityDomainName: 'new-network.com'
    }
    this.recentNetworks.unshift(networkRef)
    return new MockNetworkEngine(networkRef)
  }

  async discover (
    latitude: number,
    longitude: number
  ): Promise<NetworkReference[]> {
    return [...MOCK_NETWORKS]
  }

  async getRecentNetworks (): Promise<NetworkReference[]> {
    return [...this.recentNetworks]
  }

  async open (
    ref: NetworkReference,
    user: User,
    storeAsRecent?: boolean
  ): Promise<INetworkEngine> {
    const matchingNetwork = this.recentNetworks.find(
      (network) => network.hash === ref.hash
    )
    if (matchingNetwork) {
      this.recentNetworks = this.recentNetworks.filter(
        (n) => n.hash !== ref.hash
      )
      this.recentNetworks.unshift(matchingNetwork)
      return new MockNetworkEngine(matchingNetwork)
    } else {
      const networkRef: NetworkReference = {
        hash: ref.hash,
        imageUrl: ref.imageUrl,
        relays: ref.relays,
        name: 'Newly Opened Network',
        primaryAuthorityDomainName: 'unknown-domain.com'
      }
      if (storeAsRecent) {
        this.recentNetworks.unshift(networkRef)
      }
      return new MockNetworkEngine(networkRef)
    }
  }

  buildCreate (): INetworksCreateBuilder {
    return new NetworksCreateBuilder(this)
  }

  // D-35/62-16: the mock has no founding bundle to produce or consume —
  // exportFoundingBundle rejects (so a dev-mode caller cannot silently think
  // export succeeded), importFoundingBundle resolves a target-open-failed
  // result (never throws, per importFoundingBundle's own never-throw contract).
  async exportFoundingBundle (_networkHash: string, _exporter: FoundingBundleExporter): Promise<FoundingBundleExport> {
    throw new Error('MockNetworksEngine does not produce founding bundles')
  }

  async importFoundingBundle (
    _bundleText: string,
    _user: User | undefined,
    _options?: FoundingBundleImportOptions
  ): Promise<FoundingBundleImportResult> {
    return {
      ok: false,
      reason: 'target-open-failed',
      category: 'error',
      detail: 'MockNetworksEngine does not import founding bundles'
    }
  }

  async inspectFoundingBundle (_bundleText: string): Promise<FoundingBundleInspection> {
    return {
      ok: false,
      reason: 'malformed',
      category: 'invalid-bundle',
      detail: 'MockNetworksEngine does not inspect founding bundles'
    }
  }

  // Spike 100: the mock has no strand to join and no founding rows to anchor.
  async getFoundingAnchor (_networkHash: string, _founder: FoundingAnchorFounder): Promise<FoundingAnchor> {
    throw new Error('MockNetworksEngine does not produce founding anchors')
  }

  // R-C: no replicated rows to derive a join anchor from either.
  async getJoinAnchor (_networkHash: string): Promise<FoundingAnchor> {
    throw new Error('MockNetworksEngine does not produce join anchors')
  }

  async joinFromStrand (
    _anchor: NetworkJoinAnchor,
    _user: User | undefined,
    _options: JoinFromStrandOptions
  ): Promise<JoinFromStrandResult> {
    return { ok: false, reason: 'target-open-failed', retryable: false, detail: 'MockNetworksEngine does not join networks' }
  }
}
