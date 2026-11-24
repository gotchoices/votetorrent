// The static verb registry a ctl server dispatches from. Names are [a-z0-9-]{1,64}, the built-in
// `verbs` name is reserved, handlers are functions, and the registry is a frozen object over a private
// Map of own keys only: no prototype lookups (`constructor`, `__proto__`), no mutation after definition,
// no file paths and no dynamic loading anywhere (the rig's `module` override is dropped on purpose).

import { BUILTIN_VERBS_VERB, VERB_NAME_RE, type VerbHandler } from './protocol.js'

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

export function defineVerbRegistry<C>(entries: Record<string, VerbHandler<C>>): VerbRegistry<C> {
  const table = new Map<string, VerbHandler<C>>()
  for (const [name, handler] of Object.entries(entries)) {
    if (!VERB_NAME_RE.test(name)) throw new VerbRegistryError('bad-verb-name')
    if (name === BUILTIN_VERBS_VERB) throw new VerbRegistryError('reserved-verb-name')
    if (typeof handler !== 'function') throw new VerbRegistryError('bad-handler')
    table.set(name, handler)
  }
  const sorted = [...table.keys()].sort()
  return Object.freeze({
    get: (name: string) => table.get(name),
    names: () => [...sorted]
  })
}
