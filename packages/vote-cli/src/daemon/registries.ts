import type { Role, VerbHandler } from '../ctl/protocol.js'
import type { VerbRegistry } from '../ctl/verb-registry.js'
import { OFFICER_VERB_ENTRIES } from '../verbs/officer/registry.js'
import { KEYHOLDER_VERB_ENTRIES } from '../verbs/keyholder/registry.js'
import { VOTER_VERB_ENTRIES } from '../verbs/voter/registry.js'
import type { VerbContext } from './verb-context.js'
export class WrongPeerError extends Error {
  readonly code = 'wrong-peer' as const
  constructor() {
    super('wrong-peer')
    this.name = 'WrongPeer'
  }
}
export const ROLE_VERB_ENTRIES = Object.freeze({ officer: OFFICER_VERB_ENTRIES, keyholder: KEYHOLDER_VERB_ENTRIES, voter: VOTER_VERB_ENTRIES })
export function withPeerCheck(_label: string, _handler: VerbHandler<VerbContext>): VerbHandler<VerbContext> {
  throw new Error('unimplemented')
}
export function buildPeerRegistry(_role: Role, _label: string): VerbRegistry<VerbContext> {
  throw new Error('unimplemented')
}
