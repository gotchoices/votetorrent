// The Authority app's workflows, one function per screen action, calling the same engine methods
// in the same order the screens do. File:line references point at the app code each one mirrors.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { VE, VC, ElectionsCreateElectionBuilder } from '../engine.mjs'
import { all, one } from '../device.mjs'

const { ElectionEvent, ElectionType, UserKeyType, isChecklistGateMet } = VC

/** apps/VoteTorrentAuthority/src/utils/foundingOfficerScopes.ts */
export const FOUNDING_OFFICER_SCOPES = ['rn', 'rad', 'vrg', 'iad', 'uai', 'ceb', 'mel', 'cap', 'ik']

const DAY_MS = 86_400_000
const THIRTY_DAYS_MS = 30 * DAY_MS
const KEYHOLDER_IDENTITY_KEY = 'vt.keyholder-identities.v1'
const KEYHOLDER_SIGNING_POLICY = { requireUserAuth: true }

function fail (code, message) {
  return Object.assign(new Error(message), { code })
}

function requireString (value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('invalid-argument', `--${name} is required`)
  return value.trim()
}

/** "+5m", "+2h", "+1d", "+30s", an ISO date, or epoch ms -> epoch ms. */
export function parseWhen (value, now = Date.now()) {
  if (typeof value === 'number') return value
  const s = String(value).trim()
  const rel = /^\+(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(s)
  if (rel) return now + Number(rel[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[rel[2]]
  if (/^\d{12,}$/.test(s)) return Number(s)
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) throw fail('invalid-argument', `cannot read time "${value}" (use +5m, +2h, an ISO date, or epoch ms)`)
  return ms
}

// ---------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------

/** AddNetworkScreen.tsx:232-449 -> NetworksEngine.buildCreate().update().commit(), then selectNetwork. */
export async function createNetwork (device, p) {
  const name = requireString(p.name, 'name')
  const relays = p.relay ? [].concat(p.relay) : device.addresses().filter((a) => a.includes('/ws'))
  const networkInit = {
    name,
    relays,
    primaryAuthority: { name: p.authorityName ?? `${name} Authority`, domainName: p.domain ?? 'authority.votetorrent.local' },
    admin: {
      officers: [{ init: { name: device.user.name, title: p.title ?? 'Chair', scopes: [...FOUNDING_OFFICER_SCOPES] } }],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }, { policy: 'mel', threshold: 1 }, { policy: 'ceb', threshold: 1 }]
    },
    policies: { timestampAuthorities: [], numberRequiredTSAs: 0, electionType: p.keyholders === false ? ElectionType.adhoc : ElectionType.official }
  }
  const builder = device.networks.buildCreate().update({ networkInit, user: device.user })
  if (!builder.isValid()) throw fail('invalid-network', builder.errors().map((e) => `${e.path}: ${e.code}`).join('; '))
  const before = new Set((await device.networks.getRecentNetworks()).map((r) => r.hash))
  // founder-intent.ts withFounding: a network this device creates opens its strand as founder.
  device.foundingIntent = true
  try {
    await builder.commit()
  } finally {
    device.foundingIntent = false
  }
  const ref = (await device.networks.getRecentNetworks()).find((r) => !before.has(r.hash))
  if (!ref) throw fail('create-unconfirmed', 'the network was created but is not in the recent list')
  await device.selectNetwork(ref.hash)
  const details = await device.networkEngine.getDetails()
  return { hash: ref.hash, name: ref.name, primaryAuthorityId: details.network.primaryAuthorityId, relays }
}

/** NetworkRevisionScreen.tsx:111 proposeRevision, then NetworkDetailsScreen.tsx:177 applyRevision. */
export async function reviseNetwork (device, p) {
  const ne = device.networkEngine
  device.requireNetwork()
  const current = await ne.getDetails()
  const revision = {
    name: p.name ?? current.network.name,
    relays: p.relay ? [].concat(p.relay) : current.network.relays,
    policies: current.network.policies
  }
  await ne.proposeRevision(revision)
  const proposed = await ne.getDetails()
  const proposal = proposed.proposed?.proposed
  const number = proposed.proposedRevision
  if (!proposal || number === undefined) {
    // NetworkEngine.getDetails reads ProposedNetwork `where Name = <current network name>`, so a
    // proposal that renames the network is stored but never surfaced — the app's Network Details
    // screen cannot show or apply it either.
    throw fail('no-proposal', revision.name !== current.network.name
      ? `the proposal renames the network ("${revision.name}"), and getDetails only surfaces proposals under the current name`
      : 'the revision proposal did not appear')
  }
  if (p.apply === false) return { proposed: true, revision: number }
  await ne.applyRevision(proposal.name, number, device.sign)
  const after = await ne.getDetails()
  return { applied: true, revision: number, name: after.network.name, relays: after.network.relays }
}

/**
 * VoterInviteCard.tsx:129-165 + voter-invite.ts: make sure this node can mint invitations
 * (ensureVoterInviteOwner), then encode a `vtjoin2.` code from the founding anchor and an
 * untargeted 1000-use, 30-day cadre invitation.
 */
