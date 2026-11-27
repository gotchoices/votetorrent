// Role -> ctl registry composition. Each role's entries object lives in its own file
// (src/verbs/<role>/registry.ts, appended to by the later verb plans); this module is never edited by
// them. Every handler is wrapped by the peer check: a colocated process runs one ctl server per peer,
// each in its own dir with its own token, so a `peer` argument is honoured only as a cross-check and
// another peer's label is refused with `WrongPeer`.

import type { Role, VerbHandler } from '../ctl/protocol.js'
import { defineVerbRegistry, type VerbRegistry } from '../ctl/verb-registry.js'
import { KEYHOLDER_VERB_ENTRIES } from '../verbs/keyholder/registry.js'
import { OFFICER_VERB_ENTRIES } from '../verbs/officer/registry.js'
import { VOTER_VERB_ENTRIES } from '../verbs/voter/registry.js'
import type { VerbContext } from './verb-context.js'

export class WrongPeerError extends Error {
  readonly code = 'wrong-peer' as const

  constructor() {
    super('wrong-peer')
    this.name = 'WrongPeer'
  }
}

export const ROLE_VERB_ENTRIES: Readonly<Record<Role, Readonly<Record<string, VerbHandler<VerbContext>>>>> = Object.freeze({
  officer: OFFICER_VERB_ENTRIES,
  keyholder: KEYHOLDER_VERB_ENTRIES,
  voter: VOTER_VERB_ENTRIES
})

/** `args.peer` is a match only when it is a string equal to `label`; it is stripped before the handler runs. */
export function withPeerCheck(label: string, handler: VerbHandler<VerbContext>): VerbHandler<VerbContext> {
  return (ctx, args) => {
    if (!Object.hasOwn(args, 'peer')) return handler(ctx, args)
    if (args.peer !== label) throw new WrongPeerError()
    const { peer: _peer, ...rest } = args
    return handler(ctx, rest)
  }
}

export function buildPeerRegistry(role: Role, label: string): VerbRegistry<VerbContext> {
  const entries: Record<string, VerbHandler<VerbContext>> = {}
  for (const [name, handler] of Object.entries(ROLE_VERB_ENTRIES[role])) entries[name] = withPeerCheck(label, handler)
  return defineVerbRegistry(entries)
}
