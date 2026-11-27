// vote-record-move.spec.ts: plain-Node proof of the moved Voter vote record store, record vault, receipt
// reader and sent-ballot store (phase 67 plan 30). An in-memory recording kv stands in for the device
// store, an AES-GCM provider under a test key stands in for the native wrap provider, and the shared
// castVote runs end to end over the real factories with a P-256 producer and fake engines.
import { expect } from 'chai'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { Ballot, Question } from '@votetorrent/vote-core'
import {
  castVote,
  createVoteReceiptReader,
  createVoteRecordStore,
  createVoteRecordVault,
  createVoteSentStore,
  voteMarkerKey,
  voteRecordKey,
  VoteRecordUnavailableError,
  VoteStoreWriteError,
  type CastVoteDeps,
  type VoteContext,
  type VoteRecord,
  type VoteRecordEnvelope,
  type VoteRecordUnavailableReason,
  type VoteSendDebug
} from '../../src/voter/reads.js'
import type { AttestationProducer, KvStorage, SecretWrapPrompt, VoteRecordWrapProvider, VoteSigningProducer, WrappedSecret } from '../../src/platform/index.js'

const PROMPT: SecretWrapPrompt = { title: 'Show your saved vote', subtitle: 'Use your fingerprint', negativeButton: 'Cancel' }
const ALIAS = 'TEST_VOTE_RECORD_WRAP_KEY_V1'
const PROVIDER_TEXT = 'SECRET-PROVIDER-TEXT-must-never-surface'

function randHex (bytes: number): string {
  return bytesToHex(randomBytes(bytes))
}

// ---------------------------------------------------------------------------------------------
// Fakes

interface RecordingKv extends KvStorage {
  readonly map: Map<string, string>
  readonly ops: string[]
  failGet: boolean
  /** The marker key whose write lands and then reports failure (WR-02). */
  landThenThrowKey: string | null
}

function recordingKv (): RecordingKv {
  const map = new Map<string, string>()
  const ops: string[] = []
  const kv: RecordingKv = {
    map,
    ops,
    failGet: false,
    landThenThrowKey: null,
    async getItem (key) {
      ops.push('get:' + key)
      if (kv.failGet) throw new Error('kv read failed')
      return map.get(key) ?? null
    },
    async setItem (key, value) {
      ops.push('set:' + key)
      map.set(key, value)
      if (kv.landThenThrowKey === key) throw new Error('kv write reported failure')
    },
    async removeItem (key) {
      ops.push('remove:' + key)
      map.delete(key)
    }
  }
  return kv
}

class FakeWrapError extends Error {
  readonly code: string
  constructor (code: string) {
    super(PROVIDER_TEXT)
    this.name = 'FakeWrapError'
    this.code = code
  }
}

