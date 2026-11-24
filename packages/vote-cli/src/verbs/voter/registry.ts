// The voter daemon's verb entries. ONE layout for every role: a frozen object of one `...GROUP,`
// spread per line, turned into the 67-12 registry by src/daemon/registries.ts. A voter serves no
// `capability` verb: it is never an owner of a cadre.
//
// A later verb plan appends exactly TWO lines here and touches nothing else:
//   1. `import { <GROUP>_VERBS } from './index.js'` (the voter group lives in this dir) directly after
//      the last import line;
//   2. `  ...<GROUP>_VERBS,` as the last member, directly before the closing `})`.
// A duplicate verb name in a later spread silently overrides an earlier one, so each group's own spec
// pins its names to its handlers.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { COMMON_VERBS } from '../common.js'
import { VOTER_VERBS } from './index.js'

export const VOTER_VERB_ENTRIES: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  ...COMMON_VERBS,
  ...VOTER_VERBS,
})
