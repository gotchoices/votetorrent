// The officer INTAKE verb group: pre-created empty by 67-24 so the registry never changes again;
// 67-27 fills it (one handler per verb, the record stays frozen and the registry line stays as is).

import type { VerbHandler } from '../../ctl/protocol.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'

export const OFFICER_INTAKE_VERBS: Readonly<Record<string, VerbHandler<OfficerVerbContext>>> = Object.freeze({})
