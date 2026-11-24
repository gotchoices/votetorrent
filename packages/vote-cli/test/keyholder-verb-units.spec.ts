// keyholder-verb-units.spec.ts: every pre-network refusal of the four keyholder verbs (join, accept,
// dkg, release), offline, against a fake daemon context with a REAL device vault (67-13
// openDeviceVault) in a mkdtemp home, a fresh SecretRegistry and an openNetwork that counts its calls
// and throws. "Refused before the network" is `opens === 0`; "zero unwraps" is the error's own
// `unwraps` property. Tokens are generated in-test; no share, token or key literal appears here.

import { expect } from 'chai'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VerbContext } from '../src/daemon/verb-context.js'
import { writeApprovalTokenFile } from '../src/approval/token.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import accept from '../src/verbs/keyholder/accept.js'
import dkg from '../src/verbs/keyholder/dkg.js'
import joinVerb from '../src/verbs/keyholder/join.js'
import release from '../src/verbs/keyholder/release.js'
import {
  KeyholderVerbError,
  MAX_SEAT_SHARE_BYTES,
  approvalFromArgs,
  keyholderErrorCode,
  readSeatShareFile
} from '../src/verbs/keyholder/keyholder-args.js'
import { withKeyholderVerbLock } from '../src/verbs/keyholder/keyholder-engines.js'

const NETWORK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ELECTION = 'election-1700000000000'

interface Coded {
  name?: string
  code?: string
  message?: string
  unwraps?: unknown
}