export async function mintJoinCode (device, p) {
  const ctx = device.requireNetwork()
  void ctx
  const node = device.node
  const db = node.getControlDatabase()
  const owners = await db.getOwnerKeys()
  const owner = node.getIdentityOwnerKey()
  if (!owners.has(owner.publicKeyB64)) {
    await node.trustOwnerKeys([owner.publicKeyB64], 'operator')
    await db.ensureOwnerKey(owner.publicKeyB64)
    await node.initializeSeedBootstrap(owner.privateKeyB64)
  }
  const anchor = await device.networks.getFoundingAnchor(device.currentHash, { userId: device.user.id, signerKey: device.user.activeKeys[0].key })
  const minted = await node.createCadreInvitation({
    grantsOwner: false,
    uses: Number(p.uses ?? 1000),
    expiresInMs: p.days !== undefined ? Number(p.days) * DAY_MS : THIRTY_DAYS_MS
  })
  const code = VE.encodeNetworkJoinCode({ v: 2, invitation: minted.encoded, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest })
  return { code, fingerprint: anchor.fingerprint, expiresAt: minted.invitation?.invite?.expiresAt ?? null, chars: code.length }
}

// ---------------------------------------------------------------------------------------------
// Officers and invitations
// ---------------------------------------------------------------------------------------------

/** AdministratorInvitationScreen.tsx:146-200: createOfficerInvite + saveInviteWithSigning('rad'). */
export async function inviteOfficer (device, p) {
  const authority = await device.authority()
  const scopes = p.scopes ? String(p.scopes).split(',').map((s) => s.trim()).filter(Boolean) : [...FOUNDING_OFFICER_SCOPES]
  const invite = authority.createOfficerInvite({ name: requireString(p.name, 'name'), title: p.title ?? 'Officer', scopes })
  await authority.saveInviteWithSigning(invite, 'rad', device.sign)
  return {
    share: JSON.stringify({ invitePrivate: invite.invitePrivate, inviteKey: invite.inviteKey, inviteSignature: invite.inviteSignature, expiration: invite.expiration, type: invite.type, name: invite.name, title: p.title ?? 'Officer' }),
    inviteKey: invite.inviteKey
  }
}

/** invite-share.ts parseInviteShare + resolveInviteFromShare. */
async function resolveShare (invitations, text, expectedType) {
  let rec
  try { rec = JSON.parse(String(text).trim()) } catch { rec = /^[0-9a-f]{64}$/i.test(String(text).trim()) ? { invitePrivate: String(text).trim() } : undefined }
  if (!rec || typeof rec.invitePrivate !== 'string') throw fail('malformed', 'Invitation text is malformed')
  const inviteKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(rec.invitePrivate)))
  if (rec.inviteKey !== undefined && String(rec.inviteKey).toLowerCase() !== inviteKey) throw fail('malformed', 'Invitation key does not match its private key')
  if (rec.type !== undefined && rec.type !== expectedType) throw fail('wrong-type', 'Invitation is for a different role')
  const resolution = await invitations.resolveInviteSlot(inviteKey, expectedType)
  if (resolution.status === 'answered') throw fail('already-answered', 'Invitation has already been answered')
  if (resolution.status === 'no-longer-valid') throw fail('no-longer-valid', 'Invitation was withdrawn or has expired')
  if (resolution.status !== 'live') throw fail('not-found', 'Invitation not found on this device')
  return { slotCid: resolution.cid, invitePrivate: rec.invitePrivate }
}

/** AdministratorInvitationScreen.tsx:214-236 / AuthorityInvitationScreen.tsx:248-271: respondToInvite. */
export async function respondToInvite (device, p) {
  const type = p.type ?? 'of'
  if (type === 'k') return await acceptKeyholderInvite(device, p)
  const invitations = device.invitations()
  const { slotCid, invitePrivate } = await resolveShare(invitations, requireString(p.share, 'share'), type)
  const accept = p.decline !== true
  await invitations.respondToInvite(slotCid, accept, invitePrivate)
  return { slotCid, accepted: accept }
}

/** useCurrentOfficerScopes / EditOfficerScreen: AuthorityEngine.getAdminDetails(). */
export async function adminShow (device) {
  const authority = await device.authority()
  const details = await authority.getAdminDetails()
  const pending = await authority.getPendingInviteCids()
  return { ...details, pendingInviteCids: pending }
}

/** EditOfficerScreen.tsx:94-123 -> AuthorityEngine.proposeAdmin (threshold 1 promotes immediately). */
export async function adminSetScopes (device, p) {
  const authority = await device.authority()
  const details = await authority.getAdminDetails()
  const officers = details.admin.officers.map((o) => {
    const target = p.user ? o.userId === p.user : o.userId === device.user.id
    const scopes = target && p.scopes ? String(p.scopes).split(',').map((s) => s.trim()).filter(Boolean) : o.scopes
    return { userId: o.userId, name: o.name, title: target && p.title ? p.title : o.title, scopes }
  })
  await authority.proposeAdmin({
    proposed: { officers, effectiveAt: Date.now(), thresholdPolicies: details.admin.thresholdPolicies },
    signers: [device.user.id]
  }, device.sign)
  return (await authority.getAdminDetails()).admin
}

// ---------------------------------------------------------------------------------------------
// Officer intake key
// ---------------------------------------------------------------------------------------------

/** registration/officer-intake-key.ts:70-128: status, then register when missing. */
export async function registerIntakeKey (device) {
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const intake = device.intake()
  const before = await intake.getOfficerEncryptionKeyStatus(authorityId, device.vault)
  if (before.status === 'registered' || before.registered === true) return { authorityId, status: before }
  const registration = await intake.registerOfficerEncryptionKey(authorityId, device.vault, device.sign)
  const after = await intake.getOfficerEncryptionKeyStatus(authorityId, device.vault)
  return { authorityId, registration, status: after }
}

