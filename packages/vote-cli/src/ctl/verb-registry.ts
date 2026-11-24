// Static verb registry (red stub).

import type { VerbHandler } from './protocol.js'

export type VerbRegistryErrorCode = 'bad-verb-name' | 'reserved-verb-name' | 'bad-handler'

export class VerbRegistryError extends Error {
  readonly code: VerbRegistryErrorCode

  constructor(code: VerbRegistryErrorCode) {
    super(`verb registry: ${code}`)
    this.name = 'VerbRegistryError'
    this.code = code
  }
}

export interface VerbRegistry<C> {
  get(name: string): VerbHandler<C> | undefined
  names(): string[]
}

export function defineVerbRegistry<C>(_entries: Record<string, VerbHandler<C>>): VerbRegistry<C> {
  throw new Error('unimplemented')
}
