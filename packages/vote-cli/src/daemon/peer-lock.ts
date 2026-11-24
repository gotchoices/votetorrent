// `daemon.lock`: one live daemon per peer dir. The file is created once (wx, 0600) with this pid; an
// existing lock naming a LIVE pid refuses the start (`peer-dir-busy`), a dead or unreadable one is
// replaced once. Mirrors db-p2p-storage-fs's store.lock rule, one level up, so a second daemon is
// refused before it opens any store. Start-path module: node built-ins and relative imports only.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createPrivateFileOnce } from '../vault/private-file.js'
import { PEER_FILES } from '../node/peer-layout.js'

export class PeerLockError extends Error {
  readonly code = 'peer-dir-busy' as const

  constructor() {
    super('peer-dir-busy')
    this.name = 'PeerLockError'
  }
}

export interface PeerLock {
  /** Removes the lock only while it still names this pid. Idempotent. */
  release(): void
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the pid exists and belongs to someone else, which still means a live holder
    return (e as { code?: unknown } | undefined)?.code !== 'ESRCH'
  }
}

function holderPid(file: string): number | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return /^\d{1,10}$/.test(text) ? Number(text) : undefined
  } catch {
    return undefined
  }
}

export function acquirePeerLock(peerDir: string): PeerLock {
  const file = join(peerDir, PEER_FILES.lock)
  const mine = `${process.pid}\n`
  if (!createPrivateFileOnce(file, mine)) {
    const holder = holderPid(file)
    // our own pid means this process already holds the dir: just as busy as another live daemon
    if (holder !== undefined && (holder === process.pid || pidIsLive(holder))) throw new PeerLockError()
    rmSync(file, { force: true })
    if (!createPrivateFileOnce(file, mine)) throw new PeerLockError()
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      if (holderPid(file) === process.pid) rmSync(file, { force: true })
    }
  }
}
