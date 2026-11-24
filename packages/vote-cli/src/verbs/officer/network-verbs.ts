// The officer NETWORK verb group (67-24): found, join, mint, owner-setup, authority-id, dashboard-code.
// Each verb runs the shared @votetorrent/workflows code the Authority app runs; the registry spreads
// this frozen record after the common verbs. The names are pinned by the group's own specs.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
import authorityId from './authority-id.js'
import dashboardCode from './dashboard-code.js'
import found from './found.js'
import join from './join.js'
import mint from './mint.js'
import ownerSetup from './owner-setup.js'

export const OFFICER_NETWORK_VERB_NAMES = ['found', 'join', 'mint', 'owner-setup', 'authority-id', 'dashboard-code'] as const

export type OfficerNetworkVerbName = (typeof OFFICER_NETWORK_VERB_NAMES)[number]

export const OFFICER_NETWORK_VERBS: Readonly<Record<OfficerNetworkVerbName, VerbHandler<OfficerVerbContext>>> = Object.freeze({
  found,
  join,
  mint,
  'owner-setup': ownerSetup,
  'authority-id': authorityId,
  'dashboard-code': dashboardCode
})