function base64 (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

interface FakeProvider extends VoteRecordWrapProvider {
  throwCode: string | null
  calls: number
}

/** AES-256-GCM under a test key: the shape of the native provider, with a settable failure code. */
function fakeProvider (): FakeProvider {
  const kek = randomBytes(32)
  const provider: FakeProvider = {
    throwCode: null,
    calls: 0,
    async wrap (plaintext, aad) {
      provider.calls++
      if (provider.throwCode !== null) throw new FakeWrapError(provider.throwCode)
      const iv = randomBytes(12)
      const ct = gcm(kek, iv, aad).encrypt(plaintext)
      return { v: 1, alg: 'AES-256-GCM', keyAlias: ALIAS, ivBase64: base64(iv), ciphertextBase64: base64(ct), securityLevel: 'test-stub' }
    },
    async unwrap (wrapped: WrappedSecret, aad) {
      provider.calls++
      if (provider.throwCode !== null) throw new FakeWrapError(provider.throwCode)
      try {
        return gcm(kek, Buffer.from(wrapped.ivBase64, 'base64'), aad).decrypt(Buffer.from(wrapped.ciphertextBase64, 'base64'))
      } catch {
        throw new FakeWrapError('UNWRAP_TAG_MISMATCH')
      }
    }
  }
  return provider
}

function vaultOver (provider: VoteRecordWrapProvider, readCode: (err: unknown) => string | null = (err) => ((err as { name?: unknown, code?: unknown } | null)?.name === 'FakeWrapError' ? String((err as { code: string }).code) : null)) {
  return createVoteRecordVault({ resolveWrapProvider: () => provider, readWrapErrorCode: readCode, wrapKeyAlias: ALIAS })
}

function makeRecord (args: { electionId?: string, electionRevision?: number, savedAt?: string, ballots?: string[] } = {}): VoteRecord {
  const electionId = args.electionId ?? 'e-1'
  const electionRevision = args.electionRevision ?? 3
  const ballots = args.ballots ?? ['b-1']
  return {
    v: 1,
    electionId,
    electionRevision,
    savedAt: args.savedAt ?? '2026-11-24T12:00:00.000Z',
    votes: ballots.map((ballotId) => ({
      v: 1 as const,
      electionId,
      electionRevision,
      ballotId,
      templateDigest: 'td-' + randHex(8),
      answers: [{ questionCode: 'q-a', optionCodes: ['opt-' + randHex(6)] }],
      nonce: randHex(32)
    })),
    voter: {
      v: 1,
      electionId,
      electionRevision,
      registrantId: 'reg-' + randHex(8),
      privateCid: 'cid-' + randHex(8),
      publicCid: null,
      deviceKey: 'dk-' + randHex(8),
      attestationCid: null,
      ballots: ballots.map((ballotId) => ({ ballotId, templateDigest: 'td-' + randHex(8) })),
      signature: 'sig-' + randHex(32)
    }
  }
}

function secretsOf (record: VoteRecord): string[] {
  return [...record.votes.map((v) => v.nonce), ...record.votes.flatMap((v) => v.answers.flatMap((a) => a.optionCodes)), record.voter.signature]
}

async function rejection (p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

function readerOver (store: ReturnType<typeof createVoteRecordStore>, vault: ReturnType<typeof createVoteRecordVault>) {
  return createVoteReceiptReader({
    readVoteMarker: (id) => store.readVoteMarker(id),
    readSavedVote: (id, r) => store.readSavedVote(id, r),
    voteRecordMatchesMarker: (rec, m) => rec.electionId === m.electionId && rec.electionRevision === m.electionRevision && rec.savedAt === m.savedAt && rec.voter.ballots.map((b) => b.ballotId).join() === m.ballotIds.join(),
    openVoteRecord: (id, env, o) => vault.openVoteRecord(id, env, o),
    unavailableReasonOf: (err) => (err instanceof VoteRecordUnavailableError ? err.reason : null)
  })
}

function sink (): VoteSendDebug & { events: Array<{ tag: string, event: string, detail: Record<string, unknown> | undefined }> } {
  const events: Array<{ tag: string, event: string, detail: Record<string, unknown> | undefined }> = []
  return { events, vtDebug: (tag, event, detail) => { events.push({ tag, event, detail }) }, idPrefix: (id) => (typeof id === 'string' ? id.slice(0, 8) : typeof id) }
}

// ---------------------------------------------------------------------------------------------
// C1 fixtures (the 67-22 casting spec's shapes)

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'

function makeKey (): { sk: Uint8Array, spki: string, compressed: string } {
  const sk = p256.utils.randomSecretKey()
  const uncompressed = p256.getPublicKey(sk, false)
  const prefix = Uint8Array.from(SPKI_PREFIX.match(/../g) ?? [], (h) => parseInt(h, 16))
  const der = new Uint8Array(prefix.length + uncompressed.length)
  der.set(prefix, 0)
  der.set(uncompressed, prefix.length)
  return { sk, spki: Buffer.from(der).toString('base64'), compressed: bytesToHex(p256.getPublicKey(sk, true)) }
}

function question (code: string, overrides: Partial<Question> = {}): Question {
  return { code, title: `Title ${code}`, instructions: '', type: 'select', options: [{ code: 'x', title: `${code} X` }, { code: 'y', title: `${code} Y` }], ...overrides } as Question
}

function ballot (id: string, questions: Question[]): Ballot {
  return { id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions } as Ballot
}

const OPEN_CONTEXT: VoteContext = {
  electionId: 'e-1',
  revision: 3,
  authorityId: 'a-1',
  open: true,
  lifecycleState: 'Open',
  ballots: [ballot('b-1', [question('q-req'), question('q-opt', { required: false })])],
  unconfirmedBallotIds: [],
  unsupportedQuestionCount: 0
}

// ---------------------------------------------------------------------------------------------

describe('voter vote-record move', () => {
  it('S1 createVoteRecordStore refuses a missing kv or one without setItem', () => {
    expect(() => createVoteRecordStore(undefined as never)).to.throw(TypeError)
    expect(() => createVoteRecordStore({ getItem: async () => null } as never)).to.throw(TypeError)
    expect(() => createVoteRecordStore(recordingKv())).not.to.throw()
  })

  it('S2 guard reports ok, already-saved, stale and blocks on an unreadable marker', async () => {
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    expect(await store.guard('e-1', 3)).to.equal('ok')
    const record = makeRecord()
    const vault = vaultOver(fakeProvider())
    await store.writeVoteRecord(await vault.sealVoteRecord(record, { prompt: PROMPT }), store.buildVoteMarker(record))
    expect(await store.guard('e-1', 3)).to.equal('already-saved')
    expect(await store.guard('e-1', 4)).to.equal('stale')
    kv.map.set(voteMarkerKey('e-1'), '{not json')
    expect(await store.guard('e-1', 3)).to.equal('already-saved')
    kv.failGet = true
    expect(await store.guard('e-1', 3)).to.equal('already-saved')
  })

  it('S3 a write is record then marker, and a landed-then-rejected marker write counts as committed (WR-02)', async () => {
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    const vault = vaultOver(fakeProvider())
    const record = makeRecord()
    const envelope = await vault.sealVoteRecord(record, { prompt: PROMPT })
    await store.writeVoteRecord(envelope, store.buildVoteMarker(record))
    expect(kv.ops.filter((o) => o.startsWith('set:'))).to.deep.equal(['set:' + voteRecordKey('e-1'), 'set:' + voteMarkerKey('e-1')])
    expect(kv.ops.indexOf('set:' + voteRecordKey('e-1'))).to.be.lessThan(kv.ops.indexOf('set:' + voteMarkerKey('e-1')))

    const kv2 = recordingKv()
    kv2.landThenThrowKey = voteMarkerKey('e-1')
    const store2 = createVoteRecordStore(kv2)
    await store2.writeVoteRecord(envelope, store2.buildVoteMarker(record))
    expect(JSON.parse(kv2.map.get(voteMarkerKey('e-1'))!)).to.deep.equal(store2.buildVoteMarker(record))
    expect(kv2.ops.filter((o) => o.startsWith('set:'))).to.have.length(2)
  })

  it('S4 writeVoteRecord rejects already-saved, unreadable and invalid-input with VoteStoreWriteError reasons', async () => {
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    const vault = vaultOver(fakeProvider())
    const record = makeRecord()
    const envelope = await vault.sealVoteRecord(record, { prompt: PROMPT })
    const marker = store.buildVoteMarker(record)
    const bad = await rejection(store.writeVoteRecord({ ...envelope, iv: 7 } as never, marker))
    expect(bad).to.be.instanceOf(VoteStoreWriteError)
    expect((bad as VoteStoreWriteError).reason).to.equal('invalid-input')
    expect(kv.ops.filter((o) => o.startsWith('set:'))).to.deep.equal([])
    await store.writeVoteRecord(envelope, marker)
    const again = await rejection(store.writeVoteRecord(envelope, marker))
    expect((again as VoteStoreWriteError).reason).to.equal('already-saved')
    kv.failGet = true
    const unreadable = await rejection(store.writeVoteRecord(envelope, marker))
    expect((unreadable as VoteStoreWriteError).reason).to.equal('unreadable')
    expect(store.VoteStoreWriteError).to.equal(VoteStoreWriteError)
  })

  it('V1 a seal/open round trip returns the record and the envelope JSON carries no nonce, answer or signature', async () => {
    const provider = fakeProvider()
    const vault = vaultOver(provider)
    const record = makeRecord({ ballots: ['b-1', 'b-2'] })
    const envelope = await vault.sealVoteRecord(record, { prompt: PROMPT })
    expect(envelope.wrappedKey.keyAlias).to.equal(ALIAS)
    const text = JSON.stringify(envelope)
    for (const s of secretsOf(record)) expect(text).not.to.contain(s)
    expect(text).not.to.contain(record.voter.registrantId)
    const opened = await vault.openVoteRecord('e-1', envelope, { prompt: PROMPT })
    expect(opened).to.deep.equal(record)
    expect(provider.calls).to.equal(2)
    expect(vault.VoteRecordUnavailableError).to.equal(VoteRecordUnavailableError)
  })

  it('V2 another election id fails the AAD and opens as tag-mismatch', async () => {
    const vault = vaultOver(fakeProvider())
    const envelope = await vault.sealVoteRecord(makeRecord(), { prompt: PROMPT })
    const err = await rejection(vault.openVoteRecord('e-2', envelope, { prompt: PROMPT }))
    expect(err).to.be.instanceOf(VoteRecordUnavailableError)
    expect((err as VoteRecordUnavailableError).reason).to.equal('tag-mismatch')
  })

  it('V3 a flipped ciphertext byte is tag-mismatch and a wrong keyAlias is malformed', async () => {
    const vault = vaultOver(fakeProvider())
    const envelope = await vault.sealVoteRecord(makeRecord(), { prompt: PROMPT })
    const ct = Buffer.from(envelope.ct, 'base64')
    ct[3] = ct[3]! ^ 0x01
    const flipped = await rejection(vault.openVoteRecord('e-1', { ...envelope, ct: ct.toString('base64') }, { prompt: PROMPT }))
    expect((flipped as VoteRecordUnavailableError).reason).to.equal('tag-mismatch')
    const alias = await rejection(vault.openVoteRecord('e-1', { ...envelope, wrappedKey: { ...envelope.wrappedKey, keyAlias: 'OTHER' } }, { prompt: PROMPT }))
    expect((alias as VoteRecordUnavailableError).reason).to.equal('malformed')
  })

  it('V4 readWrapErrorCode CANCELED maps to canceled, an unknown code to native-error, and no provider text surfaces', async () => {
    const provider = fakeProvider()
    const vault = vaultOver(provider)
    const envelope = await vault.sealVoteRecord(makeRecord(), { prompt: PROMPT })
    provider.throwCode = 'CANCELED'
    const canceled = await rejection(vault.openVoteRecord('e-1', envelope, { prompt: PROMPT }))
    expect((canceled as VoteRecordUnavailableError).reason).to.equal('canceled')
    expect(String((canceled as Error).message)).not.to.contain(PROVIDER_TEXT)
    provider.throwCode = 'NOT_A_CODE'
    const unknown = await rejection(vault.openVoteRecord('e-1', envelope, { prompt: PROMPT }))
    expect((unknown as VoteRecordUnavailableError).reason).to.equal('native-error')
    expect(String((unknown as Error).message)).not.to.contain(PROVIDER_TEXT)
    provider.throwCode = 'KEY_INVALIDATED'
    const sealFail = await rejection(vault.sealVoteRecord(makeRecord(), { prompt: PROMPT }))
    expect((sealFail as VoteRecordUnavailableError).reason).to.equal('key-invalidated')
  })

  it('V5 createVoteRecordVault refuses missing options', () => {
    expect(() => createVoteRecordVault(undefined as never)).to.throw(TypeError)
    expect(() => createVoteRecordVault({ resolveWrapProvider: () => fakeProvider(), readWrapErrorCode: () => null } as never)).to.throw(TypeError)
    expect(() => createVoteRecordVault({ resolveWrapProvider: () => fakeProvider(), readWrapErrorCode: () => null, wrapKeyAlias: '' })).to.throw(TypeError)
  })

  it('R1 revealVoteReceipt is ok for the committed record, unreadable for a marker mismatch (WR-02) and canceled through unavailableReasonOf', async () => {
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    const provider = fakeProvider()
    const vault = vaultOver(provider)
    const reader = readerOver(store, vault)
    const record = makeRecord()
    const envelope = await vault.sealVoteRecord(record, { prompt: PROMPT })
    await store.writeVoteRecord(envelope, store.buildVoteMarker(record))
    const ok = await reader.revealVoteReceipt('e-1', envelope, PROMPT)
    expect(ok.kind).to.equal('ok')
    expect(ok.kind === 'ok' && ok.record.votes.map((v) => v.ballotId)).to.deep.equal(['b-1'])

    const other = makeRecord({ savedAt: '2026-11-24T13:00:00.000Z' })
    kv.map.set(voteMarkerKey('e-1'), JSON.stringify(store.buildVoteMarker(other)))
    expect(await reader.revealVoteReceipt('e-1', envelope, PROMPT)).to.deep.equal({ kind: 'unreadable' })

    kv.map.set(voteMarkerKey('e-1'), JSON.stringify(store.buildVoteMarker(record)))
    provider.throwCode = 'CANCELED'
    expect(await reader.revealVoteReceipt('e-1', envelope, PROMPT)).to.deep.equal({ kind: 'canceled' })
    provider.throwCode = 'WRAP_FAILED'
    expect(await reader.revealVoteReceipt('e-1', envelope, PROMPT)).to.deep.equal({ kind: 'failed' })
    expect(() => createVoteReceiptReader({} as never)).to.throw(TypeError)
  })

  it('R2 loadVoteReceipt gives none, unreadable and saved from the marker', async () => {
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    const vault = vaultOver(fakeProvider())
    const reader = readerOver(store, vault)
    expect(await reader.loadVoteReceipt('e-1', null)).to.deep.equal({ kind: 'none' })
    const record = makeRecord()
    const envelope = await vault.sealVoteRecord(record, { prompt: PROMPT })
    await store.writeVoteRecord(envelope, store.buildVoteMarker(record))
    const saved = await reader.loadVoteReceipt('e-1', null)
    expect(saved.kind).to.equal('saved')
    expect(saved.kind === 'saved' && saved.revisionKnown).to.equal(false)
    expect(saved.kind === 'saved' && saved.envelope).to.deep.equal(envelope)
    const stale = await reader.loadVoteReceipt('e-1', 4)
    expect(stale.kind).to.equal('stale')
    kv.map.set(voteMarkerKey('e-1'), '{bad')
    expect(await reader.loadVoteReceipt('e-1', null)).to.deep.equal({ kind: 'unreadable' })
    expect(kv.ops.filter((o) => o.startsWith('set:'))).to.have.length(2)
  })

  it('T1 two concurrent record calls on one election keep both ballots', async () => {
    const kv = recordingKv()
    const store = createVoteSentStore(kv, sink())
    await Promise.all([store.record('e-1', 3, 'b-1', 'cid-1'), store.record('e-1', 3, 'b-2', 'cid-2')])
    expect(await store.read('e-1', 3)).to.deep.equal({ 'b-1': 'cid-1', 'b-2': 'cid-2' })
    expect(await store.readVoteSent('e-1', 4)).to.deep.equal({})
    expect(await store.readVoteSent('e-1', 3)).to.deep.equal({ 'b-1': 'cid-1', 'b-2': 'cid-2' })
    expect(() => createVoteSentStore(kv, undefined as never)).to.throw(TypeError)
    expect(() => createVoteSentStore(undefined as never, sink())).to.throw(TypeError)
  })

  it('T2 a failing kv read skips the write, rejects, and the sink saw only the error class name', async () => {
    const kv = recordingKv()
    const s = sink()
    const store = createVoteSentStore(kv, s)
    await store.recordVoteSent('e-1', 3, 'b-1', 'cid-1')
    kv.failGet = true
    const err = await rejection(store.recordVoteSent('e-1', 3, 'b-2', 'cid-2'))
    expect((err as Error).message).to.equal('kv read failed')
    expect(kv.ops.filter((o) => o.startsWith('set:'))).to.have.length(1)
    expect(s.events).to.deep.equal([{ tag: 'sent-store', event: 'record-skipped-read-failed', detail: { class: 'Error' } }])
    expect(JSON.stringify(s.events)).not.to.contain('kv read failed')
    kv.failGet = false
    expect(await store.read('e-1', 3)).to.deep.equal({ 'b-1': 'cid-1' })
  })

  it('C1 the shared castVote over the real factories saves a record the receipt reader reveals with the same ballotIds', async () => {
    const key = makeKey()
    const kv = recordingKv()
    const store = createVoteRecordStore(kv)
    const provider = fakeProvider()
    const vault = vaultOver(provider)
    const reader = readerOver(store, vault)
    const producer: VoteSigningProducer = {
      provisionDeviceKey: async () => { throw new Error('never provisions') },
      getCurrentDeviceKey: async () => ({ publicKey: key.spki }),
      produce: async () => { throw new Error('not used') },
      signDeviceKeyDigest: async (digest: Uint8Array) => ({ signature: bytesToHex(p256.sign(digest, key.sk)), signerKey: key.spki, signerUserId: '' }) as never
    }
    const association = { getAssociationsByDeviceKey: async () => [{ registrantId: 'reg-1', deviceKey: key.compressed, attestationCid: 'att-1' }] }
    const registration = { getRegistrant: async (id: string) => ({ id, authorityId: 'a-1', status: 'a', privateCid: `priv-${id}`, publicCid: 'pub-1' }) }
    const getEngine = (async (name: string) => {
      if (name === 'association') return association
      if (name === 'registration') return registration
      throw new Error(`unexpected engine ${name}`)
    }) as CastVoteDeps['getEngine']
    const result = await castVote(
      { getEngine, nowMs: 1234, selectionMap: { 'b-1:q-req': ['b-1:q-req:x'] }, readContext: async () => OPEN_CONTEXT, signPrompt: PROMPT, recordPrompt: PROMPT },
      {
        resolveVoteSigningProducer: (override?: AttestationProducer) => {
          if (override !== undefined) throw new TypeError('producer override refused')
          return producer
        },
        recordStore: store,
        recordVault: vault
      }
    )
    expect(result.ok).to.equal(true)
    expect(result.ok && result.ballotIds).to.deep.equal(['b-1'])
    expect(kv.ops.filter((o) => o.startsWith('set:'))).to.deep.equal(['set:' + voteRecordKey('e-1'), 'set:' + voteMarkerKey('e-1')])
    const load = await reader.loadVoteReceipt('e-1', 3)
    expect(load.kind).to.equal('saved')
    const reveal = await reader.revealVoteReceipt('e-1', (load as { envelope: VoteRecordEnvelope }).envelope, PROMPT)
    expect(reveal.kind).to.equal('ok')
    expect(reveal.kind === 'ok' && reveal.record.votes.map((v) => v.ballotId)).to.deep.equal(['b-1'])
    expect(reveal.kind === 'ok' && reveal.record.voter.registrantId).to.equal('reg-1')
    const stored = [...kv.map.values()].join('\n')
    // the fixture's option code is the one-character 'x', so the scan covers the nonces and the signature
    if (reveal.kind === 'ok') for (const s of [...reveal.record.votes.map((v) => v.nonce), reveal.record.voter.signature]) expect(stored).not.to.contain(s)
    const reasons: VoteRecordUnavailableReason[] = ['canceled']
    expect(reasons).to.have.length(1)
  })
})
