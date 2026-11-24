// `vt officer join` (and, through the named export `authorityJoin`, 67-28's `vt keyholder join`): join
// a network from a voter join code read out of a 0600 file. The decoded name, the fingerprint (from a
// second 0600 file) and the `networkHash` argument must all match BEFORE the shared
// `runAuthorityNetworkJoin` runs (the Join Network screen's preview), and the join is raced against a
// bounded timeout. Then the shared `completeAuthorityJoin` selects the network, re-anchors the own
// key and refreshes the owner trust. cadre-core's functions are passed in, as the shared signatures
// ask (the CLI is plain Node ESM and may import @serfab/cadre-core statically).
//
// Order: arguments, the party guard, the hash and timeout, the two files, the preview, the token,
// the identity, the node.

import { performance } from 'node:perf_hooks'
import { decodeCadreInvitation, mergeSeedPeers, verifyCadrePeerVoucher, verifyInvitationAdmission } from '@serfab/cadre-core'
import { decodeNetworkJoinCode } from '@votetorrent/vote-engine/rn'
import {
  completeAuthorityJoin,
  isSelfVouched,
  readOwnerTrustClassification,
  runAuthorityNetworkJoin,
  type AuthorityJoinCadre,
  type AuthorityNetworkJoinResult,
  type OwnerTrustNode,
  type SelfVoucherNode,
  type SelfVoucherVerifiers
} from '@votetorrent/workflows/authority'
import { ensureAuthorityUser } from '../../network/authority-user.js'
import {
  NetworkVerbError,
  assertNetworkParty,
  checkArgs,
  officerEngine,
  officerNode,
  parseNetworkHash,
  readSecretSource,
  resolveVerbApproval,
  type OfficerVerbContext
} from '../../network/network-verb-support.js'

export const JOIN_TIMEOUT_MIN_MS = 10_000
export const JOIN_TIMEOUT_MAX_MS = 900_000
/** The rig's bound. */
export const JOIN_TIMEOUT_DEFAULT_MS = 420_000

const REASON_RE = /^[a-z0-9-]{1,40}$/

function parseTimeout(v: string | undefined): number {
  if (v === undefined) return JOIN_TIMEOUT_DEFAULT_MS
  if (!/^\d{1,7}$/.test(v)) throw new NetworkVerbError('bad-arg', { argName: 'timeoutMs' })
  const n = Number(v)
  if (n < JOIN_TIMEOUT_MIN_MS || n > JOIN_TIMEOUT_MAX_MS) throw new NetworkVerbError('bad-arg', { argName: 'timeoutMs' })
  return n
}

const verifiers: SelfVoucherVerifiers = { verifyCadrePeerVoucher, verifyInvitationAdmission }
const cadre: AuthorityJoinCadre = { decodeCadreInvitation, mergeSeedPeers, verifyCadrePeerVoucher, verifyInvitationAdmission }

/** The join body, role-agnostic for any Authority device (officer today, keyholder through 67-28). */
export async function authorityJoin(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = checkArgs(args, {
    required: ['codeFile', 'expectName', 'expectFingerprintFile', 'networkHash'],
    optional: ['tokenFile', 'userName', 'timeoutMs']
  })
  assertNetworkParty(ctx)
  const networkHash = parseNetworkHash(a.networkHash)
  const timeoutMs = parseTimeout(a.timeoutMs)
  const text = ctx.secrets.add(readSecretSource(a.codeFile!), { windows: true })
  const fingerprint = ctx.secrets.add(readSecretSource(a.expectFingerprintFile!), { windows: true })
  const dec = decodeNetworkJoinCode(text)
  if (!dec.ok) throw new NetworkVerbError('preview-malformed')
  ctx.secrets.add(dec.code.invitation, { windows: true })
  if (dec.code.name !== a.expectName || dec.fingerprint !== fingerprint || dec.code.networkHash !== networkHash) {
    throw new NetworkVerbError('preview-mismatch')
  }
  const approval = resolveVerbApproval(a)
  const user = await ensureAuthorityUser(ctx, approval, { name: a.userName ?? 'vt authority' })
  const node = officerNode(ctx)
  const engine = officerEngine(ctx)
  const stores = ctx.built.stores
  const steps: string[] = []
  const t0 = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: AuthorityNetworkJoinResult
  try {
    result = await Promise.race([
      runAuthorityNetworkJoin({
        node,
        networksEngine: engine,
        user,
        code: dec.code,
        onStep: (step) => {
          steps.push(String(step))
        },
        cadre,
        stores: {
          rememberJoinBootstrap: (addrs) => stores.joinBootstrap.rememberJoinBootstrap(addrs),
          rememberJoinedNetwork: (hash) => stores.joinedNetworks.rememberJoinedNetwork(hash)
        }
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NetworkVerbError('join-timeout')), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const joinMs = Math.round(performance.now() - t0)
  if (!result.ok) {
    const reason = String(result.reason)
    throw new NetworkVerbError(REASON_RE.test(reason) ? `join-${reason}` : 'join-failed')
  }
  let ownerTrust: string | null = null
  const done = await completeAuthorityJoin({
    node,
    networkRef: result.networkRef,
    selectNetwork: async (ref) => {
      await engine.open(ref, user)
    },
    refreshOwnerTrust: async () => {
      ownerTrust = String(await readOwnerTrustClassification(node as unknown as OwnerTrustNode, 'persistent'))
    },
    verifiers
  })
  const peerId = node.peerId?.toString()
  const selfVouched = peerId === undefined ? false : await isSelfVouched(node as unknown as SelfVoucherNode, peerId, verifiers)
  return {
    networkHash8: networkHash.slice(0, 8),
    outcome: result.outcome,
    admittedVia: result.admittedVia,
    joinMs,
    steps,
    isJoinedNetwork: await stores.joinedNetworks.isJoinedNetwork(networkHash),
    selfVouched,
    trustSaved: done.trustSaved,
    ownerTrust,
    posture: ctx.posture
  }
}

export default authorityJoin
