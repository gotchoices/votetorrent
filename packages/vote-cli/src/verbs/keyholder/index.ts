// The keyholder verb group: `join`, `accept`, `dkg`, `release` (CONTEXT "Workflow coverage": one verb
// each). Spread into src/verbs/keyholder/registry.ts as `...KEYHOLDER_VERBS,`. The keyholder role
// served no `join` before this group (67-23/67-24 registered only readback, stop and capability on
// it), so `join` is registered here. The names are pinned by test/keyholder-verbs.spec.ts, because a
// duplicate name in a later spread would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import accept from './accept.js'
import dkg from './dkg.js'
import join from './join.js'
import release from './release.js'

export const KEYHOLDER_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  join,
  accept,
  dkg,
  release
})

/** The four verb names, in registry order (for the specs' registry checks). */
export const KEYHOLDER_VERB_NAMES: readonly string[] = Object.freeze(Object.keys(KEYHOLDER_VERBS))