// ---------------------------------------------------------------------------------------------
// Elections and ballots
// ---------------------------------------------------------------------------------------------

/**
 * CreateElectionScreen.tsx:150-292. The timeline is the app's 10-event timeline; the strict chain
 * (votingStarts < accruingVotes < … < closed) is enforced like findTimelineOrderViolation. Times
 * accept +5m / +2h / ISO; the defaults are the screen's (registration ends +2d, ballots final +5d,
 * voting starts +10d, each later event one more day).
 */
export async function createElection (device, p) {
  const ctx = device.requireNetwork()
  void ctx
  const now = Date.now()
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const votingStarts = parseWhen(p.votingStarts ?? '+10d', now)
  const votingMs = p.votingMinutes !== undefined ? Number(p.votingMinutes) * 60_000 : DAY_MS
  const stepMs = p.stepSeconds !== undefined ? Number(p.stepSeconds) * 1000 : DAY_MS
  const accruingVotes = votingStarts + votingMs
  const timeline = {
    [ElectionEvent.registrationEnds]: parseWhen(p.registrationEnds ?? '+2d', now),
    [ElectionEvent.ballotsFinal]: parseWhen(p.ballotsFinal ?? '+5d', now),
    [ElectionEvent.votingStarts]: votingStarts,
    [ElectionEvent.accruingVotes]: accruingVotes,
    [ElectionEvent.hashingVotes]: accruingVotes + stepMs,
    [ElectionEvent.releasingKeys]: p.releasingKeys !== undefined ? parseWhen(p.releasingKeys, now) : accruingVotes + 2 * stepMs,
    [ElectionEvent.tallyingStarts]: accruingVotes + 3 * stepMs,
    [ElectionEvent.validation]: accruingVotes + 4 * stepMs,
    [ElectionEvent.certificationStarts]: accruingVotes + 5 * stepMs,
    [ElectionEvent.closed]: accruingVotes + 6 * stepMs
  }
  const chain = Object.values(ElectionEvent).filter((e) => e !== ElectionEvent.registrationEnds && e !== ElectionEvent.ballotsFinal)
  for (let i = 0; i < chain.length - 1; i++) {
    if (timeline[chain[i]] >= timeline[chain[i + 1]]) throw fail('timeline-order', `${chain[i]} must be before ${chain[i + 1]}`)
  }
  const date = p.date !== undefined ? parseWhen(p.date, now) : Math.max(now + 11 * DAY_MS, timeline[ElectionEvent.closed])
  const revisionDeadline = p.revisionDeadline !== undefined ? parseWhen(p.revisionDeadline, now) : date
  const ballotDeadline = now + 10 * DAY_MS
  if (revisionDeadline > date) throw fail('invalid-argument', 'the revision deadline must not be after the election date')
  if (ballotDeadline > date) throw fail('invalid-argument', 'the election date must be at least 10 days out (ballot deadline)')
  const electionId = p.id ?? `election-${now}`
  const title = requireString(p.title, 'title')
  const type = p.adhoc ? ElectionType.adhoc : ElectionType.official
  const threshold = Math.max(0, Math.trunc(Number(p.threshold ?? 1)))
  const tags = p.tags ? String(p.tags).split(',') : []
  const instructions = p.instructions ?? `# ${title}`
  const keyholders = p.keyholders ? String(p.keyholders).split(',').map((name) => name.trim()).filter(Boolean) : []

  const elections = device.elections()
  const electionFields = { id: electionId, authorityId, title, date, revisionDeadline, ballotDeadline, type }
  const revisionInit = {
    electionId,
    revision: 0,
    revisionTimestamp: now - 1000,
    tags,
    instructions,
    keyholders: keyholders.map((name) => ({ name, type: 'k', expiration: '0', inviteKey: '', invitePrivate: '', inviteSignature: '', digest: '' })),
    timeline,
    keyholderThreshold: threshold
  }
  // The builder is immutable: each setter returns a new builder (CreateElectionScreen chains them).
  const builder = new ElectionsCreateElectionBuilder(elections).setElection(electionFields).setRevision(revisionInit)
  if (!builder.isValid()) throw fail('invalid-election', builder.errors().map((e) => `${e.path} ${e.code}: ${e.message}`).join('; '))
  const payload = builder.build()
  const signingNonce = await elections.seedElectionSigning(electionFields, device.sign)
  const revTid = (await elections.peekNextTid()) + 1
  const revisionSigningNonce = await elections.seedElectionRevisionSigning(electionId, authorityId, {
    revision: 0, revisionTimestamp: now - 1000, tags, instructions, timeline, keyholderThreshold: threshold
  }, revTid, device.sign)
  await elections.createElection(payload, { signingNonce, revisionSigningNonce })
  return { electionId, title, timeline: isoTimeline(timeline), keyholderThreshold: threshold }
}

export function isoTimeline (timeline) {
  return Object.fromEntries(Object.entries(timeline).map(([k, v]) => [k, typeof v === 'number' ? new Date(v).toISOString() : v]))
}

export async function listElections (device) {
  const elections = device.elections()
  const list = await elections.getElections()
  return list.map((e) => ({ id: e.id, title: e.title, date: e.date }))
}

