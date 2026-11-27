// `vt officer found`: found a network through the engine path the Add Network screen uses
// (`NetworksEngine.buildCreate().update({ networkInit, user })`, `isValid()`, `commit()`), with the
// CLI-owned founding inputs (network-init.ts) over the daemon's relay. The founding officer is this
// peer's authority user, provisioned on first use under the approval token. The reply carries the
// 32-hex network hash (not a secret) and never a key, a code or a token. No duplicate-create gate and
// no reconcile mirror: those are screen-state logic; the ctl client timeout bounds the call.
//
// Order: arguments, the party guard, the founding inputs (pure), the token, the identity, the engine.

import { performance } from 'node:perf_hooks'
import type { NetworkReference } from '@votetorrent/vote-core'
import { ensureAuthorityUser } from '../../network/authority-user.js'
import { buildNetworkInit, type FoundingElectionType } from '../../network/network-init.js'
import {
  NetworkVerbError,
  assertNetworkParty,
  checkArgs,
  officerEngine,
  resolveVerbApproval,
  type OfficerVerbContext
} from '../../network/network-verb-support.js'

const HASH_RE = /^[0-9a-f]{32}$/
const ELECTION_TYPES: ReadonlySet<string> = new Set(['official', 'adhoc'])

export default async function found(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = checkArgs(args, { required: ['name'], optional: ['tokenFile', 'authorityName', 'domain', 'adminName', 'adminTitle', 'electionType'] })
  assertNetworkParty(ctx)
  if (a.electionType !== undefined && !ELECTION_TYPES.has(a.electionType)) throw new NetworkVerbError('bad-arg', { argName: 'electionType' })
  const networkInit = buildNetworkInit({
    name: a.name!,
    relays: [ctx.relay.multiaddr],
    ...(a.authorityName !== undefined ? { authorityName: a.authorityName } : {}),
    ...(a.domain !== undefined ? { domain: a.domain } : {}),
    ...(a.adminName !== undefined ? { adminName: a.adminName } : {}),
    ...(a.adminTitle !== undefined ? { adminTitle: a.adminTitle } : {}),
    ...(a.electionType !== undefined ? { electionType: a.electionType as FoundingElectionType } : {})
  })
  const approval = resolveVerbApproval(a)
  const user = await ensureAuthorityUser(ctx, approval, { name: a.adminName ?? 'vt officer' })
  const engine = officerEngine(ctx)
  const builder = engine.buildCreate().update({ networkInit, user })
  if (!builder.isValid()) {
    const codes = builder.errors().map((e) => String((e as { code?: unknown }).code ?? 'unknown'))
    throw new NetworkVerbError('network-init-invalid', { cause: Object.assign(new Error('network init invalid'), { name: 'BuilderErrors', codes }) })
  }
  const t0 = performance.now()
  const net = await builder.commit()
  const createMs = Math.round(performance.now() - t0)
  const hash = (net as unknown as { init?: Partial<NetworkReference> }).init?.hash
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new NetworkVerbError('create-unconfirmed')
  const recents = await engine.getRecentNetworks()
  return {
    networkHash: hash,
    networkHash8: hash.slice(0, 8),
    createMs,
    recentHas: recents.some((r) => r.hash === hash),
    electionType: networkInit.policies.electionType,
    posture: ctx.posture
  }
}
