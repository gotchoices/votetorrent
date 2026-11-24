import type { PrivateKey } from '@libp2p/interface'

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

export async function loadOrCreatePeerKey(_peerDir: string, _deps: PeerKeyDeps): Promise<PrivateKey> {
  throw new Error('unimplemented')
}