/** The current election: `--election`, else the only (or newest) election on the network. */
export async function resolveElectionId (device, p) {
  if (p.election) return p.election
  const list = await device.elections().getElections()
  if (list.length === 0) throw fail('no-election', 'this network has no election yet')
  return list[list.length - 1].id
}

export async function showElection (device, p) {
  const electionId = await resolveElectionId(device, p)
  const engine = await device.election(electionId)
  const details = await engine.getElectionDetails()
  const ballots = await engine.getBallots()
  const ballotStates = await Promise.all(ballots.map(async (b) => ({ id: b.id, description: b.description, ...(await engine.getBallotConfirmationState(b.id)) })))
  const timeline = parseTimeline(details.current?.timeline)
  return {
    electionId,
    title: details.election.title,
    revision: details.current?.revision,
    keyholderThreshold: details.current?.keyholderThreshold,
    keyholders: (details.current?.keyholders ?? []).map((k) => ({ name: k.name, userId: k.userId ?? k.invokedId ?? null })),
    timeline: timeline ? isoTimeline(timeline) : null,
    phase: timeline ? phaseAt(timeline, Date.now()) : 'indeterminate',
    ballots: ballotStates
  }
}

export function parseTimeline (raw) {
  if (raw == null) return null
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
  return raw
}

/** apps/VoteTorrentVoter/src/engines/election-read.ts STAGE_LIFECYCLE. */
const STAGE_LIFECYCLE = {
  registrationEnds: 'Upcoming',
  ballotsFinal: 'Upcoming',
  votingStarts: 'Open',
  accruingVotes: 'ReleasingKeys',
  hashingVotes: 'ReleasingKeys',
  releasingKeys: 'ReleasingKeys',
  tallyingStarts: 'Validation',
  validation: 'Validation',
  certificationStarts: 'Validation',
  closed: 'Complete'
}

/** The Voter app's lifecycle state at `now`: ui-web timeline-core `finestStage` (the LAST event in
 * timeline order whose instant has passed) mapped through STAGE_LIFECYCLE. 'Open' = voting open. */
export function phaseAt (t, now) {
  let stage = null
  for (const event of Object.values(ElectionEvent)) {
    if (typeof t[event] === 'number' && now >= t[event]) stage = event
  }
  return stage === null ? 'Upcoming' : STAGE_LIFECYCLE[stage]
}

/**
 * CreateBallotScreen.tsx:165 -> ElectionEngine.proposeBallot. Questions come from `--question`
 * strings: `code|title|opt1,opt2[,…][|voteFor]`, or from a JSON `questions` array.
 */
export async function proposeBallot (device, p) {
  const electionId = await resolveElectionId(device, p)
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const questions = Array.isArray(p.questions)
    ? p.questions
    : [].concat(p.question ?? []).map((spec, i) => {
        const [code, title, opts, voteFor] = String(spec).split('|')
        const options = String(opts ?? '').split(',').map((o) => o.trim()).filter(Boolean)
        if (!code || !title || options.length < 2) throw fail('invalid-argument', `--question "${spec}" must be code|title|opt1,opt2[,…][|voteFor]`)
        const max = Math.max(1, Number(voteFor ?? 1))
        return {
          code, title, instructions: '', type: 'select', optionRange: { min: 1, max }, group: 'General', sequence: i, required: true,
          options: options.map((o) => ({ code: o, title: o, details: '' }))
        }
      })
  if (questions.length === 0) throw fail('invalid-argument', 'a ballot needs at least one --question')
  const ballot = {
    id: p.id ?? crypto.randomUUID(),
    electionId,
    authorityId,
    description: p.description ?? 'Ballot',
    districts: p.districts ? String(p.districts).split(',') : [],
    questions
  }
  const engine = await device.election(electionId)
  await engine.proposeBallot(ballot)
  return { ballotId: ballot.id, electionId, questions: questions.map((q) => ({ code: q.code, options: q.options.map((o) => o.code) })) }
}

/** EditBallotScreen.tsx:276 -> submitBallotForConfirmation (opens the officer 'ballot' signing task). */
export async function submitBallot (device, p) {
  const electionId = await resolveElectionId(device, p)
  const engine = await device.election(electionId)
  const ballotId = requireString(p.ballot, 'ballot')
  const state = await engine.getBallotConfirmationState(ballotId)
  if (!state.locked && !state.confirmed) await engine.submitBallotForConfirmation(ballotId, device.sign)
  return { ballotId, ...(await engine.getBallotConfirmationState(ballotId)) }
}

// ---------------------------------------------------------------------------------------------
// Signature tasks
// ---------------------------------------------------------------------------------------------

function taskView (t) {
  return {
    signatureType: t.signatureType,
    ...(t.requestId ? { requestId: t.requestId } : {}),
    ...(t.ballot?.proposed?.id ? { ballotId: t.ballot.proposed.id } : {}),
    ...(t.nonce ? { nonce: t.nonce } : {}),
    ...(t.name ? { name: t.name } : {})
  }
}

/** TasksScreen.tsx:76-82: requested signatures + keys to release. */
export async function listTasks (device) {
  const signatures = await device.signatureTasks().getRequestedSignatures(true)
  const keys = await device.keysTasks().getKeysToRelease(true).catch(() => [])
  return { signatures: signatures.map(taskView), keyReleases: keys.map((k) => ({ electionId: k.election?.election?.id, userId: k.userId })) }
}

