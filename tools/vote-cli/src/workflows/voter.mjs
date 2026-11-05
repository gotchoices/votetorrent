// The Voter app's workflows, mirroring the screens and engines/*.ts helpers they call. The voting
// key is a software P-256 key (identity.json) standing in for the Keystore key; the vote record is
// sealed in the same envelope shape vote-record-vault.ts writes, with a software wrap key.

import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { VE } from '../engine.mjs'
import { one, softwareProducer } from '../device.mjs'
import { isoTimeline, parseTimeline, phaseAt, resolveElectionId } from './authority.mjs'

const { multiaddr } = await import('@multiformats/multiaddr')

const DECISION_WAIT_DEADLINE_MS = 180_000
const DECISION_POLL_INTERVAL_MS = 2_000
const IGNORED_EXPIRATION_PLACEHOLDER = new Date(0).toISOString()
const VOTE_RECORD_AAD_PREFIX = 'votetorrent-vote-record-v1:'

function fail (code, message) {
  return Object.assign(new Error(message), { code })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function base64UrlDigestToBytes (value, site) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`digest is not a 32-byte base64url value (${site})`)
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length !== 32) throw new Error(`digest is not 32 bytes (${site})`)
  return new Uint8Array(bytes)
}

// ---------------------------------------------------------------------------------------------
// Request transports (engines/voter-request-transports.ts + strand-port-adapter.ts)
// ---------------------------------------------------------------------------------------------

function registrationRequestDigestFn (port) {
  return async (init, requesterKey) => {
    const payloadCid = (await port.query('select Digest(:payload) as d', { payload: JSON.stringify(init.payload) }))[0]?.d
    if (payloadCid == null) throw new Error('Digest() returned null for Payload')
    const rows = await port.query('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d', {
      id: init.id, rowAuthorityId: init.authorityId, requesterKey, issuerType: init.issuerType ?? 'registrant', bridgeId: init.bridgeId ?? null, payloadCid, submittedAt: init.submittedAt
    })
    return base64UrlDigestToBytes(rows[0]?.d, 'registration-request')
  }
}

function associationRequestDigestFn (port) {
  return async (init, requesterKey) => {
    const rows = await port.query('select Digest(:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d', {
      id: init.id, rowAuthorityId: init.authorityId, registrantId: init.registrantId, deviceKey: requesterKey, electionId: init.electionId ?? null, submittedAt: init.submittedAt
    })
    return base64UrlDigestToBytes(rows[0]?.d, 'association-request')
  }
}

function associationAttestationDigestFn (port) {
  return async (answer) => {
    const rows = await port.query('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d', {
      requestId: answer.requestId, nonce: answer.nonce, attestationJson: JSON.stringify(answer.attestation), deviceHash: answer.deviceHash ?? null
    })
    return base64UrlDigestToBytes(rows[0]?.d, 'association-attestation')
  }
}

/** createVoterRequestTransportSource(...).resolve(authorityId). */
async function resolveTransports (device, authorityId) {
  const port = device.strandPort()
  const reads = VE.intakeQueryPortFromStrandPort(port)
  const sealer = VE.createIntakeSealer({ port: reads, authorityId })
  const openStrand = async () => port
  const strandId = device.currentHash
  const associationTransport = new VE.P2pAssociationTransport({
    openStrand,
    computeDigest: associationRequestDigestFn(port),
    computeAttestationDigest: associationAttestationDigestFn(port),
    strandId,
    sealer
  })
  const policy = await VE.readIntakePolicyFrom(reads, authorityId)
  if (policy.restBridgeUrl !== null && policy.restBridgeUrl !== undefined) {
    throw fail('rest-bridge-unsupported', 'this authority routes registration through a REST bridge; the CLI supports the peer route only')
  }
  const registrationTransport = new VE.P2pRegistrationTransport({ openStrand, computeDigest: registrationRequestDigestFn(port), strandId, sealer })
  return { registrationTransport, associationTransport }
}

