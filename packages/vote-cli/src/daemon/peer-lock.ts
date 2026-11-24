export class PeerLockError extends Error {
  readonly code = 'peer-dir-busy' as const
  constructor() {
    super('peer-dir-busy')
    this.name = 'PeerLockError'
  }
}
export function acquirePeerLock(_peerDir: string): { release(): void } {
  throw new Error('unimplemented')
}
