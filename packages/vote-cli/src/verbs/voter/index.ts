// The voter verb group (67-29): one handler per voter join/registration workflow, spread into the voter
// registry by exactly two lines there. The five names are pinned by test/voter-verbs.spec.ts, because a
// duplicate name in a later spread (67-30's results group) would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { answerChallengeVerb } from './answer-challenge.js'
import { joinVerb } from './join.js'
import { readDecisionVerb } from './read-decision.js'
import { registerVerb } from './register.js'
import { stageAssociationVerb } from './stage-association.js'

export const VOTER_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  join: joinVerb,
  register: registerVerb,
  'stage-association': stageAssociationVerb,
  'answer-challenge': answerChallengeVerb,
  'read-decision': readDecisionVerb
})

export const VOTER_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(VOTER_VERBS))
