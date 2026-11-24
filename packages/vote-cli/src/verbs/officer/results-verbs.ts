// The officer RESULTS verb group (67-30): release-window, tally, publish and results, spread into the officer
// registry by exactly two lines there. The names are pinned by test/officer-results-verbs.spec.ts and the ctl
// spec, because a duplicate name in a later group would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import publish from './publish.js'
import releaseWindow from './release-window.js'
import results from './results.js'
import tally from './tally.js'

export const OFFICER_RESULTS_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  'release-window': releaseWindow,
  tally,
  publish,
  results
})

export const OFFICER_RESULTS_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(OFFICER_RESULTS_VERBS))