async function refusal(p: unknown): Promise<Coded> {
  try {
    await (typeof p === 'function' ? (p as () => unknown)() : p)
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a refusal')
}

interface FakeCtx {
  ctx: VerbContext
  device: DeviceVault
  secrets: SecretRegistry
  opens(): number
  close(): void
}

function makeCtx(home: string): FakeCtx {
  mkdirSync(home, { mode: 0o700 })
  const device = openDeviceVault({ home })
  const secrets = new SecretRegistry()
  let opens = 0
  const ctx = {
    role: 'keyholder',
    label: 'kh-a',
    partyId: 'vt-test-28',
    peerDir: home,
    secretsDir: join(home, 'secrets'),
    device,
    secrets,
    user: null,
    posture: 'production',
    acceptTokenAttestations: false,
    built: { ownerNode: null, stores: {} },
    async openNetwork() {
      opens++
      throw new Error('no network in this spec')
    }
  } as unknown as VerbContext
  return {
    ctx,
    device,
    secrets,
    opens: () => opens,
    close: () => device.close()
  }
}

describe('keyholder verb units', function () {
  this.timeout(60_000)
  let root: string
  let secretsDir: string
  let fake: FakeCtx
  let n = 0

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-28-'))
    chmodSync(root, 0o700)
    secretsDir = join(root, 'secrets')
    mkdirSync(secretsDir, { mode: 0o700 })
    fake = makeCtx(join(root, `home-${n++}`))
  })

  afterEach(() => {
    fake.close()
    rmSync(root, { recursive: true, force: true })
  })

  const shareFile = (name: string, text: string, mode = 0o600): string => {
    const p = join(secretsDir, name)
    writeFileSync(p, text, { mode })
    chmodSync(p, mode)
    return p
  }

  it('accept refuses a missing or relative shareFile with bad-args and reads no file', async () => {
    const missing = await refusal(accept(fake.ctx, { network: NETWORK }))
    expect(missing.name).to.equal('KeyholderVerbError')
    expect(missing.code).to.equal('bad-args')
    expect(missing.message).to.equal('keyholder accept refused (bad-args) field=shareFile')
    shareFile('rel.share', 'not-a-secret-but-must-not-be-read')
    const relative = await refusal(accept(fake.ctx, { network: NETWORK, shareFile: 'secrets/rel.share' }))
    expect(relative.code).to.equal('bad-args')
    expect(relative.message).to.not.include('rel.share')
    expect(fake.secrets.size).to.equal(0)
    expect(fake.opens()).to.equal(0)
  })

  it('every keyholder verb refuses an inline secret arg before anything else', async () => {
    const verbs = { accept, dkg, release, join: joinVerb }
    for (const [name, verb] of Object.entries(verbs)) {
      for (const key of ['share', 'shareText', 'token', 'code', 'seat', 'invitePrivate']) {
        const err = await refusal(verb(fake.ctx, { [key]: 'x' }))
        expect(err.name, `${name} ${key}`).to.equal('KeyholderVerbError')
        expect(err.code, `${name} ${key}`).to.equal('inline-secret-refused')
        expect(err.message, `${name} ${key}`).to.equal(`keyholder ${name} refused (inline-secret-refused)`)
      }
    }
    expect(fake.opens()).to.equal(0)
  })

  it('an unknown arg key refuses bad-args and the message holds no value', async () => {
    const err = await refusal(accept(fake.ctx, { network: NETWORK, shareFile: join(secretsDir, 'a.share'), bogusKey: 'VALUE-THAT-MUST-NOT-APPEAR' }))
    expect(err.code).to.equal('bad-args')
    expect(err.message).to.equal('keyholder accept refused (bad-args) field=bogusKey')
    expect(err.message).to.not.include('VALUE-THAT')
    const odd = await refusal(dkg(fake.ctx, { network: NETWORK, election: ELECTION, 'weird key!': 1 }))
    expect(odd.code).to.equal('bad-args')
    expect(odd.message).to.equal('keyholder dkg refused (bad-args)')
    // `peer` (the colocation label) is accepted and ignored
    const withPeer = await refusal(dkg(fake.ctx, { network: NETWORK, election: ELECTION, peer: 'kh-a' }))
    expect(withPeer.code).to.equal('identity-not-found')
  })

  it('the seat share reader refuses a missing, group-readable, symlinked or oversized file with distinct codes', async () => {
    const missing = await refusal(() => readSeatShareFile('accept', join(secretsDir, 'none.share')))
    expect(missing.code).to.equal('share-file-missing')
    const loose = shareFile('loose.share', 'seat text', 0o644)
    expect((await refusal(() => readSeatShareFile('accept', loose))).code).to.equal('share-file-mode')
    const target = shareFile('target.share', 'seat text')
    const link = join(secretsDir, 'link.share')
    symlinkSync(target, link)
    expect((await refusal(() => readSeatShareFile('accept', link))).code).to.equal('share-file-not-file')
    const big = shareFile('big.share', 'x'.repeat(MAX_SEAT_SHARE_BYTES + 1))
    expect((await refusal(() => readSeatShareFile('accept', big))).code).to.equal('share-file-size')
    const empty = shareFile('empty.share', '\n')
    expect((await refusal(() => readSeatShareFile('accept', empty))).code).to.equal('share-file-empty')
    expect(MAX_SEAT_SHARE_BYTES).to.equal(4096)
  })

  it('the seat share reader returns a 0600 file and its refusals carry no path or content', async () => {
    const text = 'seat-share-text-' + 'q'.repeat(40)
    const good = shareFile('good.share', text + '\n')
    expect(readSeatShareFile('accept', good)).to.equal(text)
    const loose = shareFile('loose2.share', text, 0o640)
    const err = await refusal(() => readSeatShareFile('accept', loose))
    expect(err.name).to.equal('KeyholderVerbError')
    expect(err.message).to.equal('keyholder accept refused (share-file-mode)')
    expect(err.message).to.not.include('loose2')
    expect(err.message).to.not.include(secretsDir)
    expect(err.message).to.not.include('qqqq')
    expect((err as { cause?: unknown }).cause).to.equal(undefined)
  })

  it('no tokenFile means NO_APPROVAL, a relative tokenFile is bad-args, an absolute one re-reads per call', async () => {
    const none = approvalFromArgs('accept', undefined)
    expect(none.source).to.equal('none')
    const denied = await refusal(none.approval.token())
    expect(denied.code).to.equal('token-absent')
    const rel = await refusal(() => approvalFromArgs('accept', 'secrets/t.token'))
    expect(rel.code).to.equal('bad-args')
    expect(rel.message).to.equal('keyholder accept refused (bad-args) field=tokenFile')
    const tokenPath = join(secretsDir, 'kh.token')
    writeApprovalTokenFile(tokenPath)
    const first = Buffer.from(readFileSync(tokenPath, 'utf8').trim(), 'base64url')
    const file = approvalFromArgs('accept', tokenPath)
    expect(file.source).to.equal('file')
    expect(Buffer.from(await file.approval.token()).equals(first)).to.equal(true)
    rmSync(tokenPath)
    writeApprovalTokenFile(tokenPath)
    const second = Buffer.from(readFileSync(tokenPath, 'utf8').trim(), 'base64url')
    expect(second.equals(first)).to.equal(false)
    expect(Buffer.from(await file.approval.token()).equals(second)).to.equal(true)
  })

  it('dkg refuses a malformed election id with bad-args', async () => {
    const err = await refusal(dkg(fake.ctx, { network: NETWORK, election: 'bad election id!' }))
    expect(err.code).to.equal('bad-args')
    expect(err.message).to.equal('keyholder dkg refused (bad-args) field=election')
    const net = await refusal(dkg(fake.ctx, { network: 'short', election: ELECTION }))
    expect(net.message).to.equal('keyholder dkg refused (bad-args) field=network')
    expect(fake.opens()).to.equal(0)
  })

  it('dkg with an empty identity store refuses identity-not-found with zero unwraps and never opens the network', async () => {
    const err = await refusal(dkg(fake.ctx, { network: NETWORK, election: ELECTION }))
    expect(err.name).to.equal('KeyholderVerbError')
    expect(err.code).to.equal('identity-not-found')
    expect(err.unwraps).to.equal(0)
    expect(fake.opens()).to.equal(0)
    expect(fake.device.vault.authPromptCount).to.equal(0)
  })

  it('release with an empty identity store refuses identity-not-found with zero unwraps and never opens the network', async () => {
    const err = await refusal(release(fake.ctx, { network: NETWORK, election: ELECTION, waitMs: '0', awaitCount: 2 }))
    expect(err.code).to.equal('identity-not-found')
    expect(err.unwraps).to.equal(0)
    expect(fake.opens()).to.equal(0)
  })

  it('release refuses an out-of-range waitMs or awaitCount', async () => {
    for (const [args, field] of [
      [{ waitMs: '900001' }, 'waitMs'],
      [{ waitMs: -1 }, 'waitMs'],
      [{ waitMs: '12abc' }, 'waitMs'],
      [{ awaitCount: 17 }, 'awaitCount'],
      [{ awaitCount: 1.5 }, 'awaitCount']
    ] as const) {
      const err = await refusal(release(fake.ctx, { network: NETWORK, election: ELECTION, ...args }))
      expect(err.code, field).to.equal('bad-args')
      expect(err.message, field).to.equal(`keyholder release refused (bad-args) field=${field}`)
    }
    const boundMs = await refusal(dkg(fake.ctx, { network: NETWORK, election: ELECTION, boundMs: 999 }))
    expect(boundMs.message).to.equal('keyholder dkg refused (bad-args) field=boundMs')
    expect(fake.opens()).to.equal(0)
  })

  it('a second verb on the same peer refuses keyholder-busy and the lock frees after a throw', async () => {
    let release1: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release1 = r
    })
    const first = withKeyholderVerbLock(fake.ctx, 'dkg', async () => {
      await gate
      throw new KeyholderVerbError('dkg', 'dkg-timeout')
    })
    const busy = await refusal(withKeyholderVerbLock(fake.ctx, 'release', async () => 'never'))
    expect(busy.name).to.equal('KeyholderVerbError')
    expect(busy.code).to.equal('keyholder-busy')
    expect(busy.message).to.equal('keyholder release refused (keyholder-busy)')
    release1()
    expect((await refusal(first)).code).to.equal('dkg-timeout')
    expect(await withKeyholderVerbLock(fake.ctx, 'release', async () => 'free')).to.equal('free')
    // a different peer (another ctx object) is independent
    const other = makeCtx(join(root, 'home-other'))
    try {
      expect(await withKeyholderVerbLock(other.ctx, 'accept', async () => 'other')).to.equal('other')
    } finally {
      other.close()
    }
  })

  it('keyholderErrorCode keeps machine codes and maps free text to unknown', () => {
    expect(keyholderErrorCode({ code: 'auth-denied' })).to.equal('auth-denied')
    expect(keyholderErrorCode({ name: 'InviteShareError', code: 'already-answered' })).to.equal('already-answered')
    expect(keyholderErrorCode({ name: 'KeyholderAcceptError', code: 'seat-already-held' })).to.equal('seat-already-held')
    expect(keyholderErrorCode({ name: 'InviteLookupTimeoutError', code: 'invite-lookup-timeout' })).to.equal('lookup-timeout')
    expect(keyholderErrorCode({ code: 'Has Spaces And Caps' })).to.equal('unknown')
    expect(keyholderErrorCode({ code: 'x'.repeat(49) })).to.equal('unknown')
    expect(keyholderErrorCode({ code: 42 })).to.equal('unknown')
    expect(keyholderErrorCode(new Error('block abc123 unreadable'))).to.equal('unknown')
    expect(keyholderErrorCode(null)).to.equal('unknown')
    expect(keyholderErrorCode('a-string')).to.equal('unknown')
  })

  it('a verb refusal carries the unwraps it cost', async () => {
    const err = await refusal(release(fake.ctx, { network: NETWORK, election: ELECTION }))
    expect(err.code).to.equal('identity-not-found')
    expect(typeof err.unwraps).to.equal('number')
    expect(err.unwraps).to.equal(0)
    expect(err.message).to.equal('keyholder release refused (identity-not-found) unwraps=0')
    const direct = new KeyholderVerbError('accept', 'auth-denied')
    expect(direct.message).to.equal('keyholder accept refused (auth-denied)')
    expect(direct.unwraps).to.equal(undefined)
  })

  it('keyholder join delegates to the shared authority join and refuses a relative codeFile', async () => {
    const fingerprintFile = join(secretsDir, 'fp.txt')
    const base = { expectName: 'T28 Net', expectFingerprintFile: fingerprintFile, networkHash: NETWORK }
    const rel = await refusal(joinVerb(fake.ctx, { ...base, codeFile: 'secrets/code.txt' }))
    expect(rel.name).to.equal('KeyholderVerbError')
    expect(rel.message).to.equal('keyholder join refused (bad-args) field=codeFile')
    const noName = await refusal(joinVerb(fake.ctx, { ...base, expectName: '', codeFile: join(secretsDir, 'code.txt') }))
    expect(noName.message).to.equal('keyholder join refused (bad-args) field=expectName')
    // an absolute but missing code file reaches the shared authority join, which refuses it by its own rule
    const delegated = await refusal(joinVerb(fake.ctx, { ...base, codeFile: join(secretsDir, 'code.txt') }))
    expect(delegated.name).to.equal('NetworkVerbError')
    expect(delegated.code).to.equal('secret-file-missing')
    expect(fake.opens()).to.equal(0)
  })
})