/** SignatureTaskScreen.tsx:100-160: digest -> device signature -> completeSignature. */
export async function signTask (device, p) {
  const tasks = device.signatureTasks()
  const pending = await tasks.getRequestedSignatures(true)
  const task = pending.find((t) =>
    (p.ballot && t.signatureType === 'ballot' && t.ballot?.proposed?.id === p.ballot) ||
    (p.request && t.signatureType === 'registrant' && t.requestId === p.request) ||
    (p.nonce && t.nonce === p.nonce))
  if (!task) throw fail('no-task', 'no pending signature task matches')
  if (p.reject === true) {
    await tasks.completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
    return { task: taskView(task), accepted: false }
  }
  const digest = await tasks.getSignatureDigest(task)
  const signature = await device.sign(digest)
  const needsSign = task.signatureType === 'ballot' || task.signatureType === 'admin'
  await tasks.completeSignature(task, { isAccepted: true, signature, sign: needsSign ? device.sign : undefined })
  return { task: taskView(task), accepted: true }
}

/** EditBallotScreen submit + SignatureTaskScreen sign, the two officer steps that confirm a ballot. */
export async function confirmBallot (device, p) {
  const submitted = await submitBallot(device, p)
  if (submitted.confirmed) return submitted
  await signTask(device, { ballot: p.ballot })
  const engine = await device.election(await resolveElectionId(device, p))
  return { ballotId: p.ballot, ...(await engine.getBallotConfirmationState(p.ballot)) }
}

// ---------------------------------------------------------------------------------------------
// Registration policy, intake and review
// ---------------------------------------------------------------------------------------------

/** RegistrationPolicyScreen.tsx: addElectionRegistrationField. */
export async function addRegistrationField (device, p) {
  const electionId = await resolveElectionId(device, p)
  await device.registration().addElectionRegistrationField({
    electionId,
    fieldName: requireString(p.field, 'field'),
    tier: p.tier ?? 'public',
    requirement: p.requirement ?? 'required'
  }, device.sign)
  return { electionId, fields: await device.registration().getElectionRegistrationFields(electionId) }
}

function peerStagingTransports (device, { opener, decisionSigner }) {
  const refuse = async () => { throw new Error('The authority app never submits staged requests') }
  const openStrand = async () => device.strandPort()
  const strandId = device.currentHash
  return {
    registration: new VE.P2pRegistrationTransport({ openStrand, computeDigest: refuse, strandId, opener, decisionSigner }),
    association: new VE.P2pAssociationTransport({ openStrand, computeDigest: refuse, computeAttestationDigest: refuse, strandId, opener, decisionSigner })
  }
}

const countable = (report) => report.unreadable.filter((r) => r.reason !== 'not-a-recipient').map((r) => r.requestId)

/**
 * attach-peer-sync-binding.ts syncNow (the "Sync Now" peer binding): (a) intake staged
 * registration requests, (b) publish undecided-but-decided registration decisions, (c) intake
 * association requests and attestation answers, then process them (challenge / associate).
 */
export async function syncRegistrations (device) {
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const opener = device.intake().createOpener(device.vault)
  const decisionSigner = { authorityId, sign: device.sign }
  const { registration, association } = peerStagingTransports(device, { opener, decisionSigner })
  const reg = device.registration()
  const errors = []
  let imported = 0
  let decisionsPublished = 0
  const regReport = await registration.readStagedRequestsReport()
  errors.push(...countable(regReport))
  const regDocs = regReport.delivered.filter((d) => d.init.authorityId === authorityId)
  for (const doc of regDocs) {
    if (await reg.getRegistrationRequest(doc.requestId)) continue
    try {
      await reg.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)
      imported++
    } catch (e) {
      errors.push(`${doc.requestId}: ${e.code ?? e.name}`)
    }
  }
  const publisher = { authorityId, publishDecision: (decision) => registration.publishDecision(decision) }
  for (const requestId of await reg.listUnpublishedRegistrationDecisions(authorityId)) {
    try {
      await reg.publishRegistrationDecision(publisher, requestId)
      decisionsPublished++
    } catch (e) {
      if (e?.code !== 'duplicate-decision') errors.push(`${requestId}: ${e.code ?? e.name}`)
    }
  }
  await reg.completeDuplicateClosures(publisher).catch(() => undefined)

  const assoc = device.association()
  const reqReport = await association.readStagedRequestsReport()
  const attReport = await association.readStagedAttestationsReport()
  errors.push(...countable(reqReport), ...countable(attReport))
  const assocDocs = reqReport.delivered.filter((d) => d.init.authorityId === authorityId)
  for (const doc of assocDocs) {
    if ((await assoc.getAssociationRequest(doc.requestId)) !== undefined) continue
    try {
      await assoc.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)
      imported++
    } catch (e) {
      errors.push(`${doc.requestId}: ${e.code ?? e.name}`)
    }
  }
  for (const doc of attReport.delivered) {
    const row = await assoc.getAssociationRequest(doc.requestId)
    if (row === undefined || row.status !== 'c') continue
    try {
      await assoc.submitAssociationAttestation(doc.answer, doc.requesterKey, doc.signature)
      imported++
    } catch (e) {
      errors.push(`${doc.requestId}: ${e.code ?? e.name}`)
    }
  }
  let processed = null
  try {
    processed = await assoc.processPendingAssociationRequests(authorityId, device.sign, association)
  } catch (e) {
    errors.push(`processPendingAssociationRequests: ${e.code ?? e.name}: ${e.message}`)
  }
  await assoc.processPendingReassociations(authorityId, device.sign, association, opener).catch((e) => errors.push(`processPendingReassociations: ${e.code ?? e.name}`))
  return {
    imported,
    decisionsPublished,
    associations: processed,
    pendingRegistrations: (await reg.listRegistrationRequests({ authorityId, status: 'p' })).rows.length,
    errors
  }
}

