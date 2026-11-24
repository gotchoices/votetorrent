// `vt officer dashboard-code`: a browser pairing code for the web dashboard, through the shared
// `startPairMintHost` (the owner side: this peer mints its own invitation) and `requestPairingCode`
// (the officer side: the signed pairing statement), signed by the 67-20 token signer over the officer
// key. The code goes to a created-once 0600 file under `secrets/`; the reply holds the path, `chars`
// and `expiresAt`. The nonce is never returned.
//
// The CLI does NOT call the app's `pairingCapability` (it gates on a P-256 device key; the officer key
// is secp256k1 by 67-20's decision). It gates on `startPairMintHost` returning a host: the owner branch
// only, as the lean rig's working dashboard path did. The host is memoized per node in a WeakMap (no
// secret in it) and detached through `ctx.onStop` when the context offers one; otherwise it ends with
// the daemon. The anchor port is bound here from `getJoinAnchor` under the `ReadPairingAnchor`
// contract (67-33 no-mirror audit: a port binding, not a copy of PairBrowserScreen's makeReadAnchor).

import { decodeCadreInvitation, encodeCadreInvitation } from '@serfab/cadre-core'
import {
  requestPairingCode,
  startPairMintHost,
  type InvitationCodec,
  type PairMintHost,
  type PairingNode,
  type ReadPairingAnchor,
  type RequestPairingCodeArgs
} from '@votetorrent/workflows/authority'
import { createAuthoritySigner, ensureAuthorityUser } from '../../network/authority-user.js'
import {
  NetworkVerbError,
  assertSecretTarget,
  checkArgs,
  officerEngine,
  officerNode,
  openKnownNetwork,
  parseNetworkHash,
  resolveVerbApproval,
  writeSecretFile,
  type NetworksEngineLike,
  type OfficerNode,
  type OfficerVerbContext
} from '../../network/network-verb-support.js'
import { createKvPairMintLog, createKvPairedBrowsers, createPairMintClientPort } from '../../network/pair-mint-ports.js'

interface HostEntry {
  host: PairMintHost
  current: { hash: string }
}

/** Per-node host state only (the node object -> its host and the hash it serves); never a secret. */
const hosts = new WeakMap<object, HostEntry>()

const invitationCodec: InvitationCodec = {
  decodeCadreInvitation: (encoded) => decodeCadreInvitation(encoded),
  encodeCadreInvitation: (invitation) => encodeCadreInvitation(invitation)
}

async function ensureHost(ctx: OfficerVerbContext, node: OfficerNode, hash: string): Promise<HostEntry | null> {
  const known = hosts.get(node)
  if (known !== undefined) {
    known.current.hash = hash
    return known
  }
  const current = { hash }
  const log = createKvPairMintLog(ctx.kv)
  const host = await startPairMintHost(node, {
    readOwnNetworkHash: async () => current.hash,
    isEnabled: async () => true,
    mintLog: log.mintLog,
    revocationStore: log.revocationStore,
    encodeInvitation: encodeCadreInvitation as (invitation: unknown) => string
  })
  if (host === null) return null
  const entry: HostEntry = { host, current }
  hosts.set(node, entry)
  ctx.onStop?.(() => host.detach())
  return entry
}

/** The anchor port: the four anchor fields on success; a rejection classified by `.code` only. */
function bindReadAnchor(engine: NetworksEngineLike, hash: string): ReadPairingAnchor {
  return async () => {
    try {
      const a = await engine.getJoinAnchor(hash)
      return { ok: true, anchor: { networkHash: a.networkHash, name: a.name, genesis: a.genesis, digest: a.digest } }
    } catch (e) {
      return { ok: false, anchor: (e as { code?: unknown } | null)?.code === 'network-not-open' ? 'not-open' : 'unreadable' }
    }
  }
}

export default async function dashboardCode(ctx: OfficerVerbContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = checkArgs(args, { required: ['networkHash', 'codeFile'], optional: ['tokenFile'] })
  const networkHash = parseNetworkHash(a.networkHash)
  const codeFile = assertSecretTarget(a.codeFile!)
  const approval = resolveVerbApproval(a)
  const user = await ensureAuthorityUser(ctx, approval, { name: 'vt officer' })
  await openKnownNetwork(ctx, networkHash, user)
  const engine = officerEngine(ctx)
  const db = engine.getEstablishedContext(networkHash)?.db
  if (db === undefined || db === null) throw new NetworkVerbError('network-not-open')
  const node = officerNode(ctx)
  const entry = await ensureHost(ctx, node, networkHash)
  if (entry === null) throw new NetworkVerbError('not-owner')
  const signer = createAuthoritySigner(ctx, approval, user)
  const paired = createKvPairedBrowsers(ctx.kv)
  const res = await requestPairingCode(
    {
      node: node as unknown as PairingNode,
      db: db as unknown as RequestPairingCodeArgs['db'],
      signer,
      networkHash,
      userId: user.id,
      keyPub: user.activeKeys[0]!.key,
      readAnchor: bindReadAnchor(engine, networkHash),
      localMint: (request) => entry.host.handleLocal(request),
      label: null
    },
    {
      recordPairedBrowser: (record) => paired.recordPairedBrowser(record),
      invitationCodec,
      pairMintClient: createPairMintClientPort({ readJoinBootstrap: () => ctx.built.stores.joinBootstrap.readJoinBootstrap() })
    }
  )
  if (!res.ok) throw new NetworkVerbError(`pairing-${res.reason}`, { detail: res.refusal === undefined ? undefined : `refused:${res.refusal}` })
  ctx.secrets.add(res.code, { windows: true })
  ctx.secrets.add(res.nonce, { windows: true })
  writeSecretFile(codeFile, res.code)
  return { codeFile, chars: res.code.length, expiresAt: res.expiresAt }
}
