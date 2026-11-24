// The peer's libp2p identity key: an Ed25519 protobuf, base64 inside `node/peer-key.json`, created
// ONCE at 0600 (temp + link, so two racing daemons never both win) in the 0700 `node/` dir, and read
// back with the private-file reader that refuses a group- or other-readable file. Port of the lean
// rig's hr5-open.ts `peerKey`. Key bytes never reach a log, an error or a return value other than the
// key object itself; errors carry a code only.

import type { PrivateKey } from '@libp2p/interface'
import { join } from 'node:path'
import { createPrivateFileOnce, ensurePrivateDir, readPrivateFile } from '../vault/private-file.js'
import { PEER_FILES, nodeDir } from './peer-layout.js'

export type PeerKeyErrorCode = 'peer-key-mode' | 'peer-key-corrupt'

export class PeerKeyError extends Error {
  readonly code: PeerKeyErrorCode

  constructor(code: PeerKeyErrorCode) {
    super(code)
    this.name = 'PeerKeyError'
    this.code = code
  }
}

export interface PeerKeyDeps {
  generateKeyPair(type: 'Ed25519'): Promise<PrivateKey>
  privateKeyToProtobuf(key: PrivateKey): Uint8Array
  privateKeyFromProtobuf(buf: Uint8Array): PrivateKey
}

/** A protobuf of an Ed25519 key is under 200 bytes; anything far larger is not a key file. */
const MAX_KEY_FILE_BYTES = 4096

function readExisting(file: string, deps: PeerKeyDeps): PrivateKey | null {
  let data: Buffer | null
  try {
    data = readPrivateFile(file, { maxBytes: MAX_KEY_FILE_BYTES })
  } catch (e) {
    const err = e as { name?: unknown, code?: unknown } | undefined
    if (err?.name === 'PrivateFileError') {
      if (err.code === 'mode' || err.code === 'owner') throw new PeerKeyError('peer-key-mode')
      throw new PeerKeyError('peer-key-corrupt')
    }
    throw e
  }
  if (data === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new PeerKeyError('peer-key-corrupt')
  }
  const k = (parsed as { k?: unknown } | null)?.k
  if (typeof parsed !== 'object' || parsed === null || typeof k !== 'string' || k.length === 0) throw new PeerKeyError('peer-key-corrupt')
  try {
    return deps.privateKeyFromProtobuf(Buffer.from(k, 'base64'))
  } catch {
    throw new PeerKeyError('peer-key-corrupt')
  }
}

/** Loads `node/peer-key.json`, or generates an Ed25519 key and writes it once. A restart keeps the peer id. */
export async function loadOrCreatePeerKey(peerDir: string, deps: PeerKeyDeps): Promise<PrivateKey> {
  const dir = nodeDir(peerDir)
  ensurePrivateDir(dir)
  const file = join(dir, PEER_FILES.peerKey)
  const existing = readExisting(file, deps)
  if (existing !== null) return existing
  const key = await deps.generateKeyPair('Ed25519')
  const text = JSON.stringify({ k: Buffer.from(deps.privateKeyToProtobuf(key)).toString('base64') })
  if (createPrivateFileOnce(file, text)) return key
  // a concurrent create won the race: the file on disk is the peer's key, not ours
  const raced = readExisting(file, deps)
  if (raced === null) throw new PeerKeyError('peer-key-corrupt')
  return raced
}
