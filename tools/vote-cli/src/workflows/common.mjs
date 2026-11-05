// Workflows both apps share: device status, joining a network from a join code, network details.

import { VE } from '../engine.mjs'

const { decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission } = await import('@serfab/cadre-core')

/** Voter app `isSelfAdmitted` / Authority app `isSelfVouched` (invitation branch). */
export async function isSelfAdmitted (node) {
  const store = node.getTrustedOwnerStore()
  const db = node.getControlDatabase()
  if (!store || !db) return false
  const selfId = node.peerId.toString()
  const self = (await db.queryCadrePeers()).find((row) => row.peerId === selfId)
  if (!self || !(self.vouchSig === null && self.vouchUsage != null)) return false
  const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()])
  const usage = usages.find((u) => u.usageStampId === self.vouchUsage)
  const invite = usage === undefined ? undefined : invites.find((i) => i.key === usage.inviteKey)
  if (usage === undefined || invite === undefined) return false
  return verifyInvitationAdmission(node.partyId, self, usage, invite, (key) => store.has(key))
}

function invitationExpiresAtMs (invitation) {
  const at = invitation?.invite?.expiresAt
  if (typeof at !== 'string' || at.length === 0) return null
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`)
  return Number.isFinite(ms) ? ms : null
}

const trailingPeerId = (addr) => addr.split('/p2p/').pop()

/** Authority app founder guard: a device that owns its own cadre may not join another one. */
async function founderGuard (node, code) {
  let invitation
  try { invitation = decodeCadreInvitation(code.invitation) } catch { return 'allow' }
  const db = node.getControlDatabase()
  if (!db) throw Object.assign(new Error('The owner check could not be read, so the network was not joined.'), { name: 'FounderGuardUnreadableError' })
  const owners = await db.getOwnerKeys()
  let selfKey = null
  try { selfKey = node.getIdentityOwnerKey().publicKeyB64 } catch { selfKey = null }
  const invited = Array.isArray(invitation?.ownerKeys) ? invitation.ownerKeys.filter((k) => typeof k === 'string') : []
  return selfKey !== null && owners.has(selfKey) && !invited.some((k) => owners.has(k)) ? 'refuse' : 'allow'
}

/**
 * JoinNetworkScreen -> runVoterNetworkJoin / runAuthorityNetworkJoin -> vote-engine joinNetwork:
 * redeem the invitation, open the strand once a peer is connected, accept only when the
 * replicated founding rows hash to the code's anchor digest, then select the network.
 */
export async function joinNetworkWorkflow (device, { code: text }) {
  if (typeof text !== 'string' || text.trim() === '') throw Object.assign(new Error('a join code is required'), { code: 'invalid-argument' })
  const decoded = VE.decodeNetworkJoinCode(text.trim())
  if (!decoded.ok) return { ok: false, reason: 'invalid-code', detail: decoded.reason ?? 'undecodable' }
  const { node } = device
  if (device.role === 'authority' && (await founderGuard(node, decoded.code)) === 'refuse') {
    return { ok: false, reason: 'founder-cannot-join', detail: 'founder-of-own-cadre' }
  }
  let members = []
  const steps = []
  const result = await VE.joinNetwork({
    node,
    networksEngine: device.networks,
    user: device.user,
    code: decoded.code,
    decodeInvitation: (encoded) => {
      const invitation = decodeCadreInvitation(encoded)
      members = Array.isArray(invitation.members) ? [...invitation.members] : []
      return invitation
    },
    invitationExpiresAtMs,
    isSelfAdmitted: () => isSelfAdmitted(node),
    afterFallbackAdmission: async () => {
      const controlNode = node.getControlNode()
      const memberIds = new Set(members.map(trailingPeerId).filter(Boolean))
      for (const conn of controlNode?.getConnections() ?? []) {
        if (memberIds.has(conn?.remotePeer?.toString())) await conn.close?.().catch(() => undefined)
      }
      const selfId = node.peerId.toString()
      const seeds = (await node.getControlDatabase()?.querySeedPeers().catch(() => [])) ?? []
      if (controlNode) await mergeSeedPeers(controlNode, seeds.filter((p) => p.peerId !== selfId)).catch(() => undefined)
      await node.refreshMembershipGate('invitation-redeemed')
      await node.reconcileControlCohort().catch(() => undefined)
    },
    rememberBootstrap: async () => { await device.local.setItem('joinBootstrap', members) },
    getPeerCount: () => device.peerCount(),
    onStep: (s) => { steps.push(s); device.log(`join step ${s}`) }
  })
  if (!result.ok) return { ...result, steps }
  const hash = result.networkRef.hash
  const joined = await device.joinedNetworks()
  if (!joined.includes(hash)) await device.local.setItem('joinedNetworks', [...joined, hash])
  await device.selectNetwork(hash)
  return {
    ok: true,
    outcome: result.outcome,
    admittedVia: result.admittedVia,
    fingerprint: result.fingerprint,
    network: { hash, name: result.networkRef.name },
    steps
  }
}

export async function statusWorkflow (device) {
  const recent = await device.networks.getRecentNetworks()
  return {
    role: device.role,
    profile: device.opts.profile,
    name: device.identity.name,
    userId: device.identity.userId,
    identityKey: device.identity.identityPublicHex,
    ...(device.role === 'voter' ? { votingKey: device.identity.votingPublicHex } : {}),
    peerId: device.node.peerId.toString(),
    addresses: device.addresses(),
    connections: device.peerCount(),
    currentNetwork: device.currentHash ?? null,
    recentNetworks: recent.map((r) => ({ hash: r.hash, name: r.name })),
    joinedNetworks: await device.joinedNetworks()
  }
}

/** NetworkDetailsScreen / the Voter's network card: `NetworkEngine.getDetails()`. */
export async function networkShowWorkflow (device) {
  device.requireNetwork()
  const details = await device.networkEngine.getDetails()
  return {
    hash: device.currentHash,
    name: details.network.name,
    primaryAuthorityId: details.network.primaryAuthorityId,
    revision: details.network.revision ?? details.current?.revision ?? null,
    relays: details.current?.relays ?? details.network.relays ?? [],
    details
  }
}
