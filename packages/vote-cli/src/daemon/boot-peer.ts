// Boots ONE peer in-process: the posture check, the 0700 dirs, the peer lock, the two kv files, the
// device vault (at-rest key only), the role node over the relay, the create-once boot record and the
// VerbContext. The daemon calls it once per colocated label; a spec calls it (through the fixture's
// `bootInProcessPeer`) to build exactly the context the daemon builds, with no ctl server. Every
// resource opened before a failure is released before `PeerBootError` is thrown, and the failure is
// recorded in the boot file after the cleanup.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NO_APPROVAL } from '../approval/token.js'
import type { Role } from '../ctl/protocol.js'
import type { SecretRegistry } from '../secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../vault/device-vault.js'
import { openFileKv, type FileKvStorage } from '../vault/file-kv.js'
import { createPrivateFileOnce, ensurePrivateDir, writePrivateFileAtomic, readPrivateFile } from '../vault/private-file.js'
import { buildRoleNode, type BuiltRoleNode, type RoleNodeDeps } from '../node/build-role-node.js'
import { createFileLocalStorage } from '../node/local-storage.js'
import { PEER_FILES, bootFile, nodeDir, secretsDir } from '../node/peer-layout.js'
import type { DaemonEnvReport } from './daemon-env.js'
import { acquirePeerLock, type PeerLock } from './peer-lock.js'
import { assertStartPosture, startPostureOf } from './posture.js'
import { createVerbContext, type VerbContext, type VerbContextRelay } from './verb-context.js'

export type PeerBootToken = 'peer-dir-busy' | 'vault-open' | 'start-error' | 'relay-reservation-timeout' | 'boot-timeout'

export class PeerBootError extends Error {
  readonly token: PeerBootToken

  constructor(token: PeerBootToken, cause?: unknown) {
    super(token, cause === undefined ? undefined : { cause })
    this.name = 'PeerBootError'
    this.token = token
  }
}

export interface BootPeerOptions {
  role: Role
  label: string
  partyId: string
  peerDir: string
  relay: VerbContextRelay
  secrets: SecretRegistry
  redactor: (text: string) => string
  acceptTokenAttestations: boolean
  instruments: boolean
  relayReadyMs: number
  bootTimeoutMs: number
  warn?: (...a: unknown[]) => void
  /** Recorded in the boot file; the daemon passes applyDaemonEnv's report. */
  envReport?: DaemonEnvReport
  /** Called by the `stop` verb and the max-runtime timer; the daemon wires it to its shutdown. */
  exit?: (reason: string) => Promise<void>
  /** Where a thrown verb is recorded; the daemon wires the crash recorder. */
  record?: (where: string, err: unknown) => void
  /** Test seam for the node builder's engine values. */
  nodeDeps?: RoleNodeDeps
}

export interface BootedPeer {
  ctx: VerbContext
  bootRecord: Record<string, unknown>
  /** Stops the node, closes the kv files and the vault, records the stop reason, releases the lock. Idempotent. */
  close(reason: string): Promise<void>
}

const MAX_DAEMON_FILE_BYTES = 64 * 1024

function chainNames(e: unknown): string[] {
  const out: string[] = []
  for (let x: unknown = e, d = 0; x !== null && x !== undefined && d < 6; x = (x as { cause?: unknown }).cause, d++) {
    const name = (x as { name?: unknown }).name
    out.push(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'Error')
  }
  return out
}

function countBoots(peerDir: string): number {
  return readdirSync(peerDir).filter((f) => /^boot-\d+\.json$/.test(f)).length
}

function tokenOf(e: unknown): PeerBootToken {
  const name = (e as { name?: unknown } | undefined)?.name
  if (name === 'RelayNotReadyError') return 'relay-reservation-timeout'
  if (name === 'BootTimeoutError') return 'boot-timeout'
  return 'start-error'
}

/** Rewrites daemon.json with the stop reason when the file exists (best effort; the daemon owns its content). */
function recordStop(peerDir: string, reason: string): void {
  const file = join(peerDir, PEER_FILES.daemon)
  try {
    const data = readPrivateFile(file, { maxBytes: MAX_DAEMON_FILE_BYTES })
    if (data === null) return
    const parsed = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    writePrivateFileAtomic(file, JSON.stringify({ ...parsed, stoppedAt: new Date().toISOString(), stopReason: reason }))
  } catch {
    // a stop record that cannot be written never blocks the stop
  }
}

