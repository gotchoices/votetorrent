// A fake OfficerVerbContext for the offline verb specs: a REAL device vault (67-13 openDeviceVault), a
// REAL file kv, a fresh SecretRegistry and the 67-08 authority join stores, over a mkdtemp home. The
// node and the engine default to Proxies that count and THROW on any property access, so "refused
// before any engine, node or vault work" is provable by `touches() === 0`. A spec that needs a
// behaving node or engine passes its own fake.
//
// Nothing here prints. The relay address is a fixture value (a fake peer id), never a real one.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { User } from '@votetorrent/vote-core'
import {
  AUTHORITY_JOIN_BOOTSTRAP_KEY,
  AUTHORITY_JOINED_NETWORKS_KEY,
  createJoinBootstrapStore,
  createJoinedNetworksStore,
  JoinedNetworksUnreadableError,
  sanitizeAuthorityJoinBootstrap
} from '@votetorrent/workflows'
import type { StartPosture } from '../../src/daemon/posture.js'
import type { OfficerVerbContext } from '../../src/network/network-verb-support.js'
import { PEER_FILES, nodeDir, secretsDir } from '../../src/node/peer-layout.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../../src/vault/device-vault.js'
import { openFileKv, type FileKvStorage } from '../../src/vault/file-kv.js'
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic } from '../../src/vault/private-file.js'
import { fakePeerId } from './ctl-fixture.js'

/** Thrown by the default node/engine proxies on any property access. */
export class TouchedError extends Error {
  readonly code = 'touched' as const

  constructor(what: string) {
    super(`touched ${what}`)
    this.name = 'TouchedError'
  }
}

export interface FakeOfficerCtxOptions {
  partyId: string
  /** The device home (= peer dir). Created 0700 when absent. */
  home: string
  engine?: unknown
  node?: unknown
  posture?: StartPosture
  acceptTokenAttestations?: boolean
  /** A different relay address, when a spec needs one; defaults to a loopback-shaped fixture value. */
  relayMultiaddr?: string
}

export interface FakeOfficerCtx extends OfficerVerbContext {
  readonly home: string
  readonly device: DeviceVault
  readonly kv: FileKvStorage
  /** Property accesses on the default node/engine proxies. */
  touches(): number
  close(): void
}

/** A proxy that counts every property access and throws TouchedError. */
function touchingProxy(label: string, count: () => void): object {
  return new Proxy(Object.create(null) as object, {
    get(_t, prop) {
      count()
      throw new TouchedError(`${label}.${String(prop)}`)
    },
    has(_t, prop) {
      count()
      throw new TouchedError(`${label} in ${String(prop)}`)
    }
  })
}

export function makeFakeOfficerCtx(opts: FakeOfficerCtxOptions): FakeOfficerCtx {
  const { home, partyId } = opts
  ensurePrivateDir(home)
  ensurePrivateDir(nodeDir(home))
  ensurePrivateDir(secretsDir(home))
  const device = openDeviceVault({ home })
  const kv = openFileKv({ path: join(nodeDir(home), PEER_FILES.asyncStorage) })
  const secrets = new SecretRegistry()
  let touched = 0
  const count = (): void => {
    touched++
  }
  const node = opts.node ?? touchingProxy('node', count)
  const engine = opts.engine ?? touchingProxy('engine', count)
  const userFile = join(nodeDir(home), PEER_FILES.user)
  let user: User | null = null
  if (existsSync(userFile)) {
    const data = readPrivateFile(userFile, { maxBytes: 65536 })
    if (data !== null) user = JSON.parse(data.toString('utf8')) as User
  }
  const stores = {
    joinBootstrap: createJoinBootstrapStore(kv, AUTHORITY_JOIN_BOOTSTRAP_KEY, sanitizeAuthorityJoinBootstrap),
    joinedNetworks: createJoinedNetworksStore(kv, AUTHORITY_JOINED_NETWORKS_KEY, {
      unreadable: 'reject',
      unreadableError: () => new JoinedNetworksUnreadableError()
    })
  }
  let closed = false
  const ctx: FakeOfficerCtx = {
    home,
    role: 'officer',
    partyId,
    peerDir: home,
    secretsDir: secretsDir(home),
    node,
    built: { ownerNode: node, stores },
    relay: { multiaddr: opts.relayMultiaddr ?? `/ip4/127.0.0.1/tcp/4001/ws/p2p/${fakePeerId(5)}` },
    kv,
    device,
    secrets,
    get user() {
      return user
    },
    async saveUser(next: User) {
      writePrivateFileAtomic(userFile, JSON.stringify(next))
      user = next
    },
    engine: () => engine as ReturnType<OfficerVerbContext['engine']>,
    posture: opts.posture ?? 'test',
    acceptTokenAttestations: opts.acceptTokenAttestations ?? false,
    touches: () => touched,
    close: () => {
      if (closed) return
      closed = true
      kv.close()
      device.close()
    }
  }
  return ctx
}

/** A fresh user id for specs. */
export const freshUserId = (): string => randomUUID()
