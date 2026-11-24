// The officer INTAKE verb group (67-27): pre-created empty by 67-24 so the registry never changes again,
// filled here with one handler per verb. The record stays frozen and the registry line stays as is. The
// five names are disjoint from the network group (67-24) and the election group (67-26); each group's
// own spec pins its names, because a duplicate name in a later spread would silently override.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import { approveVerb } from './approve.js'
import { enableIntakeVerb } from './enable-intake.js'
import { peerSyncVerb } from './peer-sync.js'
import { refuseVerb } from './refuse.js'
import { registrationsVerb } from './registrations.js'

export const OFFICER_INTAKE_VERBS: Readonly<Record<string, VerbHandler<OfficerVerbContext>>> = Object.freeze({
  'enable-intake': enableIntakeVerb,
  'peer-sync': peerSyncVerb,
  approve: approveVerb,
  refuse: refuseVerb,
  registrations: registrationsVerb
})
