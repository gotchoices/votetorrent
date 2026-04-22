import type { NetworkInit, NetworkReference } from '../network/models'
import type { INetworkEngine } from '../network/types'
import type { User } from '../user/models'

export interface INetworksEngine {
  clearRecentNetworks(): Promise<void>
  create(networkInit: NetworkInit, user: User): Promise<INetworkEngine>
  getRecentNetworks(): Promise<NetworkReference[]>
  open(
    ref: NetworkReference,
    user: User | undefined,
    storeAsRecent?: boolean
  ): Promise<INetworkEngine>
}
