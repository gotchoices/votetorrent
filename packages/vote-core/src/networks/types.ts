import type { NetworkInit, NetworkReference } from '../network/models'
import type { INetworkEngine } from '../network/types'
import type { User } from '../user/models'
import type { IBuilder } from '../common/builder.js'

export interface INetworksEngine {
  clearRecentNetworks(): Promise<void>
  create(networkInit: NetworkInit, user: User): Promise<INetworkEngine>
  getRecentNetworks(): Promise<NetworkReference[]>
  open(
    ref: NetworkReference,
    user: User | undefined,
    storeAsRecent?: boolean
  ): Promise<INetworkEngine>
  buildCreate(): INetworksCreateBuilder
}

export interface INetworksCreateBuilder extends IBuilder<{ networkInit: NetworkInit; user: User }, INetworkEngine> {
  fromPayload(payload: { networkInit: NetworkInit; user: User }): this
}
