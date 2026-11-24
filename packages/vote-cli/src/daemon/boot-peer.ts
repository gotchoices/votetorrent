import type { VerbContext } from './verb-context.js'
export type PeerBootToken = 'peer-dir-busy' | 'vault-open' | 'start-error' | 'relay-reservation-timeout' | 'boot-timeout'
export class PeerBootError extends Error {
  readonly token: PeerBootToken
  constructor(token: PeerBootToken) {
    super(token)
    this.name = 'PeerBootError'
    this.token = token
  }
}
export interface BootedPeer {
  ctx: VerbContext
  bootRecord: Record<string, unknown>
  close(reason: string): Promise<void>
}
export async function bootPeer(_opts: unknown): Promise<BootedPeer> {
  throw new Error('unimplemented')
}
