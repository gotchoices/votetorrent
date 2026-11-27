// The voter RESULTS verb group (67-30): cast, send and results, spread into the voter registry by exactly two
// lines there. The names are pinned by test/voter-vote-verbs.spec.ts, because a duplicate name in a later
// spread would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import castVerb from './cast.js'
import voterResultsVerb from './results.js'
import sendVerb from './send.js'

export const VOTER_RESULTS_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  cast: castVerb,
  send: sendVerb,
  results: voterResultsVerb
})

export const VOTER_RESULTS_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(VOTER_RESULTS_VERBS))
