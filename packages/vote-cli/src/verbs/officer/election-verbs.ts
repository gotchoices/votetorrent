// The officer ELECTION verb group: pre-created empty by 67-24 so the registry never changes again;
// filled by 67-26 with one handler per election-setup verb (the record stays frozen and the registry
// line `...OFFICER_ELECTION_VERBS,` stays as it is). Each handler is a thin verb over the shared
// @votetorrent/workflows/authority election functions; the names are pinned by
// test/officer-election-verbs.spec.ts and the ctl spec, because a duplicate name in a later group
// would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import ballotSubmit from './ballot-submit.js'
import createElection from './create-election.js'
import inviteKeyholder from './invite-keyholder.js'
import keyholderPolicy from './keyholder-policy.js'
import taskSign from './task-sign.js'

export const OFFICER_ELECTION_VERBS: Readonly<Record<string, VerbHandler<OfficerVerbContext>>> = Object.freeze({
  'create-election': createElection,
  'keyholder-policy': keyholderPolicy,
  'invite-keyholder': inviteKeyholder,
  'ballot-submit': ballotSubmit,
  'task-sign': taskSign
})

/** The five verb names, in registry order (for the specs' registry checks). */
export const OFFICER_ELECTION_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(OFFICER_ELECTION_VERBS))
