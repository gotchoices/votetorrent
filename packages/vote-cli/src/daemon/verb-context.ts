// The VerbContext every verb receives (the daemon's and the in-process builder's are the same object
// shape). Identity, the built node, the relay, the two kv files, the device vault (opened with the
// at-rest key only), the process-wide secret registry, the public User record, lazy network access by
// hash, the posture flags and the daemon lifecycle hooks. Approval-class work goes through
// `ctx.device.vault.withApproval(...)` per call (67-26); nothing here ever holds a user token.

import type { User } from '@votetorrent/vote-core'
import type { LocalStorage } from '@votetorrent/vote-core'
import { join } from 'node:path'
import type { Role } from '../ctl/protocol.js'
import type { SecretRegistry } from '../secrecy/redact.js'
import type { DeviceVault } from '../vault/device-vault.js'
import type { FileKvStorage } from '../vault/file-kv.js'
import { readPrivateFile, writePrivateFileAtomic } from '../vault/private-file.js'
import type { BuiltRoleNode } from '../node/build-role-node.js'
import { PEER_FILES, nodeDir, secretsDir as secretsDirOf } from '../node/peer-layout.js'
import { createRoleNetworksEngine, openRoleNetwork, type OpenedRoleNetwork, type RoleNetworksEngineLike } from '../node/role-networks.js'
import type { StartPosture } from './posture.js'

export type VerbContextErrorCode = 'user-exists' | 'user-private-field' | 'user-shape'

export class VerbContextError extends Error {
  readonly code: VerbContextErrorCode

  constructor(code: VerbContextErrorCode) {
    super(code)
    this.name = 'VerbContextError'
    this.code = code
  }
}

/** Thrown by a verb that received an argument it does not take. */
export class VerbArgsError extends Error {
  readonly code = 'unexpected-arg' as const

  constructor() {
    super('unexpected-arg')
    this.name = 'VerbArgsError'
  }
}

/** For a verb that takes no arguments: any key left after the peer check is refused. */
export function assertNoArgs(args: Record<string, unknown>): void {
  if (Object.keys(args).length > 0) throw new VerbArgsError()
}

export interface VerbContextRelay {
  multiaddr: string
  peerId: string
  /** True when the relay address is private (loopback or LAN): then `multiaddr` and `peerId` are secrets. */
  private: boolean
}

export interface VerbContext {
  // identity
  readonly role: Role
  readonly label: string
  readonly partyId: string
  /** The peer dir, which is also the device home given to openDeviceVault. */
  readonly peerDir: string
  /** The 0700 `<peerDir>/secrets`, created at boot. Verbs write 0600 secret files here and return paths only. */
  readonly secretsDir: string
  readonly bootN: number
  readonly bootId: string
  readonly peerId8: string
  // node
  readonly built: BuiltRoleNode
  readonly node: BuiltRoleNode['node']
  // relay
  readonly relay: VerbContextRelay
  // storage
  /** The open `node/async-storage.json` (the AsyncStorage stand-in for the shared workflows). */
  readonly kv: FileKvStorage
  /** Over `node/local-storage.json`; holds the NetworksEngine `recentNetworks`. */
  readonly localStorage: LocalStorage
  // vault
  /** The openDeviceVault handle, opened at boot with NO_APPROVAL (the at-rest key only). */
  readonly device: DeviceVault
  // secrecy
  readonly secrets: SecretRegistry
  // user
  readonly user: User | null
  saveUser(user: User): Promise<void>
  // networks
  engine(): RoleNetworksEngineLike
  openNetwork(hash: string): Promise<OpenedRoleNetwork<RoleNetworksEngineLike>>
  // flags
  readonly acceptTokenAttestations: boolean
  readonly posture: StartPosture
  readonly instruments: boolean
  // records and lifecycle
  record(where: string, err: unknown): void
  redact(text: string): string
  readonly authPrompts: number
  exit(reason: string): Promise<void>
}

export interface VerbContextParts {
  role: Role
  label: string
  partyId: string
  peerDir: string
  bootN: number
  bootId: string
  built: BuiltRoleNode
  relay: VerbContextRelay
  kv: FileKvStorage
  localStorage: LocalStorage
  device: DeviceVault
  secrets: SecretRegistry
  redactor: (text: string) => string
  acceptTokenAttestations: boolean
  posture: StartPosture
  instruments: boolean
  record(where: string, err: unknown): void
  exit(reason: string): Promise<void>
  /** Test seam: builds the role's NetworksEngine; defaults to createRoleNetworksEngine over `built`. */
  createEngine?: () => RoleNetworksEngineLike
}

const MAX_USER_FILE_BYTES = 64 * 1024
const PRIVATE_FIELD_RE = /priv|secret|seed/i

function loadUser(peerDir: string): User | null {
  const data = readPrivateFile(join(nodeDir(peerDir), PEER_FILES.user), { maxBytes: MAX_USER_FILE_BYTES })
  if (data === null) return null
  const parsed: unknown = JSON.parse(data.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { id?: unknown }).id !== 'string') throw new VerbContextError('user-shape')
  return parsed as User
}

export function createVerbContext(parts: VerbContextParts): VerbContext {
  const { peerDir, built, localStorage, device, secrets, redactor } = parts
  let user = loadUser(peerDir)
  let engine: RoleNetworksEngineLike | undefined
  const opens = new Map<string, Promise<OpenedRoleNetwork<RoleNetworksEngineLike>>>()
  const buildEngine = parts.createEngine ?? (() => createRoleNetworksEngine({ built, localStorage }))
  const ctx: VerbContext = {
    role: parts.role,
    label: parts.label,
    partyId: parts.partyId,
    peerDir,
    secretsDir: secretsDirOf(peerDir),
    bootN: parts.bootN,
    bootId: parts.bootId,
    peerId8: built.peerId8,
    built,
    node: built.node,
    relay: parts.relay,
    kv: parts.kv,
    localStorage,
    device,
    secrets,
    get user() {
      return user
    },
    async saveUser(next: User) {
      if (typeof next !== 'object' || next === null || typeof next.id !== 'string' || next.id.length === 0) throw new VerbContextError('user-shape')
      for (const key of Object.keys(next)) if (PRIVATE_FIELD_RE.test(key)) throw new VerbContextError('user-private-field')
      if (user !== null && user.id !== next.id) throw new VerbContextError('user-exists')
      writePrivateFileAtomic(join(nodeDir(peerDir), PEER_FILES.user), JSON.stringify(next))
      user = next
    },
    engine() {
      engine ??= buildEngine()
      return engine
    },
    openNetwork(hash: string) {
      let pending = opens.get(hash)
      if (pending === undefined) {
        pending = openRoleNetwork({ engine: ctx.engine(), localStorage, networkHash: hash, user })
        opens.set(hash, pending)
        pending.catch(() => {
          if (opens.get(hash) === pending) opens.delete(hash)
        })
      }
      return pending
    },
    acceptTokenAttestations: parts.acceptTokenAttestations,
    posture: parts.posture,
    instruments: parts.instruments,
    record: parts.record,
    redact: redactor,
    get authPrompts() {
      return device.vault.authPromptCount
    },
    exit: parts.exit
  }
  return ctx
}