/** RegistrationInboxScreen.tsx:164-276: listRegistrationRequests. */
export async function listRegistrationRequests (device, p) {
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const result = await device.registration().listRegistrationRequests({ authorityId, ...(p.status ? { status: p.status } : {}) })
  return result.rows.map((r) => ({ requestId: r.requestId, status: r.status, issuerType: r.issuerType, submittedAt: r.submittedAt, receivedAt: r.receivedAt, name: [r.firstName, r.lastName].filter(Boolean).join(' ') || null }))
}

/**
 * RegistrationRequestApprovalScreen.tsx:489-571: find the 'registrant' task for THIS request,
 * sign its digest, completeSignature with the checklist bound into the decision, then publish the
 * decision to the strand (continuity-review.ts publishRegistrationDecisionAfterDecide).
 */
export async function approveRegistration (device, p) {
  const requestId = requireString(p.request, 'request')
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const reg = device.registration()
  const read = await reg.getRegistrationRequest(requestId)
  if (!read) throw fail('not-found', `registration request ${requestId} is not imported (run \`registration sync\`)`)
  if (read.status !== 'p') return { requestId, status: read.status, note: 'already decided' }
  const checklist = p.checklist ? String(p.checklist).split(',') : (read.verificationChecklist?.length ? read.verificationChecklist : ['id', 'roll', 'eligibility'])
  if (!isChecklistGateMet(checklist)) throw fail('checklist-incomplete', 'the verification checklist gate is not met')
  const tasks = device.signatureTasks()
  const task = (await tasks.getRequestedSignatures(true)).find((t) => t.signatureType === 'registrant' && t.requestId === requestId)
  if (!task) throw fail('no-task', `no registrant signing task for ${requestId}`)
  const digest = await tasks.getSignatureDigest(task)
  const signature = await device.sign(digest)
  await tasks.completeSignature(task, { isAccepted: true, signature, sign: device.sign, decision: { checklist } })
  const after = await reg.getRegistrationRequest(requestId)
  let published = null
  if (after?.status === 'a' || after?.status === 'r') {
    const opener = device.intake().createOpener(device.vault)
    const { registration } = peerStagingTransports(device, { opener, decisionSigner: { authorityId, sign: device.sign } })
    const publisher = { authorityId, publishDecision: (decision) => registration.publishDecision(decision) }
    published = await reg.publishRegistrationDecision(publisher, requestId, { closesRequestId: null }).catch((e) => ({ failed: e.code ?? e.name }))
  }
  return { requestId, status: after?.status, registrantId: after?.registrantId ?? read.payload?.registrant?.id ?? null, published }
}

/** RegistrationRequestApprovalScreen.tsx:587-666: rejectRegistrationRequest, blank task, publish. */
export async function rejectRegistration (device, p) {
  const requestId = requireString(p.request, 'request')
  const reg = device.registration()
  await reg.rejectRegistrationRequest(requestId, { checklist: ['none'], rejectionReason: p.reason ?? 'rejected' }, device.sign)
  const tasks = device.signatureTasks()
  const task = (await tasks.getRequestedSignatures(true)).find((t) => t.signatureType === 'registrant' && t.requestId === requestId)
  if (task) await tasks.completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
  return { requestId, status: (await reg.getRegistrationRequest(requestId))?.status }
}

/** RegistrantsListScreen.tsx:183 + AssociationsSection: registrants and their device associations. */
export async function listRegistrants (device) {
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const result = await device.registration().listRegistrants({ authorityId })
  const assoc = device.association()
  return await Promise.all(result.rows.map(async (r) => ({
    registrantId: r.registrantId,
    status: r.status,
    name: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    associations: (await assoc.getAssociations(r.registrantId)).map((a) => ({ deviceKey: a.deviceKey }))
  })))
}

// ---------------------------------------------------------------------------------------------
// Keyholders, DKG, key release
// ---------------------------------------------------------------------------------------------

/** KeyholderInvitationScreen.tsx:130-200: ephemeral invite key, inviteKeyholder, share text. */
export async function inviteKeyholder (device, p) {
  const electionId = await resolveElectionId(device, p)
  const engine = await device.election(electionId)
  const sk = secp256k1.utils.randomSecretKey()
  const invitePrivate = bytesToHex(sk)
  const inviteKey = bytesToHex(secp256k1.getPublicKey(sk))
  const hours = Number(p.hours ?? 24)
  const expiration = new Date(Date.now() + hours * 3_600_000).toISOString()
  const name = requireString(p.name, 'name')
  await engine.inviteKeyholder({ type: 'k', expiration, inviteKey, inviteSignature: '', name }, electionId, device.sign)
  return { electionId, share: JSON.stringify({ invitePrivate, inviteKey, expiration, type: 'k', name }) }
}

async function keyholderIdentities (device) {
  const raw = await device.local.getItem(KEYHOLDER_IDENTITY_KEY)
  return raw?.identities ?? []
}

/**
 * keyholder-accept.ts acceptKeyholderInvitation + keyholder-identity.ts provisionKeyholderIdentity:
 * resolve the share, refuse a self-invite or a second seat, provision a fresh signing key and DKG
 * receiving key into the vault, then respondToInvite with the provisioning.
 */
