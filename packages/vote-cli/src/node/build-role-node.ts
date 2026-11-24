import type { CadreNode } from '@serfab/cadre-core'
import type { Role } from '../ctl/protocol.js'
import type { FileKvStorage } from '../vault/file-kv.js'

export const AUTHORITY_CADRE_STORE_SCOPE = 'votetorrent-cadre-node'
export const VOTER_CADRE_STORE_SCOPE = 'votetorrent-voter-cadre-node'

export type RoleKind = 'authority' | 'voter'

export interface BuildRoleNodeOptions {
  role: Role
  label: string
  partyId: string
  peerDir: string
  relay: { multiaddr: string, peerId: string }
  kv: FileKvStorage
  warn: (...a: unknown[]) => void
  instruments: boolean
  relayReadyMs: number
  bootTimeoutMs: number
}

export type RoleNodeDeps = Record<string, unknown>

export interface BuiltRoleNode {
  node: CadreNode
  peerId: string
  peerId8: string
  kind: RoleKind
  storeScope: string
}

export class BootTimeoutError extends Error {
  readonly code = 'boot-timeout' as const

  constructor() {
    super('boot-timeout')
    this.name = 'BootTimeoutError'
  }
}

export function defaultRoleNodeDeps(): RoleNodeDeps {
  throw new Error('unimplemented')
}

export function createRoleStores(_kind: RoleKind, _kv: FileKvStorage): never {
  throw new Error('unimplemented')
}

export async function buildRoleNode(_opts: BuildRoleNodeOptions, _deps?: RoleNodeDeps): Promise<BuiltRoleNode> {
  throw new Error('unimplemented')
}
