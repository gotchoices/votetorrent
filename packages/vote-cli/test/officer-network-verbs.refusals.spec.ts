// officer-network-verbs.refusals.spec.ts: every refusal path of the six officer network verbs, through a
// REAL ctl server (67-12) over a fake officer context whose node and engine THROW on any access, so each
// refusal is proven to happen before any node, engine or vault work. Offline; mkdtemp homes. No reply
// may carry a sentinel value, and every refusal is a 500 NetworkVerbError-class view that exits 1.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalContext, writeApprovalTokenFile } from '../src/approval/token.js'
import { callCtl, exitCodeFor, type CtlReply } from '../src/ctl/ctl-client.js'
import { startCtlServer, type CtlServerHandle } from '../src/ctl/ctl-server.js'
import { defineVerbRegistry } from '../src/ctl/verb-registry.js'
import { AUTHORITY_USER_FILE, ensureAuthorityUser } from '../src/network/authority-user.js'
import type { OfficerVerbContext } from '../src/network/network-verb-support.js'
import { REPO_ROOT } from '../src/run/options.js'
import { OFFICER_NETWORK_VERBS, OFFICER_NETWORK_VERB_NAMES } from '../src/verbs/officer/network-verbs.js'
import { OFFICER_VERB_ENTRIES } from '../src/verbs/officer/registry.js'
import { makeFakeOfficerCtx, type FakeOfficerCtx, type FakeOfficerCtxOptions } from './support/fake-officer-ctx.js'

const SENTINEL = 'SENTINEL-' + randomBytes(8).toString('hex')
const HASH = randomBytes(16).toString('hex')

interface ErrorView {
  name: string
  code?: string
  message?: string
  chain?: string[]
  stack?: unknown
}

