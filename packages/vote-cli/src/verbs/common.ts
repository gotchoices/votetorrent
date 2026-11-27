// The verbs every role daemon serves (readback, stop) and the ones every AUTHORITY daemon serves
// (capability). The role registry files spread these first; later verb groups append after them.

import type { VerbHandler } from '../ctl/protocol.js'
import type { VerbContext } from '../daemon/verb-context.js'
import capability from './capability.js'
import readback from './readback.js'
import stop from './stop.js'

export const COMMON_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({ readback, stop })

export const AUTHORITY_COMMON_VERBS: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({ capability })
