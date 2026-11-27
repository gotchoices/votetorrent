// The officer daemon's verb entries. ONE layout for every role: a frozen object of one `...GROUP,`
// spread per line, turned into the 67-12 registry by src/daemon/registries.ts.
//
// Every officer verb group is wired here already (67-24 pre-created the election and intake group files
// as empty frozen records; 67-26 and 67-27 fill THOSE files and never touch this one). Should a further
// group ever be needed, it appends exactly TWO lines and touches nothing else:
//   1. `import { <GROUP>_VERBS } from './<group>-verbs.js'` directly after the last import line;
//   2. `  ...<GROUP>_VERBS,` as the last member, directly before the closing `})`.
// A duplicate verb name in a later spread silently overrides an earlier one, so each group's own spec
// pins its names to its handlers. The handlers of the groups take an OfficerVerbContext
// (src/network/network-verb-support.ts); the daemon's VerbContext is assignable to it, which the
// spreads below check at compile time (a VerbHandler<OfficerVerbContext> is a VerbHandler<VerbContext>
// only when VerbContext is assignable to OfficerVerbContext) and `assertOfficerContext` restates.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import { AUTHORITY_COMMON_VERBS, COMMON_VERBS } from '../common.js'
import { OFFICER_NETWORK_VERBS } from './network-verbs.js'
import { OFFICER_ELECTION_VERBS } from './election-verbs.js'
import { OFFICER_INTAKE_VERBS } from './intake-verbs.js'
import { OFFICER_RESULTS_VERBS } from './results-verbs.js'

/** Compile-time pin: the daemon's context satisfies the officer verb context (never called). */
export const assertOfficerContext = (ctx: VerbContext): OfficerVerbContext => ctx

export const OFFICER_VERB_ENTRIES: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({
  ...COMMON_VERBS,
  ...AUTHORITY_COMMON_VERBS,
  ...OFFICER_NETWORK_VERBS,
  ...OFFICER_ELECTION_VERBS,
  ...OFFICER_INTAKE_VERBS,
  ...OFFICER_RESULTS_VERBS,
})