/** ConfirmationScreen.tsx pollForNotice: wait for a terminal decision notice for one request. */
async function pollForNotice (poll, requestId, terminal, deadlineMs) {
  const deadlineAt = Date.now() + deadlineMs
  let cursor
  for (;;) {
    const notices = await poll(cursor)
    for (const notice of notices) {
      cursor = notice.cursor
      if (notice.requestId === requestId && terminal.has(notice.status)) return notice
    }
    const left = deadlineAt - Date.now()
    if (left <= 0) throw fail('decision-timeout', 'the authority did not decide in time')
    await sleep(Math.min(DECISION_POLL_INTERVAL_MS, left))
  }
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/**
 * ConfirmationScreen.tsx onConfirm (317-586): self-signed SEALED registration request (with the
 * registration code on the peer route), self-signed association request bound to the P-256 voting
 * key, wait for the authority's challenge notice, answer it with the attestation, then stop at
 * "pending" — the authority decides asynchronously.
 */
export async function register (device, p) {
  device.requireNetwork()
  if (!p.first || !p.last) throw fail('invalid-argument', '--first and --last are required')
  const electionId = await resolveElectionId(device, p)
  const producer = softwareProducer(device.identity)
  const { publicKey: deviceKey } = await producer.provisionDeviceKey()
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const { registrationTransport, associationTransport } = await resolveTransports(device, authorityId)

  const saved = (await device.local.getItem('registrationAttempt')) ?? {}
  const registrantId = saved.registrantId ?? crypto.randomUUID()
  const associationRequestId = saved.associationRequestId ?? crypto.randomUUID()
  const privateDetails = [
    { name: 'dob', value: p.dob ?? '' },
    { name: 'email', value: p.email ?? '' },
    { name: 'phone', value: p.phone ?? '' },
    { name: 'addressLine1', value: p.address ?? '' }
  ].filter((d) => d.value !== '')
  const registrationInit = saved.registrationInit ?? {
    id: registrantId,
    authorityId,
    payload: {
      electionId,
      registrant: { id: registrantId, authorityId, expiration: IGNORED_EXPIRATION_PLACEHOLDER },
      public: { firstName: p.first, lastName: p.last },
      private: { expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: privateDetails },
      selective: p.party ? { expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: [{ name: 'party', value: p.party }] } : undefined
    },
    submittedAt: new Date().toISOString()
  }
  const associationInit = saved.associationInit ?? {
    id: associationRequestId, authorityId, registrantId, deviceKey, electionId, submittedAt: new Date().toISOString()
  }
  const registrationCode = saved.registrationCode ?? await device.association().deriveRegistrationCode(registrantId, device.sign)
  // WR-02: the attempt is minted once and reused byte-identical on retry, so a re-submit is idempotent.
  await device.local.setItem('registrationAttempt', { registrantId, associationRequestId, registrationInit, associationInit, registrationCode, electionId })

  const timings = {}
  let t = performance.now()
  await registrationTransport.submitRequest(registrationInit, device.identity.identityPublicHex, device.sign, { registrationCode })
  timings.registrationSubmittedMs = Math.round(performance.now() - t)
  const associationSign = (digest) => producer.signDeviceKeyDigest(digest)
  t = performance.now()
  await associationTransport.submitRequest(associationInit, deviceKey, associationSign)
  timings.associationSubmittedMs = Math.round(performance.now() - t)
  if (p.wait === false) return { registrantId, associationRequestId, status: 'submitted', timings }

  t = performance.now()
  const notice = await pollForNotice(associationTransport.pollDecisions.bind(associationTransport), associationRequestId, new Set(['c', 'r']),
    p.timeout !== undefined ? Number(p.timeout) * 1000 : DECISION_WAIT_DEADLINE_MS)
  timings.challengeWaitMs = Math.round(performance.now() - t)
  if (notice.status === 'r') throw fail('association-rejected', 'The authority rejected the association request.')
  if (!notice.challengeNonce) throw fail('no-nonce', 'The authority issued a challenge notice with no nonce.')
  const challenge = { nonce: notice.challengeNonce, authorityId, registrantId, deviceKey, electionId }
  const attestation = await producer.produce(challenge)
  t = performance.now()
  await associationTransport.submitAttestation({ requestId: associationRequestId, nonce: notice.challengeNonce, attestation }, deviceKey, associationSign)
  timings.attestationSubmittedMs = Math.round(performance.now() - t)
  return { registrantId, associationRequestId, status: 'pending', timings }
}

/** engines/registration-status.ts resolveRegistrationStatus (condensed). */
export async function registrationStatus (device, p) {
  device.requireNetwork()
  const deviceKey = device.identity.votingPublicHex
  const authorityId = (await device.networkEngine.getDetails()).network.primaryAuthorityId
  const associations = await device.association().getAssociationsByDeviceKey(deviceKey)
  const registrants = []
  for (const a of associations) {
    const r = await device.registration().getRegistrant(a.registrantId)
    if (r) registrants.push({ registrantId: r.id, status: r.status, authorityId: r.authorityId })
  }
  const approved = registrants.find((r) => r.status === 'a' && r.authorityId === authorityId)
  const attempt = await device.local.getItem('registrationAttempt')
  let notice = null
  if (attempt?.associationRequestId) {
    const { associationTransport } = await resolveTransports(device, authorityId)
    const notices = await associationTransport.pollDecisions()
    notice = notices.filter((n) => n.requestId === attempt.associationRequestId).map((n) => n.status).pop() ?? null
  }
  const state = approved ? 'registered' : notice === 'r' ? 'rejected' : attempt ? 'pending' : 'not-registered'
  if (p.wait === true && state !== 'registered') {
    const deadline = Date.now() + Number(p.timeout ?? 180) * 1000
    while (Date.now() < deadline) {
      await sleep(2000)
      const again = await registrationStatus(device, {})
      if (again.state === 'registered' || again.state === 'rejected') return again
    }
  }
  return { state, deviceKey, registrants, lastAssociationNotice: notice }
}

// ---------------------------------------------------------------------------------------------
// Election, ballot
// ---------------------------------------------------------------------------------------------

/** HomeScreen / TimelineScreen: readVoterElection (details + timeline + key release status). */
export async function voterElection (device, p) {
  const electionId = await resolveElectionId(device, p)
  const engine = await device.election(electionId)
  const details = await engine.getElectionDetails()
  const timeline = parseTimeline(details.current?.timeline)
  const release = await device.keyRelease().getKeyReleaseStatus(electionId).catch(() => null)
  return {
    electionId,
    title: details.election.title,
    revision: details.current?.revision,
    lifecycleState: timeline ? phaseAt(timeline, Date.now()) : null,
    timeline: timeline ? isoTimeline(timeline) : null,
    keyholders: (details.current?.keyholders ?? []).map((k) => k.name),
    keyRelease: release
  }
}

/** election-read.ts readVoterBallot (confirmed ballots only, as a release build shows). */
export async function voterBallot (device, p) {
  const electionId = await resolveElectionId(device, p)
  const engine = await device.election(electionId)
  const out = []
  for (const summary of await engine.getBallots()) {
    const state = await engine.getBallotConfirmationState(summary.id)
    if (!state.confirmed && p.includeProposed !== true) continue
    const { ballot } = await engine.getBallotDetails(summary.id)
    out.push({
      ballotId: ballot.id,
      description: ballot.description,
      confirmed: state.confirmed,
      questions: ballot.questions.map((q) => ({ code: q.code, title: q.title, voteFor: q.optionRange?.max ?? 1, required: q.required, options: q.options.map((o) => o.code) }))
    })
  }
  return { electionId, ballots: out }
}

// ---------------------------------------------------------------------------------------------
// Casting (engines/vote-casting.ts) and the local vote record
// ---------------------------------------------------------------------------------------------

/** election-read.ts readVoteContext. */
async function readVoteContext (device, electionId, nowMs) {
  const engine = await device.election(electionId)
  const details = await engine.getElectionDetails()
  const revision = Number(details.current.revision)
  const timeline = parseTimeline(details.current.timeline)
  const lifecycleState = timeline ? phaseAt(timeline, nowMs) : null
  const summaries = await engine.getBallots()
  const states = await Promise.all(summaries.map((s) => engine.getBallotConfirmationState(s.id)))
  const confirmed = summaries.filter((_, i) => states[i]?.confirmed === true)
  const unconfirmedBallotIds = summaries.filter((_, i) => states[i]?.confirmed !== true).map((s) => s.id).sort()
  const ballots = (await Promise.all(confirmed.map(async (s) => (await engine.getBallotDetails(s.id)).ballot))).sort((a, b) => (a.id < b.id ? -1 : 1))
  return { electionId, revision, authorityId: details.election.authorityId, open: lifecycleState === 'Open', lifecycleState, ballots, unconfirmedBallotIds }
}

/**
 * `--select q=opt[,opt]` (or `ballotId:q=opt`) -> `{ [ballotId]: { [questionCode]: codes[] } }`,
 * with resolveVoteSelections' checks: known option, at most voteFor, required answered, min.
 */
function resolveSelections (context, selects) {
  const selections = Object.fromEntries(context.ballots.map((b) => [b.id, {}]))
  for (const spec of [].concat(selects ?? [])) {
    const m = /^(?:([^:]+):)?([^=]+)=(.+)$/.exec(String(spec))
    if (!m) throw fail('selection-invalid', `--select "${spec}" must be question=option[,option]`)
    const [, ballotId, code, opts] = m
    const ballot = ballotId ? context.ballots.find((b) => b.id === ballotId) : context.ballots.find((b) => b.questions.some((q) => q.code === code))
    const question = ballot?.questions.find((q) => q.code === code)
    if (!question) throw fail('selection-invalid', `no question "${code}" on the confirmed ballots`)
    const codes = [...new Set(opts.split(',').map((o) => o.trim()))].sort()
    if (codes.some((c) => !question.options.some((o) => o.code === c)) || codes.length > (question.optionRange?.max ?? 1)) {
      throw fail('selection-invalid', `invalid selection for "${code}"`)
    }
    selections[ballot.id][code] = codes
  }
  for (const ballot of context.ballots) {
    for (const q of ballot.questions) {
      const codes = selections[ballot.id][q.code]
      if (q.required && !codes?.length) throw fail('required-unanswered', `question "${q.code}" is required`)
      if (codes?.length && typeof q.optionRange?.min === 'number' && codes.length < q.optionRange.min) throw fail('below-minimum', `question "${q.code}" needs at least ${q.optionRange.min}`)
    }
  }
  return selections
}

/** vote-casting.ts resolveVotingRegistrant. */
async function resolveVotingRegistrant (device, authorityId) {
  const publicKey = device.identity.votingPublicHex
  const rows = await device.association().getAssociationsByDeviceKey(publicKey)
  const matches = []
  for (const row of rows) {
    const registrant = await device.registration().getRegistrant(row.registrantId)
    if (registrant && registrant.status === 'a' && registrant.authorityId === authorityId) matches.push({ row, registrant })
  }
  if (matches.length === 0) throw fail('not-registered', 'this device has no approved registration for the authority')
  if (matches.length > 1) throw fail('registration-ambiguous', 'this device key is associated with more than one registrant')
  const { row, registrant } = matches[0]
  const check = VE.checkVotingKey(publicKey, row.deviceKey)
  if (!check.ok) throw fail(check.reason, `voting key check failed: ${check.reason}`)
  return { registrantId: registrant.id, privateCid: registrant.privateCid, publicCid: registrant.publicCid ?? null, attestationCid: row.attestationCid ?? null, compressedDeviceKey: check.compressedKey }
}

/** vote-record-vault.ts sealVoteRecord: random data key, AES-256-GCM, election-bound AAD, wrapped key. */
function sealVoteRecord (identity, record) {
  const dataKey = randomBytes(32)
  const iv = randomBytes(12)
  const ct = gcm(dataKey, iv, utf8ToBytes(VOTE_RECORD_AAD_PREFIX + record.electionId)).encrypt(utf8ToBytes(JSON.stringify(record)))
  const wrapIv = randomBytes(12)
  const wrapped = gcm(hexToBytes(identity.recordWrapKeyHex), wrapIv).encrypt(dataKey)
  dataKey.fill(0)
  return {
    v: 1,
    wrappedKey: { v: 1, alg: 'AES-256-GCM', keyAlias: 'VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1', ivBase64: Buffer.from(wrapIv).toString('base64'), ciphertextBase64: Buffer.from(wrapped).toString('base64'), securityLevel: 'software' },
    iv: Buffer.from(iv).toString('base64'),
    ct: Buffer.from(ct).toString('base64')
  }
}

function openVoteRecord (identity, envelope, electionId) {
  const dataKey = gcm(hexToBytes(identity.recordWrapKeyHex), Buffer.from(envelope.wrappedKey.ivBase64, 'base64')).decrypt(Buffer.from(envelope.wrappedKey.ciphertextBase64, 'base64'))
  const plain = gcm(dataKey, Buffer.from(envelope.iv, 'base64'), utf8ToBytes(VOTE_RECORD_AAD_PREFIX + electionId)).decrypt(Buffer.from(envelope.ct, 'base64'))
  dataKey.fill(0)
  return JSON.parse(new TextDecoder().decode(plain))
}

/**
 * ReviewSubmitScreen.tsx:265 -> vote-casting.ts castVote: eligibility (window Open, all ballots
 * confirmed, an approved registration whose key is this device's), one vote entry per ballot with a
 * fresh nonce, ONE device signature over the voter-entry digest, a self-check of that signature,
 * then the sealed record + marker. Nothing goes to the network here.
 */
export async function castVote (device, p) {
  const electionId = await resolveElectionId(device, p)
  const nowMs = Date.now()
  const context = await readVoteContext(device, electionId, nowMs)
  if (!context.open) throw fail('window-closed', `voting is not open (lifecycle state ${context.lifecycleState})`)
  if (context.unconfirmedBallotIds.length > 0) throw fail('ballot-unconfirmed', `ballots not confirmed: ${context.unconfirmedBallotIds.join(', ')}`)
  if (context.ballots.length === 0) throw fail('no-ballots', 'the election has no confirmed ballots')
  const selections = resolveSelections(context, p.select)
  const voter = await resolveVotingRegistrant(device, context.authorityId)
  const marker = await device.local.getItem(`votetorrent.voteMarker.${electionId}`)
  if (marker && marker.electionRevision === context.revision && p.replace !== true) throw fail('already-saved', 'a vote is already saved for this election (use --replace to re-cast before sending)')

  const votes = context.ballots.map((ballot) => VE.buildVoteEntry({
    ballot, electionRevision: context.revision, selections: selections[ballot.id] ?? {}, nonce: VE.makeVoteNonce(crypto.getRandomValues(new Uint8Array(32)))
  }))
  const unsigned = {
    v: 1, electionId, electionRevision: context.revision, registrantId: voter.registrantId, privateCid: voter.privateCid, publicCid: voter.publicCid,
    deviceKey: voter.compressedDeviceKey, attestationCid: voter.attestationCid, ballots: votes.map((v) => ({ ballotId: v.ballotId, templateDigest: v.templateDigest }))
  }
  const digest = VE.voterEntryDigest(unsigned)
  const signed = await softwareProducer(device.identity).signDeviceKeyDigest(base64UrlDigestToBytes(digest, 'voter-entry'))
  if (!VE.verifySigP256(digest, signed.signature, voter.compressedDeviceKey)) throw fail('signature-invalid', 'the voter-entry signature does not verify')
  const record = { v: 1, electionId, electionRevision: context.revision, savedAt: new Date().toISOString(), votes, voter: { ...unsigned, signature: signed.signature } }
  const envelope = sealVoteRecord(device.identity, record)
  await device.local.setItem(`votetorrent.voteRecord.${electionId}`, envelope)
  await device.local.setItem(`votetorrent.voteMarker.${electionId}`, { v: 1, electionId, electionRevision: context.revision, ballotIds: record.voter.ballots.map((b) => b.ballotId), savedAt: record.savedAt, status: 'saved-not-sent' })
  return { electionId, electionRevision: context.revision, ballotIds: votes.map((v) => v.ballotId), savedAt: record.savedAt, registrantId: voter.registrantId }
}

/** VoteReceiptScreen -> vote-receipt.ts revealVoteReceipt: open the sealed record. */
export async function voteReceipt (device, p) {
  const electionId = await resolveElectionId(device, p)
  const envelope = await device.local.getItem(`votetorrent.voteRecord.${electionId}`)
  if (!envelope) throw fail('no-vote', 'no vote is saved on this device for that election')
  const record = openVoteRecord(device.identity, envelope, electionId)
  const sent = (await device.local.getItem(`votetorrent.voteSent.${electionId}`)) ?? {}
  return {
    electionId,
    savedAt: record.savedAt,
    votes: record.votes.map((v) => ({ ballotId: v.ballotId, answers: v.answers })),
    sent
  }
}

// ---------------------------------------------------------------------------------------------
// Sending (engines/vote-send-flow.ts + vote-sending.ts + vote-sending-port.ts)
// ---------------------------------------------------------------------------------------------

function sendingPort (db) {
  return {
    async readElectionKey (electionId, revision) {
      const row = await one(db, 'select JointPublicKey from ElectionKey where ElectionId = :e and ElectionRevision = :r', { e: electionId, r: revision })
      return typeof row?.JointPublicKey === 'string' && row.JointPublicKey.length > 0 ? row.JointPublicKey : null
    },
    async readVotingClose (electionId, revision) {
      const row = await one(db, 'select Timeline from ElectionRevision where ElectionId = :e and Revision = :r', { e: electionId, r: revision })
      try {
        const closes = JSON.parse(String(row?.Timeline)).accruingVotes
        return typeof closes === 'number' && Number.isFinite(closes) ? closes : null
      } catch { return null }
    },
    async commit (block, ballot, signatures, nowMs) {
      return await VE.commitPoolBlock(db, block, ballot, signatures, { nowMs, now: new Date(nowMs).toISOString().slice(0, 19) })
    },
    async findRecordedVote (electionId, ballotId, registrantId) {
      const row = await one(db, 'select BlockCid from VoteBlockVoter where ElectionId = :e and BallotId = :b and RegistrantId = :reg', { e: electionId, b: ballotId, reg: registrantId })
      return typeof row?.BlockCid === 'string' ? row.BlockCid : null
    }
  }
}

/** vote-sending.ts serialize: one consent prompt at a time. */
function serialize (fn) {
  let tail = Promise.resolve()
  return (...args) => {
    const run = tail.then(() => fn(...args))
    tail = run.catch(() => undefined)
    return run
  }
}

/**
 * SendVoteCard -> runVoteSendFlow -> sendSavedVote: for each ballot not yet sent, encrypt the vote
 * entry to the election key, then run a PoolAgent through the authority's rendezvous (the first
 * remembered invitation member) until a block of at least 3 commits or voting closes.
 */
export async function sendVote (device, p) {
  const electionId = await resolveElectionId(device, p)
  const envelope = await device.local.getItem(`votetorrent.voteRecord.${electionId}`)
  if (!envelope) throw fail('no-vote', 'no vote is saved on this device for that election')
  const record = openVoteRecord(device.identity, envelope, electionId)
  const port = sendingPort(device.ctx().db)
  const revision = record.electionRevision
  const jointPublicKey = await port.readElectionKey(electionId, revision)
  if (jointPublicKey === null) return { ok: false, reason: 'election-key-missing' }
  const closesAt = await port.readVotingClose(electionId, revision)
  if (closesAt === null) return { ok: false, reason: 'window-unreadable' }
  if (Date.now() >= closesAt) return { ok: false, reason: 'voting-closed' }

  const bootstrap = (await device.local.getItem('joinBootstrap')) ?? []
  const target = p.rendezvous ?? bootstrap.find((a) => a.includes('/ws')) ?? bootstrap[0]
  if (!target) throw fail('no-rendezvous', 'no authority address is remembered from the join code')
  const rendezvous = VE.createLibp2pRendezvousClient(device.node.getControlNode(), multiaddr(target))
  const producer = softwareProducer(device.identity)
  const signConsent = serialize(async (digest) => (await producer.signDeviceKeyDigest(base64UrlDigestToBytes(digest, 'consent'))).signature)
  const sentKey = `votetorrent.voteSent.${electionId}`
  const sent = (await device.local.getItem(sentKey)) ?? {}
  const statuses = []
  const deadlineAt = p.timeout !== undefined ? Math.min(closesAt, Date.now() + Number(p.timeout) * 1000) : closesAt

  const ballots = await Promise.all(record.votes.map(async (vote) => {
    const ballotId = vote.ballotId
    if (sent[ballotId] !== undefined) return { ballotId, status: 'sent', cid: sent[ballotId] }
    const already = await port.findRecordedVote(electionId, ballotId, record.voter.registrantId).catch(() => null)
    if (already !== null) { sent[ballotId] = already; return { ballotId, status: 'sent', cid: already } }
    const ballot = { electionKey: { electionId, revision, jointPublicKey }, ballotId, templateDigest: vote.templateDigest }
    const identity = VE.createPoolIdentity()
    const contribution = { member: identity.peerId, voteCiphertext: VE.encryptVoteEntry(ballot.electionKey, ballotId, VE.canonicalJson(vote)), voterEntry: record.voter }
    const agent = new VE.PoolAgent({
      identity,
      rendezvous,
      ballot,
      contribution,
      signConsent,
      commit: (block, signatures) => port.commit(block, ballot, signatures, Date.now()),
      findRecordedVote: () => port.findRecordedVote(electionId, ballotId, record.voter.registrantId),
      deadlineAt,
      now: () => Date.now(),
      onStatus: (s) => statuses.push({ ballotId, phase: s.phase, size: s.size, at: Date.now() })
    })
    const outcome = await agent.run()
    if (outcome.status === 'committed') { sent[ballotId] = outcome.cid; return { ballotId, status: 'sent', cid: outcome.cid } }
    return { ballotId, status: 'not-sent', reason: outcome.reason === 'deadline' ? 'voting-closed' : (outcome.reason ?? 'stopped') }
  }))
  await device.local.setItem(sentKey, sent)
  const phases = [...new Set(statuses.map((s) => s.phase))]
  return { ok: ballots.every((b) => b.status === 'sent'), ballots, phases }
}