describe('officer network verbs: refusals over ctl', function () {
  this.timeout(30000)
  let root: string
  let server: CtlServerHandle
  let ctlDir: string
  const homes: FakeOfficerCtx[] = []
  const refusals: CtlReply[] = []
  let n = 0
  // the server holds ONE ctx: a forwarder to whichever fake the current test installed
  const holder: { current: FakeOfficerCtx | undefined } = { current: undefined }
  const forwarder = new Proxy({} as OfficerVerbContext, {
    get: (_t, prop) => Reflect.get(holder.current as object, prop)
  })

  const fresh = (opts: Partial<FakeOfficerCtxOptions> = {}): FakeOfficerCtx => {
    const ctx = makeFakeOfficerCtx({ partyId: 'vt-t24-' + randomBytes(3).toString('hex'), home: join(root, `h${++n}`), ...opts })
    homes.push(ctx)
    holder.current = ctx
    return ctx
  }
  const token = (ctx: FakeOfficerCtx, name = 'officer.token'): string => {
    const p = join(ctx.secretsDir, name)
    writeApprovalTokenFile(p)
    return p
  }
  const call = async (verb: string, args: Record<string, unknown> = {}): Promise<CtlReply> => {
    const reply = await callCtl({ dir: ctlDir, role: 'officer', verb, args })
    if (reply.body.ok !== true) refusals.push(reply)
    return reply
  }
  const refused = async (verb: string, args: Record<string, unknown> = {}): Promise<ErrorView> => {
    const reply = await call(verb, args)
    expect(reply.status, `${verb} status`).to.equal(500)
    expect(reply.body.ok).to.equal(false)
    return reply.body.error as ErrorView
  }
  const expectCode = async (verb: string, args: Record<string, unknown>, code: string, name = 'NetworkVerbError'): Promise<ErrorView> => {
    const err = await refused(verb, args)
    expect(err.name, `${verb} -> ${String(err.code)} ${String(err.message)}`).to.equal(name)
    expect(err.code, `${verb} code`).to.equal(code)
    return err
  }
  const vaultRecords = (ctx: FakeOfficerCtx): number => {
    const dir = join(ctx.peerDir, 'vault', 'records')
    return existsSync(dir) ? readdirSync(dir).length : 0
  }

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'vt-24r-'))
    chmodSync(root, 0o700)
    ctlDir = join(root, 'ctl')
    server = await startCtlServer<OfficerVerbContext>({ dir: ctlDir, role: 'officer', registry: defineVerbRegistry(OFFICER_NETWORK_VERBS), ctx: forwarder })
  })

  after(async () => {
    await server?.close()
    for (const h of homes) h.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('the six network verbs are served and listed by the verbs built-in', async () => {
    fresh()
    const reply = await call('verbs')
    expect(reply.status).to.equal(200)
    const listed = (reply.body.result as { verbs: string[] }).verbs
    expect([...listed].sort()).to.deep.equal([...OFFICER_NETWORK_VERB_NAMES].sort())
    expect([...OFFICER_NETWORK_VERB_NAMES].sort()).to.deep.equal(['authority-id', 'dashboard-code', 'found', 'join', 'mint', 'owner-setup'])
    for (const name of OFFICER_NETWORK_VERB_NAMES) expect(typeof OFFICER_NETWORK_VERBS[name]).to.equal('function')
    expect(Object.isFrozen(OFFICER_NETWORK_VERBS)).to.equal(true)
    // the officer registry carries the common verbs, then this group; the election and intake groups are empty stubs today
    expect(Object.keys(OFFICER_VERB_ENTRIES).sort()).to.deep.equal(['authority-id', 'capability', 'dashboard-code', 'found', 'join', 'mint', 'owner-setup', 'readback', 'stop'])
    for (const name of OFFICER_NETWORK_VERB_NAMES) expect(OFFICER_VERB_ENTRIES[name]).to.equal(OFFICER_NETWORK_VERBS[name])
  })

  it('found refuses the production party before any engine, node or vault access', async () => {
    for (const partyId of ['votetorrent', ' VoteTorrent ', 'votetorrent-relay']) {
      const ctx = fresh({ partyId, posture: 'test', acceptTokenAttestations: true })
      const err = await expectCode('found', { name: 'T24 Net', tokenFile: token(ctx) }, 'production-party')
      expect(err.message).to.equal('officer verb refused (production-party)')
      expect(ctx.touches()).to.equal(0)
      expect(vaultRecords(ctx)).to.equal(0)
      expect(existsSync(join(ctx.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
      expect(ctx.device.vault.authPromptCount).to.equal(0)
    }
    // a production-posture daemon is allowed on the production party: the next check (the token) is what refuses
    const prod = fresh({ partyId: 'votetorrent', posture: 'production', acceptTokenAttestations: false })
    const err = await expectCode('found', { name: 'T24 Net' }, 'token-required')
    expect(err.code).to.not.equal('production-party')
    expect(prod.touches()).to.equal(0)
    // join reads its code file before the token, so the first refusal past the party guard is the missing file
    await expectCode('join', { codeFile: join(prod.secretsDir, 'absent.txt'), expectName: 'n', expectFingerprintFile: join(prod.secretsDir, 'fp.txt'), networkHash: HASH }, 'secret-file-missing')
  })

  it('found refuses a missing token file and a bad name without echoing the value', async () => {
    const ctx = fresh()
    const missing = await expectCode('found', { name: 'T24 Net' }, 'token-required')
    expect(missing.message).to.equal('officer verb refused (token-required)')
    const bad = await expectCode('found', { name: `bad\n${SENTINEL}`, tokenFile: token(ctx) }, 'bad-arg')
    expect(bad.message).to.equal('officer verb refused (bad-arg name)')
    const badDomain = await expectCode('found', { name: 'T24 Net', domain: SENTINEL, tokenFile: join(ctx.secretsDir, 'officer.token') }, 'bad-arg')
    expect(badDomain.message).to.equal('officer verb refused (bad-arg domain)')
    const unknown = await expectCode('found', { name: 'T24 Net', tokenFile: join(ctx.secretsDir, 'officer.token'), [SENTINEL]: '1' }, 'unknown-arg')
    expect(unknown.message).to.equal('officer verb refused (unknown-arg)')
    const relative = await expectCode('found', { name: 'T24 Net', tokenFile: 'secrets/officer.token' }, 'secret-path-relative')
    expect(relative.message).to.not.include('secrets/')
    expect(ctx.touches()).to.equal(0)
    expect(existsSync(join(ctx.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
    expect(vaultRecords(ctx)).to.equal(0)
  })

  it('found with a group-readable token file refuses token-refused and writes no identity', async () => {
    const ctx = fresh()
    const loose = token(ctx, 'loose.token')
    chmodSync(loose, 0o644)
    const err = await expectCode('found', { name: 'T24 Net', tokenFile: loose }, 'token-refused', 'TokenSignerError')
    expect(err.message).to.not.include(loose)
    expect(existsSync(join(ctx.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
    expect(vaultRecords(ctx)).to.equal(0)
    expect(existsSync(join(ctx.peerDir, 'vault', 'token.check'))).to.equal(false)
    expect(ctx.touches()).to.equal(0)
    const absent = await expectCode('found', { name: 'T24 Net', tokenFile: join(ctx.secretsDir, 'absent.token') }, 'token-refused', 'TokenSignerError')
    expect(absent.message).to.not.include('absent')
  })

  it('mint refuses bad secret targets before minting', async () => {
    const ctx = fresh()
    const good = (name: string): string => join(ctx.secretsDir, name)
    await expectCode('mint', { networkHash: HASH, codeFile: 'relative/code.txt', fingerprintFile: good('fp.txt') }, 'secret-path-relative')
    mkdirSync(join(ctx.peerDir, 'notsecrets'), { mode: 0o700 })
    await expectCode('mint', { networkHash: HASH, codeFile: join(ctx.peerDir, 'notsecrets', 'code.txt'), fingerprintFile: good('fp.txt') }, 'secret-path-parent')
    mkdirSync(join(ctx.peerDir, 'loose', 'secrets'), { recursive: true, mode: 0o755 })
    chmodSync(join(ctx.peerDir, 'loose', 'secrets'), 0o755)
    await expectCode('mint', { networkHash: HASH, codeFile: join(ctx.peerDir, 'loose', 'secrets', 'code.txt'), fingerprintFile: good('fp.txt') }, 'secret-path-mode')
    writeFileSync(good('exists.txt'), 'x', { mode: 0o600 })
    await expectCode('mint', { networkHash: HASH, codeFile: good('exists.txt'), fingerprintFile: good('fp.txt') }, 'secret-file-exists')
    await expectCode('mint', { networkHash: HASH, codeFile: good('fp.txt'), fingerprintFile: good('exists.txt') }, 'secret-file-exists')
    await expectCode('mint', { networkHash: HASH, codeFile: good('same.txt'), fingerprintFile: good('same.txt') }, 'secret-path-same')
    const inRepo = join(REPO_ROOT, 'packages', 'vote-cli', 'secrets', `t24-${SENTINEL}.txt`)
    const err = await expectCode('mint', { networkHash: HASH, codeFile: inRepo, fingerprintFile: good('fp.txt') }, 'secret-path-in-repo')
    expect(err.message).to.not.include(SENTINEL)
    expect(existsSync(join(REPO_ROOT, 'packages', 'vote-cli', 'secrets'))).to.equal(false)
    expect(ctx.touches()).to.equal(0)
    expect(existsSync(good('fp.txt'))).to.equal(false)
    expect(existsSync(good('same.txt'))).to.equal(false)
  })

  it('mint, authority-id and dashboard-code refuse a malformed network hash', async () => {
    const ctx = fresh()
    for (const bad of ['xyz', HASH.toUpperCase(), HASH.slice(0, 31), SENTINEL]) {
      const m = await expectCode('mint', { networkHash: bad, codeFile: join(ctx.secretsDir, 'c.txt'), fingerprintFile: join(ctx.secretsDir, 'f.txt') }, 'bad-network-hash')
      expect(m.message).to.equal('officer verb refused (bad-network-hash)')
      await expectCode('authority-id', { networkHash: bad }, 'bad-network-hash')
      await expectCode('dashboard-code', { networkHash: bad, codeFile: join(ctx.secretsDir, 'd.txt'), tokenFile: join(ctx.secretsDir, 't.token') }, 'bad-network-hash')
    }
    await expectCode('authority-id', {}, 'bad-arg')
    await expectCode('authority-id', { networkHash: 7 }, 'bad-arg')
    expect(ctx.touches()).to.equal(0)
  })

  it('mint and authority-id refuse a network hash this peer does not know', async () => {
    let recentsRead = 0
    const engine = {
      getRecentNetworks: async () => {
        recentsRead++
        return []
      },
      open: async () => {
        throw new Error(SENTINEL)
      }
    }
    const noUser = fresh({ engine })
    await expectCode('mint', { networkHash: HASH, codeFile: join(noUser.secretsDir, 'c.txt'), fingerprintFile: join(noUser.secretsDir, 'f.txt') }, 'identity-absent')
    expect(recentsRead).to.equal(0)
    const ctx = fresh({ engine })
    await ensureAuthorityUser(ctx, createApprovalContext({ file: token(ctx) }), { name: 'Officer A' })
    await expectCode('mint', { networkHash: HASH, codeFile: join(ctx.secretsDir, 'c.txt'), fingerprintFile: join(ctx.secretsDir, 'f.txt') }, 'network-unknown')
    await expectCode('authority-id', { networkHash: HASH }, 'network-unknown')
    expect(recentsRead).to.equal(2)
    expect(ctx.touches()).to.equal(0)
    expect(existsSync(join(ctx.secretsDir, 'c.txt'))).to.equal(false)
  })

  it('join refuses a group-readable or symlinked code file and a malformed code', async () => {
    const ctx = fresh()
    const fp = join(ctx.secretsDir, 'fp.txt')
    writeFileSync(fp, 'ab12cd34\n', { mode: 0o600 })
    const base = { expectName: 'T24 Net', expectFingerprintFile: fp, networkHash: HASH, tokenFile: token(ctx) }
    const loose = join(ctx.secretsDir, 'loose-code.txt')
    writeFileSync(loose, `vt-join:2.${SENTINEL}\n`, { mode: 0o644 })
    const modeErr = await expectCode('join', { ...base, codeFile: loose }, 'mode', 'PrivateFileError')
    expect(modeErr.message).to.not.include(SENTINEL)
    const target = join(ctx.secretsDir, 'real-code.txt')
    writeFileSync(target, `vt-join:2.${SENTINEL}\n`, { mode: 0o600 })
    symlinkSync(target, join(ctx.secretsDir, 'link-code.txt'))
    await expectCode('join', { ...base, codeFile: join(ctx.secretsDir, 'link-code.txt') }, 'not-file', 'PrivateFileError')
    const junk = join(ctx.secretsDir, 'junk.txt')
    writeFileSync(junk, `not a join code ${SENTINEL}\n`, { mode: 0o600 })
    const malformed = await expectCode('join', { ...base, codeFile: junk }, 'preview-malformed')
    expect(malformed.message).to.equal('officer verb refused (preview-malformed)')
    await expectCode('join', { ...base, codeFile: join(ctx.secretsDir, 'absent.txt') }, 'secret-file-missing')
    await expectCode('join', { ...base, codeFile: 'relative.txt' }, 'secret-path-relative')
    await expectCode('join', { ...base, codeFile: junk, timeoutMs: '5' }, 'bad-arg')
    await expectCode('join', { ...base, codeFile: junk, networkHash: 'nope' }, 'bad-network-hash')
    expect(ctx.touches()).to.equal(0)
    expect(existsSync(join(ctx.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
  })

  it('join refuses the production party', async () => {
    for (const partyId of ['votetorrent', 'Votetorrent-Relay']) {
      const ctx = fresh({ partyId, posture: 'test', acceptTokenAttestations: true })
      const fp = join(ctx.secretsDir, 'fp.txt')
      writeFileSync(fp, 'ab12cd34\n', { mode: 0o600 })
      const err = await expectCode('join', { codeFile: join(ctx.secretsDir, 'c.txt'), expectName: 'n', expectFingerprintFile: fp, networkHash: HASH, tokenFile: token(ctx) }, 'production-party')
      expect(err.message).to.equal('officer verb refused (production-party)')
      expect(ctx.touches()).to.equal(0)
      expect(ctx.device.vault.authPromptCount).to.equal(0)
    }
  })

  it('owner-setup refuses not-owner and owner-setup-unavailable without a write, and never returns key material', async () => {
    const OWNER = 'owner-' + SENTINEL
    const IDENTITY_PUB = 'identity-pub-' + SENTINEL
    const IDENTITY_PRIV = 'identity-priv-' + SENTINEL
    const counts = { ensureOwnerKey: 0, trustOwnerKeys: 0, initializeSeedBootstrap: 0 }
    const makeNode = (owners: Set<string>, db = true): object => ({
      peerId: { toString: () => '12D3KooWFakeOfficerPeer' },
      getIdentityOwnerKey: () => ({ publicKeyB64: IDENTITY_PUB, privateKeyB64: IDENTITY_PRIV }),
      getControlDatabase: () =>
        db
          ? {
              getOwnerKeys: async () => new Set(owners),
              ensureOwnerKey: async (key: string) => {
                counts.ensureOwnerKey++
                const added = !owners.has(key)
                owners.add(key)
                return added
              },
              queryCadrePeers: async () => []
            }
          : null,
      trustOwnerKeys: async () => {
        counts.trustOwnerKeys++
      },
      initializeSeedBootstrap: async () => {
        counts.initializeSeedBootstrap++
      },
      getSeedBootstrapService: () => null
    })
    fresh({ node: makeNode(new Set([OWNER])) })
    const notOwner = await expectCode('owner-setup', {}, 'not-owner')
    expect(notOwner.message).to.equal('officer verb refused (not-owner)')
    expect(counts).to.deep.equal({ ensureOwnerKey: 0, trustOwnerKeys: 0, initializeSeedBootstrap: 0 })
    fresh({ node: makeNode(new Set(), false) })
    await expectCode('owner-setup', {}, 'owner-setup-unavailable')
    expect(counts).to.deep.equal({ ensureOwnerKey: 0, trustOwnerKeys: 0, initializeSeedBootstrap: 0 })
    fresh({ node: makeNode(new Set([OWNER])) })
    await expectCode('owner-setup', { extra: '1' }, 'unknown-arg')
    // the needs-owner-setup path: one ensureOwnerKey, one trustOwnerKeys, one initializeSeedBootstrap; booleans and a count back
    fresh({ node: makeNode(new Set()) })
    const reply = await call('owner-setup')
    expect(reply.status).to.equal(200)
    const text = JSON.stringify(reply.body)
    expect(reply.body.result).to.deep.equal({ capabilityBefore: 'needs-owner-setup', capabilityAfter: 'ready', ownerCount: 1, ownerIsIdentity: true })
    expect(Object.keys(reply.body.result!).sort()).to.deep.equal(['capabilityAfter', 'capabilityBefore', 'ownerCount', 'ownerIsIdentity'])
    expect(counts).to.deep.equal({ ensureOwnerKey: 1, trustOwnerKeys: 1, initializeSeedBootstrap: 1 })
    for (const secret of [OWNER, IDENTITY_PUB, IDENTITY_PRIV, SENTINEL]) {
      expect(text).to.not.include(secret)
      for (let i = 0; i + 16 <= secret.length; i++) expect(text).to.not.include(secret.slice(i, i + 16))
    }
  })

  it('dashboard-code refuses a missing token file and an existing code file before signing', async () => {
    const ctx = fresh()
    const codeFile = join(ctx.secretsDir, 'dash.txt')
    const missing = await expectCode('dashboard-code', { networkHash: HASH, codeFile }, 'token-required')
    expect(missing.message).to.equal('officer verb refused (token-required)')
    writeFileSync(codeFile, 'x', { mode: 0o600 })
    await expectCode('dashboard-code', { networkHash: HASH, codeFile, tokenFile: token(ctx) }, 'secret-file-exists')
    await expectCode('dashboard-code', { networkHash: HASH, codeFile: 'relative.txt', tokenFile: join(ctx.secretsDir, 'officer.token') }, 'secret-path-relative')
    await expectCode('dashboard-code', { networkHash: HASH, codeFile: join(ctx.secretsDir, 'fresh.txt'), tokenFile: join(ctx.secretsDir, 'officer.token'), [SENTINEL]: 'x' }, 'unknown-arg')
    expect(ctx.touches()).to.equal(0)
    expect(ctx.device.vault.authPromptCount).to.equal(0)
    expect(existsSync(join(ctx.peerDir, AUTHORITY_USER_FILE))).to.equal(false)
  })

  it('every refusal is a 500 NetworkVerbError view with a code, no stack and no sentinel, and the client exits 1', () => {
    expect(refusals.length).to.be.at.least(40)
    for (const reply of refusals) {
      expect(reply.status).to.equal(500)
      expect(reply.body.ok).to.equal(false)
      const err = reply.body.error as ErrorView
      expect(['NetworkVerbError', 'TokenSignerError', 'PrivateFileError']).to.include(err.name)
      expect(typeof err.code).to.equal('string')
      expect(err.code!.length).to.be.greaterThan(0)
      expect(typeof err.message).to.equal('string')
      expect(err.message!.length).to.be.at.most(200)
      expect(Array.isArray(err.chain)).to.equal(true)
      expect('stack' in err).to.equal(false)
      expect(Object.keys(err).sort()).to.deep.equal(['chain', 'code', 'message', 'name'])
      const text = JSON.stringify(reply.body)
      expect(text).to.not.include(SENTINEL)
      expect(text).to.not.include(root)
      expect(exitCodeFor(reply)).to.equal(1)
    }
  })
})
