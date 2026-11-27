// network-verb-support.spec.ts: the officer verb support (arg checks, the secret-file rules, the party
// guard, hash parsing, the authority user over a REAL device vault and token files, network access by
// hash over a fake engine, and the fixed refusal messages). Offline; mkdtemp homes under os.tmpdir().
// Nothing here prints a token, a key or a path.

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTokenSigningPublicKey } from '../src/approval/signer.js'
import { createApprovalContext, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { AUTHORITY_SIGNING_ALIAS, AUTHORITY_USER_FILE, ensureAuthorityUser, loadAuthorityUser } from '../src/network/authority-user.js'
import { AUTHORITY_KEY_LIFETIME_MS } from '../src/network/network-init.js'
import {
  NetworkVerbError,
  assertNetworkParty,
  assertSecretTarget,
  assertTestParty,
  checkArgs,
  openKnownNetwork,
  parseAuthorityId8,
  parseNetworkHash,
  resolvePrimaryAuthority,
  resolveVerbApproval,
  writeSecretFile
} from '../src/network/network-verb-support.js'
import { REPO_ROOT } from '../src/run/options.js'
import { makeFakeOfficerCtx, type FakeOfficerCtx } from './support/fake-officer-ctx.js'

const SENTINEL = 'SENTINEL-' + randomBytes(6).toString('hex')
const COMPRESSED_RE = /^(02|03)[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const mode = (p: string): number => statSync(p).mode & 0o777

interface Refusal {
  name: string
  code: string
  message: string
}

async function refusal(fn: () => unknown): Promise<Refusal> {
  try {
    await fn()
  } catch (e) {
    const err = e as { name?: unknown, code?: unknown, message?: unknown }
    return { name: String(err.name), code: String(err.code), message: String(err.message) }
  }
  throw new Error('expected a refusal')
}

function countingApproval(inner: ApprovalContext): ApprovalContext & { reads(): number } {
  let n = 0
  return {
    token: async () => {
      n++
      return inner.token()
    },
    reads: () => n
  }
}

describe('network verb support', function () {
  this.timeout(30000)
  let root: string
  const homes: FakeOfficerCtx[] = []

  const fresh = (name: string, opts: Partial<Parameters<typeof makeFakeOfficerCtx>[0]> = {}): FakeOfficerCtx => {
    const ctx = makeFakeOfficerCtx({ partyId: 'vt-t24-' + randomBytes(3).toString('hex'), home: join(root, name), ...opts })
    homes.push(ctx)
    return ctx
  }
  const tokenFile = (ctx: FakeOfficerCtx, name: string): string => {
    const p = join(ctx.secretsDir, name)
    writeApprovalTokenFile(p)
    return p
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-24s-'))
    chmodSync(root, 0o700)
  })

  after(() => {
    for (const h of homes) h.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('checkArgs refuses an unknown key without echoing it and allows the colocation peer key', async () => {
    const unknown = await refusal(() => checkArgs({ name: 'x', peer: 'officer', ['k' + SENTINEL]: SENTINEL }, { required: ['name'] }))
    expect(unknown.name).to.equal('NetworkVerbError')
    expect(unknown.code).to.equal('unknown-arg')
    expect(unknown.message).to.equal('officer verb refused (unknown-arg)')
    expect(unknown.message).to.not.include(SENTINEL)
    expect(checkArgs({ name: 'x', peer: 'officer' }, { required: ['name'] })).to.deep.equal({ name: 'x' })
    expect(checkArgs({ name: 'x', domain: 'a.b' }, { required: ['name'], optional: ['domain'] })).to.deep.equal({ name: 'x', domain: 'a.b' })
    const missing = await refusal(() => checkArgs({}, { required: ['name'] }))
    expect(missing.code).to.equal('bad-arg')
    expect(missing.message).to.equal('officer verb refused (bad-arg name)')
    const notString = await refusal(() => checkArgs({ name: 5 }, { required: ['name'] }))
    expect(notString.message).to.equal('officer verb refused (bad-arg name)')
    const optionalNotString = await refusal(() => checkArgs({ name: 'x', domain: true }, { required: ['name'], optional: ['domain'] }))
    expect(optionalNotString.message).to.equal('officer verb refused (bad-arg domain)')
  })

  it('assertSecretTarget refuses relative, in-repo, wrong-parent, symlinked-parent and group-readable-parent targets', async () => {
    const home = join(root, 'targets')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    expect((await refusal(() => assertSecretTarget('secrets/x.txt'))).code).to.equal('secret-path-relative')
    const inRepo = join(REPO_ROOT, 'packages', 'vote-cli', 'secrets', 't24-' + SENTINEL)
    const inRepoRefusal = await refusal(() => assertSecretTarget(inRepo))
    expect(inRepoRefusal.code).to.equal('secret-path-in-repo')
    expect(inRepoRefusal.message).to.not.include(SENTINEL)
    expect(existsSync(join(REPO_ROOT, 'packages', 'vote-cli', 'secrets'))).to.equal(false)
    mkdirSync(join(home, 'notsecrets'), { mode: 0o700 })
    expect((await refusal(() => assertSecretTarget(join(home, 'notsecrets', 'x.txt')))).code).to.equal('secret-path-parent')
    expect((await refusal(() => assertSecretTarget(join(home, 'missing', 'secrets', 'x.txt')))).code).to.equal('secret-path-parent')
    mkdirSync(join(home, 'real'), { mode: 0o700 })
    mkdirSync(join(home, 'real', 'secrets'), { mode: 0o700 })
    mkdirSync(join(home, 'alt'), { mode: 0o700 })
    symlinkSync(join(home, 'real', 'secrets'), join(home, 'alt', 'secrets'))
    expect((await refusal(() => assertSecretTarget(join(home, 'alt', 'secrets', 'x.txt')))).code).to.equal('secret-path-parent')
    mkdirSync(join(home, 'grp'), { mode: 0o700 })
    mkdirSync(join(home, 'grp', 'secrets'), { mode: 0o750 })
    chmodSync(join(home, 'grp', 'secrets'), 0o750)
    expect((await refusal(() => assertSecretTarget(join(home, 'grp', 'secrets', 'x.txt')))).code).to.equal('secret-path-mode')
    expect(assertSecretTarget(join(home, 'real', 'secrets', 'fresh.txt'))).to.equal(join(home, 'real', 'secrets', 'fresh.txt'))
  })

  it('assertSecretTarget refuses an existing file and a foreign-owner check is wired', async () => {
    const home = join(root, 'owner')
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    writeFileSync(join(home, 'secrets', 'exists.txt'), 'x', { mode: 0o600 })
    expect((await refusal(() => assertSecretTarget(join(home, 'secrets', 'exists.txt')))).code).to.equal('secret-file-exists')
    symlinkSync(join(home, 'secrets', 'exists.txt'), join(home, 'secrets', 'link.txt'))
    expect((await refusal(() => assertSecretTarget(join(home, 'secrets', 'link.txt')))).code).to.equal('secret-file-exists')
    const realGetuid = process.getuid
    expect(typeof realGetuid).to.equal('function')
    const uid = realGetuid!()
    process.getuid = () => uid + 1
    try {
      expect((await refusal(() => assertSecretTarget(join(home, 'secrets', 'fresh.txt')))).code).to.equal('secret-path-owner')
    } finally {
      process.getuid = realGetuid
    }
    expect(assertSecretTarget(join(home, 'secrets', 'fresh.txt'))).to.equal(join(home, 'secrets', 'fresh.txt'))
  })

  it('writeSecretFile creates a 0600 file once and refuses a second write', async () => {
    const home = join(root, 'write')
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    const p = join(home, 'secrets', 'code.txt')
    expect(writeSecretFile(p, 'first-' + SENTINEL)).to.equal(p)
    expect(mode(p)).to.equal(0o600)
    expect(readFileSync(p, 'utf8')).to.equal('first-' + SENTINEL + '\n')
    const again = await refusal(() => writeSecretFile(p, 'second'))
    expect(again.code).to.equal('secret-file-exists')
    expect(again.message).to.not.include(SENTINEL)
    expect(readFileSync(p, 'utf8')).to.equal('first-' + SENTINEL + '\n')
  })

  it('assertTestParty refuses votetorrent and votetorrent-relay in any case and spacing', async () => {
    for (const party of ['votetorrent', ' VoteTorrent ', 'votetorrent-relay', 'VOTETORRENT-RELAY ', '\tVotetorrent\n']) {
      const r = await refusal(() => assertTestParty(party))
      expect(r.name).to.equal('NetworkVerbError')
      expect(r.code).to.equal('production-party')
      expect(r.message).to.equal('officer verb refused (production-party)')
    }
    expect(() => assertTestParty('vt-t24-abc')).to.not.throw()
    expect(() => assertTestParty('votetorrent2')).to.not.throw()
    // the posture-aware guard: a production-posture daemon on the production party is allowed, a test-posture one is not
    expect(() => assertNetworkParty({ partyId: 'votetorrent', posture: 'production', acceptTokenAttestations: false })).to.not.throw()
    expect((await refusal(() => assertNetworkParty({ partyId: 'votetorrent', posture: 'test', acceptTokenAttestations: true }))).code).to.equal('production-party')
    expect((await refusal(() => assertNetworkParty({ partyId: 'votetorrent-relay', posture: 'production', acceptTokenAttestations: true }))).code).to.equal('production-party')
    expect(() => assertNetworkParty({ partyId: 'vt-t24-abc', posture: 'test', acceptTokenAttestations: true })).to.not.throw()
  })

  it('parseNetworkHash and parseAuthorityId8 accept only lowercase hex of length 32 and 8', async () => {
    const hash = randomBytes(16).toString('hex')
    expect(parseNetworkHash(hash)).to.equal(hash)
    for (const bad of [hash.toUpperCase(), hash.slice(1), hash + 'a', 'g'.repeat(32), '', 5, undefined, null]) {
      const r = await refusal(() => parseNetworkHash(bad))
      expect(r.code).to.equal('bad-network-hash')
      expect(r.message).to.equal('officer verb refused (bad-network-hash)')
    }
    expect(parseAuthorityId8('deadbeef')).to.equal('deadbeef')
    for (const bad of ['DEADBEEF', 'deadbee', 'deadbeef0', '', 7]) {
      expect((await refusal(() => parseAuthorityId8(bad))).code).to.equal('bad-authority-id8')
    }
  })

  it('ensureAuthorityUser provisions a secp256k1 user on first use and writes only public fields 0600', async () => {
    const ctx = fresh('provision')
    const approval = countingApproval(createApprovalContext({ file: tokenFile(ctx, 'officer.token') }))
    const before = Date.now()
    const user = await ensureAuthorityUser(ctx, approval, { name: 'Officer A' })
    expect(user.id).to.match(UUID_RE)
    expect(user.name).to.equal('Officer A')
    expect(user.activeKeys).to.have.lengthOf(1)
    expect(user.activeKeys[0]!.key).to.match(COMPRESSED_RE)
    expect(user.activeKeys[0]!.type).to.equal('M')
    expect(user.activeKeys[0]!.expiration).to.be.at.least(before + AUTHORITY_KEY_LIFETIME_MS)
    expect(user.activeKeys[0]!.expiration).to.be.at.most(Date.now() + AUTHORITY_KEY_LIFETIME_MS)
    const file = join(ctx.peerDir, AUTHORITY_USER_FILE)
    expect(mode(file)).to.equal(0o600)
    const text = readFileSync(file, 'utf8')
    const stored = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(stored).sort()).to.deep.equal(['activeKeys', 'id', 'name'])
    expect(/priv|secret|seed/i.test(text)).to.equal(false)
    expect(await readTokenSigningPublicKey({ vault: ctx.device.vault, alias: AUTHORITY_SIGNING_ALIAS })).to.equal(user.activeKeys[0]!.key)
    expect(approval.reads()).to.be.at.least(1)
    expect(ctx.touches()).to.equal(0)
    expect(ctx.user?.id).to.equal(user.id)
  })

  it('ensureAuthorityUser on a second call proves the token and returns the same user', async () => {
    const ctx = fresh('again')
    const approval = countingApproval(createApprovalContext({ file: tokenFile(ctx, 'officer.token') }))
    const first = await ensureAuthorityUser(ctx, approval, { name: 'Officer A' })
    const reads = approval.reads()
    const prompts = ctx.device.vault.authPromptCount
    const second = await ensureAuthorityUser(ctx, approval, { name: 'Another Name' })
    expect(second.id).to.equal(first.id)
    expect(second.activeKeys[0]!.key).to.equal(first.activeKeys[0]!.key)
    expect(second.name).to.equal(first.name)
    expect(approval.reads()).to.equal(reads + 1)
    expect(ctx.device.vault.authPromptCount).to.equal(prompts + 1)
    expect(await loadAuthorityUser(ctx)).to.deep.equal(first)
  })

  it('ensureAuthorityUser refuses a wrong token with token-refused and changes nothing', async () => {
    const ctx = fresh('wrong')
    const right = createApprovalContext({ file: tokenFile(ctx, 'right.token') })
    const wrong = createApprovalContext({ file: tokenFile(ctx, 'wrong.token') })
    const user = await ensureAuthorityUser(ctx, right, { name: 'Officer A' })
    const file = join(ctx.peerDir, AUTHORITY_USER_FILE)
    const textBefore = readFileSync(file, 'utf8')
    const prompts = ctx.device.vault.authPromptCount
    const r = await refusal(() => ensureAuthorityUser(ctx, wrong, { name: 'Officer A' }))
    expect(r.name).to.equal('TokenSignerError')
    expect(r.code).to.equal('token-refused')
    expect(readFileSync(file, 'utf8')).to.equal(textBefore)
    expect(await readTokenSigningPublicKey({ vault: ctx.device.vault, alias: AUTHORITY_SIGNING_ALIAS })).to.equal(user.activeKeys[0]!.key)
    expect(ctx.device.vault.authPromptCount).to.equal(prompts + 1)
    // a fresh home with a wrong (group-readable) token file provisions nothing at all
    const ctx2 = fresh('wrong-fresh')
    const loose = tokenFile(ctx2, 'loose.token')
    chmodSync(loose, 0o644)
    const r2 = await refusal(() => ensureAuthorityUser(ctx2, createApprovalContext({ file: loose }), { name: 'Officer B' }))
    expect(r2.name).to.equal('TokenSignerError')
    expect(r2.code).to.equal('token-refused')
    expect(existsSync(join(ctx2.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
    expect(await readTokenSigningPublicKey({ vault: ctx2.device.vault, alias: AUTHORITY_SIGNING_ALIAS })).to.equal(null)
  })

  it('ensureAuthorityUser refuses identity-mismatch when the user file key differs from the vault key', async () => {
    const ctx = fresh('mismatch')
    const approval = createApprovalContext({ file: tokenFile(ctx, 'officer.token') })
    const user = await ensureAuthorityUser(ctx, approval, { name: 'Officer A' })
    const otherKey = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    await ctx.saveUser({ ...user, activeKeys: [{ ...user.activeKeys[0]!, key: otherKey }] })
    const r = await refusal(() => ensureAuthorityUser(ctx, approval, { name: 'Officer A' }))
    expect(r.name).to.equal('NetworkVerbError')
    expect(r.code).to.equal('identity-mismatch')
    expect(r.message).to.equal('officer verb refused (identity-mismatch)')
    // a corrupt user record is refused too
    const ctx2 = fresh('corrupt')
    await ctx2.saveUser({ id: 'not-a-uuid', name: 'x', activeKeys: [] })
    expect((await refusal(() => loadAuthorityUser(ctx2))).code).to.equal('identity-corrupt')
  })

  it('loadAuthorityUser returns null before provisioning and never reads the token', async () => {
    const ctx = fresh('load')
    const approval = countingApproval(createApprovalContext({ file: tokenFile(ctx, 'officer.token') }))
    expect(await loadAuthorityUser(ctx)).to.equal(null)
    expect(approval.reads()).to.equal(0)
    expect(ctx.device.vault.authPromptCount).to.equal(0)
    expect(ctx.touches()).to.equal(0)
    // resolveVerbApproval: file path only, absolute only
    expect((await refusal(() => resolveVerbApproval({}))).code).to.equal('token-required')
    expect((await refusal(() => resolveVerbApproval({ tokenFile: 'secrets/t.token' }))).code).to.equal('secret-path-relative')
    const ctxApproval = resolveVerbApproval({ tokenFile: join(ctx.secretsDir, 'officer.token') })
    expect((await ctxApproval.token()).length).to.be.at.least(32)
  })

  it('openKnownNetwork refuses network-unknown and resolvePrimaryAuthority refuses authority-mismatch', async () => {
    const known = randomBytes(16).toString('hex')
    const authorityId = randomBytes(16).toString('hex')
    let opened = 0
    const network = {
      getDetails: async () => ({ network: { primaryAuthorityId: authorityId } }),
      openAuthority: async (id: string) => ({ id })
    }
    const engine = {
      getRecentNetworks: async () => [{ hash: known, name: 'Known' }],
      open: async () => {
        opened++
        return network
      }
    }
    const ctx = fresh('open', { engine })
    const unknown = await refusal(() => openKnownNetwork(ctx, randomBytes(16).toString('hex')))
    expect(unknown.code).to.equal('network-unknown')
    expect(opened).to.equal(0)
    expect((await refusal(() => openKnownNetwork(ctx, 'nope'))).code).to.equal('bad-network-hash')
    const got = await openKnownNetwork(ctx, known)
    expect(got.ref.hash).to.equal(known)
    expect(got.network).to.equal(network)
    expect(opened).to.equal(1)
    const mismatch = await refusal(() => resolvePrimaryAuthority(ctx, { networkHash: known, authorityId8: 'deadbeef' }))
    expect(mismatch.code).to.equal('authority-mismatch')
    expect(mismatch.message).to.not.include(authorityId.slice(0, 8))
    const ok = await resolvePrimaryAuthority(ctx, { networkHash: known, authorityId8: authorityId.slice(0, 8) })
    expect(ok.authorityId).to.equal(authorityId)
    expect((ok.authority as unknown as { id: string }).id).to.equal(authorityId)
    expect(ok.network).to.equal(network)
    const broken = fresh('open-broken', {
      engine: { getRecentNetworks: async () => [{ hash: known }], open: async () => ({ getDetails: async () => { throw new Error(SENTINEL) } }) }
    })
    const unreadable = await refusal(() => resolvePrimaryAuthority(broken, { networkHash: known, authorityId8: 'deadbeef' }))
    expect(unreadable.code).to.equal('authority-unreadable')
    expect(unreadable.message).to.not.include(SENTINEL)
  })

  it('NetworkVerbError messages carry only the code and an allow-listed arg name', async () => {
    const plain = new NetworkVerbError('network-unknown')
    expect(plain.name).to.equal('NetworkVerbError')
    expect(plain.code).to.equal('network-unknown')
    expect(plain.message).to.equal('officer verb refused (network-unknown)')
    const withArg = new NetworkVerbError('bad-arg', { argName: 'name' })
    expect(withArg.message).to.equal('officer verb refused (bad-arg name)')
    const cause = new Error(SENTINEL)
    const withCause = new NetworkVerbError('join-failed', { cause })
    expect(withCause.cause).to.equal(cause)
    expect(withCause.message).to.not.include(SENTINEL)
    expect(JSON.stringify(withCause)).to.not.include(SENTINEL)
    expect(Object.keys(withCause)).to.not.include('cause')
    const fromPath = await refusal(() => assertSecretTarget(`relative/${SENTINEL}`))
    expect(fromPath.message).to.equal('officer verb refused (secret-path-relative)')
    const fromHash = await refusal(() => parseNetworkHash(SENTINEL))
    expect(fromHash.message).to.not.include(SENTINEL)
  })
})