export async function acceptKeyholderInvite (device, p) {
  const invitations = device.invitations()
  const { slotCid, invitePrivate } = await resolveShare(invitations, requireString(p.share, 'share'), 'k')
  const seat = await invitations.getKeyholderSlotSeat(slotCid)
  if (!seat) throw fail('not-found', 'Invitation not found on this device')
  if (seat.selfInvite) throw fail('self-invite', 'The officer who sent this keyholder invitation cannot accept it')
  for (const held of await keyholderIdentities(device)) {
    const heldSeat = await invitations.getKeyholderSlotSeat(held.inviteSlotCid)
    if (!heldSeat || heldSeat.electionId !== seat.electionId) continue
    const heldStatus = await invitations.getKeyholderInvite(held.inviteSlotCid)
    const committed = heldStatus?.result?.isAccepted === true && heldStatus.result.invokedId === held.userId
    if (!committed) {
      // keyholder-accept.ts: an identity whose invite was answered by someone else is discarded.
      if (heldStatus?.result !== undefined) await discardKeyholderIdentity(device, held.userId)
      continue
    }
    throw fail('seat-already-held', 'This device already holds a keyholder seat for this election')
  }
  const userId = crypto.randomUUID()
  const signingPriv = secp256k1.utils.randomSecretKey()
  const signingPublicKey = bytesToHex(secp256k1.getPublicKey(signingPriv, true))
  const receiving = VE.generateDkgReceivingKey()
  await device.vault.putSecret(`vt.keyholder-signing.${userId}`, signingPriv, KEYHOLDER_SIGNING_POLICY)
  await device.vault.putSecret(VE.keyholderDkgReceivingKeyAlias(userId), receiving.privateKey, VE.KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
  const record = { v: 1, userId, inviteSlotCid: slotCid, electionId: seat.electionId, signingPublicKey, signingKeyType: 'M', dkgReceivingPublicKey: receiving.publicKey, createdAt: new Date().toISOString() }
  await device.local.setItem(KEYHOLDER_IDENTITY_KEY, { v: 1, identities: [...await keyholderIdentities(device), record] })
  const provisioning = {
    signingKey: { key: signingPublicKey, type: UserKeyType.mobile, expiration: Date.now() + 10 * 365 * DAY_MS },
    dkgPublicKey: receiving.publicKey,
    sign: async (digest) => ({ signature: bytesToHex(secp256k1.sign(digest, signingPriv)), signerKey: signingPublicKey, signerUserId: userId })
  }
  try {
    await invitations.respondToInvite(slotCid, true, invitePrivate, undefined, userId, provisioning)
    return { userId, slotCid, electionId: seat.electionId }
  } catch (originalError) {
    // keyholder-accept.ts: re-read once — the accept may have committed before the error — and
    // otherwise discard the freshly provisioned identity so it can never sign for this seat.
    let reread
    try { reread = await invitations.getKeyholderInvite(slotCid) } catch { throw originalError }
    if (reread?.result?.isAccepted === true && reread.result.invokedId === userId) return { userId, slotCid, electionId: seat.electionId }
    await discardKeyholderIdentity(device, userId).catch(() => undefined)
    throw originalError
  } finally {
    signingPriv.fill(0)
  }
}

/** keyholder-identity.ts discardKeyholderIdentity: both vault aliases, then the record. */
async function discardKeyholderIdentity (device, userId) {
  await device.vault.deleteSecret(`vt.keyholder-signing.${userId}`)
  await device.vault.deleteSecret(VE.keyholderDkgReceivingKeyAlias(userId))
  const next = (await keyholderIdentities(device)).filter((r) => r.userId !== userId)
  await device.local.setItem(KEYHOLDER_IDENTITY_KEY, { v: 1, identities: next })
}

/** keyholder-identity.ts createKeyholderSigner: the signing key comes out of the vault per use. */
function keyholderSigner (device, identity) {
  return {
    userId: identity.userId,
    signingPublicKey: identity.signingPublicKey,
    sign: async (digest) => {
      const priv = await device.vault.getSecret(`vt.keyholder-signing.${identity.userId}`)
      if (priv === null) throw fail('signing-key-missing', `no signing key for keyholder ${identity.userId}`)
      try {
        return { signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: identity.signingPublicKey, signerUserId: identity.userId }
      } finally {
        priv.fill(0)
      }
    }
  }
}

async function keyholderFor (device, electionId) {
  const ids = (await keyholderIdentities(device)).filter((i) => !electionId || i.electionId === electionId)
  if (ids.length === 0) throw fail('not-a-keyholder', 'this device holds no keyholder seat for that election')
  return ids[0]
}

/** KeyholderScreen focus -> keyholder-dkg-driver.ts: getDkgStatus. */
export async function dkgStatus (device, p) {
  const electionId = await resolveElectionId(device, p)
  const identity = await keyholderFor(device, electionId).catch(() => undefined)
  const status = await device.keyholderDkg().getDkgStatus(electionId, identity?.userId)
  const key = await device.keyholderDkg().getElectionKey(electionId).catch(() => null)
  return { electionId, status, electionKey: key ? { jointPublicKey: key.jointPublicKey, revision: key.revision } : null }
}

const actionName = (a) => (typeof a === 'string' ? a : a.kind ?? a.type ?? JSON.stringify(a))

/** keyholder-dkg-driver.ts driveKeyholderDkg: read the status, advance ONE step only when it is
 * due for this keyholder, and report (never throw) a failed step — the screen retries on its next
 * focus. */
async function driveKeyholderDkg (device, electionId, identity) {
  const dkg = device.keyholderDkg()
  const local = await device.vault.hasSecret(`vt.keyholder-signing.${identity.userId}`)
  const status = await dkg.getDkgStatus(electionId, local ? identity.userId : undefined)
  const due = local &&
    (status.phase === 'not-started' || status.phase === 'in-progress' || status.phase === 'restarting') &&
    status.self?.isParticipant === true && status.self?.isDisqualified !== true
  if (!due) return { status, advanced: false, actions: [] }
  try {
    const result = await dkg.advanceDkg(electionId, keyholderSigner(device, identity))
    return { status: result.status, advanced: true, actions: result.actions ?? [] }
  } catch (err) {
    return { status, advanced: false, actions: [], error: { code: typeof err?.code === 'string' ? err.code : 'unknown' } }
  }
}

/**
 * One driver pass, as one keyholder screen focus. `--until-done` repeats it every `--interval`
 * seconds, as a keyholder re-opening the screen does while the other keyholders' messages
 * replicate in, until the election key exists or `--timeout` passes. Step errors are returned,
 * not hidden.
 */
export async function advanceDkg (device, p) {
  const electionId = await resolveElectionId(device, p)
  const identity = await keyholderFor(device, electionId)
  const dkg = device.keyholderDkg()
  const deadline = Date.now() + Number(p.timeout ?? 180) * 1000
  const interval = Number(p.interval ?? 1.5) * 1000
  const actions = []
  const stepErrors = []
  let passes = 0
  let last
  for (;;) {
    passes++
    last = await driveKeyholderDkg(device, electionId, identity)
    actions.push(...last.actions.map(actionName))
    if (last.error) stepErrors.push(last.error.code)
    const key = await dkg.getElectionKey(electionId).catch(() => null)
    if (key?.jointPublicKey || p.untilDone !== true) {
      return { electionId, userId: identity.userId, done: Boolean(key?.jointPublicKey), phase: last.status?.phase ?? null, passes, actions, stepErrors, jointPublicKey: key?.jointPublicKey ?? null }
    }
    if (Date.now() > deadline) {
      throw fail('dkg-timeout', `the election key did not form within ${p.timeout ?? 180} s (phase ${last.status?.phase}; actions: ${actions.join(', ') || 'none'}; step errors: ${stepErrors.join(', ') || 'none'})`)
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** KeyReleaseScreen.tsx:50 -> key-release-ceremony.ts: getKeysToRelease + completeKeyRelease. */
export async function releaseKey (device, p) {
  const electionId = await resolveElectionId(device, p)
  const identity = await keyholderFor(device, electionId)
  const tasks = device.keysTasks()
  const pending = await tasks.getKeysToRelease(true)
  const task = pending.find((t) => t.userId === identity.userId && t.election?.election?.id === electionId)
  if (!task) throw fail('no-release-task', 'no key-release task yet (the releasingKeys window may not be open)')
  await tasks.completeKeyRelease(task, keyholderSigner(device, identity))
  return { electionId, userId: identity.userId, released: true, status: await device.keyRelease().getKeyReleaseStatus(electionId, identity.userId) }
}

/**
 * CLI-only verification (no app screen does this yet — the post-release tally has no table):
 * reconstruct the election key from the released shares, open every committed VoteBlock and
 * count the decrypted vote entries per ballot/question/option.
 */
export async function electionResults (device, p) {
  const electionId = await resolveElectionId(device, p)
  const db = device.ctx().db
  const release = device.keyRelease()
  const recon = await release.reconstructElectionKey(electionId)
  const keyRow = await one(db, 'select ElectionRevision as revision, JointPublicKey as jointPublicKey from ElectionKey where ElectionId = :e order by ElectionRevision desc', { e: electionId })
  const electionKey = { electionId, revision: Number(keyRow.revision), jointPublicKey: keyRow.jointPublicKey }
  const blocks = await all(db, 'select Id, Cid, BallotId, Ciphertext, EntryCount from VoteBlock where ElectionId = :e', { e: electionId })
  const tally = {}
  const opened = []
  for (const block of blocks) {
    const result = VE.openElectionBlock(recon.secretKey, electionKey, { blockId: block.Id, ciphertext: block.Ciphertext })
    if (!result.ok) { opened.push({ blockCid: block.Cid, ok: false, reason: result.reason }); continue }
    const votes = VE.openVoteEntries(recon.secretKey, electionKey, block.BallotId, result.payload)
    opened.push({ blockCid: block.Cid, ballotId: block.BallotId, entries: Number(block.EntryCount), opened: votes.filter((v) => v.ok).length })
    for (const v of votes) {
      if (!v.ok) continue
      const vote = JSON.parse(v.voteEntryJson)
      for (const answer of vote.answers ?? []) {
        for (const option of answer.optionCodes ?? []) {
          const key = `${vote.ballotId}/${answer.questionCode}`
          tally[key] ??= {}
          tally[key][option] = (tally[key][option] ?? 0) + 1
        }
      }
    }
  }
  const voters = await one(db, 'select count(*) as n from VoteBlockVoter where ElectionId = :e', { e: electionId })
  return { electionId, blocks: opened, voterRows: Number(voters?.n ?? 0), tally }
}