export async function bootPeer(opts: BootPeerOptions): Promise<BootedPeer> {
  assertStartPosture({ role: opts.role, partyId: opts.partyId, args: opts.acceptTokenAttestations ? { acceptTokenAttestations: true } : {} })
  const { role, label, partyId, peerDir, relay, secrets, redactor } = opts
  const warn = opts.warn ?? (() => undefined)
  const record = opts.record ?? (() => undefined)
  const posture = startPostureOf(opts.acceptTokenAttestations ? { acceptTokenAttestations: true } : {})
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  // 1. dirs
  ensurePrivateDir(peerDir)
  ensurePrivateDir(secretsDir(peerDir))
  ensurePrivateDir(nodeDir(peerDir))
  // 2. lock
  let lock: PeerLock
  try {
    lock = acquirePeerLock(peerDir)
  } catch (e) {
    throw new PeerBootError('peer-dir-busy', e)
  }
  // 3. boot number
  const bootN = countBoots(peerDir) + 1
  const bootId = `${label}-${bootN}-${process.pid}`
  const baseRecord = { boot: bootN, role, label, partyId, pid: process.pid, startedAt }
  const writeBoot = (extra: Record<string, unknown>): void => {
    createPrivateFileOnce(join(peerDir, bootFile(bootN)), JSON.stringify({ ...baseRecord, ...extra }))
  }

  let kv: FileKvStorage | undefined
  let lsKv: FileKvStorage | undefined
  let device: DeviceVault | undefined
  let built: BuiltRoleNode | undefined
  const releaseAll = async (): Promise<void> => {
    await built?.stop().catch(() => undefined)
    device?.close()
    lsKv?.close()
    kv?.close()
    lock.release()
  }
  const fail = async (token: PeerBootToken, cause: unknown): Promise<never> => {
    await releaseAll()
    writeBoot({ failed: { token, chain: chainNames(cause) } })
    throw new PeerBootError(token, cause)
  }

  try {
    // 4. the two kv files
    kv = openFileKv({ path: join(nodeDir(peerDir), PEER_FILES.asyncStorage) })
    lsKv = openFileKv({ path: join(nodeDir(peerDir), PEER_FILES.localStorage) })
  } catch (e) {
    return fail('start-error', e)
  }
  // 5. the device vault, at-rest key only: no user token is read here
  try {
    device = openDeviceVault({ home: peerDir, approval: NO_APPROVAL })
  } catch (e) {
    return fail('vault-open', e)
  }
  // 6. the role node over the relay
  try {
    built = await buildRoleNode(
      {
        role,
        label,
        partyId,
        peerDir,
        relay: { multiaddr: relay.multiaddr, peerId: relay.peerId },
        kv,
        warn,
        instruments: opts.instruments,
        relayReadyMs: opts.relayReadyMs,
        bootTimeoutMs: opts.bootTimeoutMs
      },
      opts.nodeDeps
    )
  } catch (e) {
    return fail(tokenOf(e), e)
  }

  // 7. the boot record
  const readyMs = Date.now() - startedMs
  const bootRecord: Record<string, unknown> = {
    ...baseRecord,
    readyMs,
    recreated: built.recreated,
    recreatedScope: built.recreatedScope,
    reanchor: built.reanchor,
    ownerTrust: built.ownerTrust,
    rendezvous: built.rendezvous,
    relayReadyMs: built.relayReadyMs,
    peerId8: built.peerId8,
    acceptTokenAttestations: opts.acceptTokenAttestations,
    posture,
    instruments: opts.instruments,
    preload: process.execArgv.includes('--import'),
    cpuProf: process.execArgv.includes('--cpu-prof'),
    debugKept: opts.envReport?.debugKept ?? 0,
    debugDropped: opts.envReport?.debugDropped ?? 0,
    nodeOptionsSet: opts.envReport?.nodeOptionsSet ?? false
  }
  writeBoot(bootRecord)

  let closing: Promise<void> | undefined
  const close = (reason: string): Promise<void> => {
    closing ??= (async () => {
      await releaseAll()
      recordStop(peerDir, reason)
    })()
    return closing
  }

  // 8. the context
  const ctx = createVerbContext({
    role,
    label,
    partyId,
    peerDir,
    bootN,
    bootId,
    built,
    relay,
    kv,
    localStorage: createFileLocalStorage(lsKv),
    device,
    secrets,
    redactor,
    acceptTokenAttestations: opts.acceptTokenAttestations,
    posture,
    instruments: opts.instruments,
    record,
    exit: opts.exit ?? ((reason) => close(reason))
  })
  return { ctx, bootRecord, close }
}
