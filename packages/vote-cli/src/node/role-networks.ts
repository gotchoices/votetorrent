// The role's NetworksEngine over the shared strand factory and the shared joined-networks store (port
// of node builder `roleNetworksEngine` / `openRoleNetwork`). The authority kind wraps `create` with the
// founding window; the voter kind probes the control connections before the joined check (the Voter
// binding's order, 67-15). `openRoleNetwork` opens a network already in `recentNetworks` and returns
// the established context, on which NetworksEngine.open already ran `registerDbPlugins`.

import type { NetworkReference, User } from '@votetorrent/vote-core'
import type { LocalStorage } from '@votetorrent/vote-core'
import type { DbFactory, EngineContext } from '@votetorrent/vote-engine'
import { NetworksEngine } from '@votetorrent/vote-engine/rn'
import { createStrandDbFactory, wrapCreateWithFounding, type StrandHost } from '@votetorrent/workflows'
import type { BuiltRoleNode } from './build-role-node.js'

export type NetworkOpenErrorCode = 'network-not-open' | 'user-missing'

export class NetworkOpenError extends Error {
  readonly code: NetworkOpenErrorCode

  constructor(code: NetworkOpenErrorCode) {
    super(code)
    this.name = 'NetworkOpenError'
    this.code = code
  }
}

export interface CreateRoleNetworksEngineOptions {
  built: Pick<BuiltRoleNode, 'node' | 'kind' | 'stores'>
  localStorage: LocalStorage
  /** An instrument seam (the rig's hidden-open-failure counter); the factory is wrapped before the engine sees it. */
  wrapDbFactory?: (factory: DbFactory) => DbFactory
}

export function createRoleNetworksEngine(opts: CreateRoleNetworksEngineOptions): NetworksEngine {
  const { built, localStorage } = opts
  let factory = createStrandDbFactory(built.node as unknown as StrandHost, {
    isJoinedNetwork: (hash) => built.stores.joinedNetworks.isJoinedNetwork(hash),
    probeConnectionsBeforeJoinedCheck: built.kind === 'voter'
  })
  if (opts.wrapDbFactory !== undefined) factory = opts.wrapDbFactory(factory)
  const engine = new NetworksEngine(localStorage, factory)
  return built.kind === 'authority' ? wrapCreateWithFounding(engine) : engine
}

/** The slice of NetworksEngine `openRoleNetwork` uses (structural, so a spec can pass a recording fake). */
export interface RoleNetworksEngineLike {
  open(ref: NetworkReference, user: User | undefined): Promise<unknown>
  getEstablishedContext(networkHash: string): EngineContext | undefined
}

export interface OpenRoleNetworkOptions<E extends RoleNetworksEngineLike> {
  engine: E
  localStorage: LocalStorage
  networkHash: string
  user: User | null
}

export interface OpenedRoleNetwork<E> {
  networksEngine: E
  est: EngineContext
  ref: NetworkReference
}

export async function openRoleNetwork<E extends RoleNetworksEngineLike>(opts: OpenRoleNetworkOptions<E>): Promise<OpenedRoleNetwork<E>> {
  const { engine, localStorage, networkHash, user } = opts
  const recents = (await localStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
  const ref = recents.find((r) => r.hash === networkHash)
  if (ref === undefined) throw new NetworkOpenError('network-not-open')
  if (user === null || user === undefined) throw new NetworkOpenError('user-missing')
  await engine.open(ref, user)
  const est = engine.getEstablishedContext(networkHash)
  if (est === undefined) throw new NetworkOpenError('network-not-open')
  return { networksEngine: engine, est, ref }
}
