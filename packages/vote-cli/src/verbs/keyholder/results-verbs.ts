// The keyholder RESULTS verb group (67-30, discretion choice 5): `results`, the same handler the officer serves
// (src/verbs/officer/results.ts works on any authority VerbContext through ctx.openNetwork alone), so every
// peer of the election reads identical results (CLI-06). Spread into the keyholder registry by exactly two lines.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import results from '../officer/results.js'

export const KEYHOLDER_RESULTS_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  results
})

export const KEYHOLDER_RESULTS_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(KEYHOLDER_RESULTS_VERBS))
