// The per-peer directory layout of a vt role daemon: `<run>/<party>/<label>/` holds the ctl files,
// the daemon records, the 0700 secrets dir, the node state (peer key, user, kv files, per-scope
// stores) and the device vault. Pure path arithmetic over node:path; no I/O here.

import { join } from 'node:path'

export const PEER_FILES = Object.freeze({
  ctlPort: 'ctl.port',
  ctlToken: 'ctl.token',
  lock: 'daemon.lock',
  daemon: 'daemon.json',
  crash: 'crash.jsonl',
  secrets: 'secrets',
  node: 'node',
  peerKey: 'peer-key.json',
  user: 'user.json',
  asyncStorage: 'async-storage.json',
  localStorage: 'local-storage.json',
  store: 'store',
  vault: 'vault'
} as const)

/** `boot-<n>.json`: one create-once record per daemon boot of this peer. */
export function bootFile(n: number): string {
  return `boot-${n}.json`
}

export function nodeDir(peerDir: string): string {
  return join(peerDir, PEER_FILES.node)
}

export function storeDir(peerDir: string): string {
  return join(nodeDir(peerDir), PEER_FILES.store)
}

export function secretsDir(peerDir: string): string {
  return join(peerDir, PEER_FILES.secrets)
}

/** cadre-core's own getStrandStoragePath convention, capped so a long scope id never overflows a path. */
export function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 128)
}

export function scopeDir(peerDir: string, scope: string): string {
  return join(storeDir(peerDir), `scope-${safeScope(scope)}`)
}
