// network-init.spec.ts: the CLI-owned founding builders (buildNetworkInit / buildAuthorityUser) have the
// engine fixtures' NetworkInit / User shapes minus the media fields, carry the schema's nine Scope codes,
// the app's founding threshold policies, and refuse bad inputs with bad-arg. The shapes are pinned in
// test/golden/network-init-shape.json, which was proven equal to the engine fixtures' shapes (minus
// imageUrl / imageRef) in the commit "founding builders match the engine fixture shapes"; the fixture
// import was dropped in the next one, so nothing under vote-cli depends on the engine's test fixtures.

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { AUTHORITY_KEY_LIFETIME_MS, FOUNDING_SCOPES, FOUNDING_THRESHOLD_POLICIES, buildAuthorityUser, buildNetworkInit } from '../src/network/network-init.js'
import { REPO_ROOT } from '../src/run/options.js'

type Shape = string | Shape[] | { [k: string]: Shape }

/** An object maps to its sorted keys -> shapeOf, an array to [shapeOf(first)] or [], a primitive to typeof. */
function shapeOf(v: unknown): Shape {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])]
  if (typeof v === 'object' && v !== null) {
    const out: { [k: string]: Shape } = {}
    for (const k of Object.keys(v).sort()) out[k] = shapeOf((v as Record<string, unknown>)[k])
    return out
  }
  return typeof v
}

/** Structural equality where an empty array matches any array shape. */
function sameShape(a: Shape, b: Shape): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 || b.length === 0 || sameShape(a[0]!, b[0]!)
  if (Array.isArray(a) || Array.isArray(b)) return false
  if (typeof a === 'string' || typeof b === 'string') return a === b
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => sameShape(a[k]!, b[k]!))
}

const GOLDEN_PATH = join(REPO_ROOT, 'packages', 'vote-cli', 'test', 'golden', 'network-init-shape.json')
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as { networkInit: Shape, user: Shape, scopes: string[] }
const RELAY = '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWFixtureRelayPeerIdFixtureRelayPeerIdFixtureRe'
const KEY = '02' + 'ab'.repeat(32)
const ID = '0f6d1a2e-5c3b-4d7e-8f90-1234567890ab'

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn()
  } catch (e) {
    const err = e as { code?: unknown, message?: unknown }
    return `${String(err.code)}|${String(err.message)}`
  }
  return 'no-throw'
}

describe('network init: CLI-owned founding builders', () => {
  it("buildNetworkInit output has the engine fixture's NetworkInit shape, without media fields", () => {
    const built = buildNetworkInit({ name: 'T24 Net', relays: [RELAY] })
    expect(sameShape(shapeOf(built), golden.networkInit)).to.equal(true)
    expect('imageUrl' in golden.networkInit).to.equal(false)
    expect('imageUrl' in built).to.equal(false)
    expect('imageCid' in built).to.equal(false)
    expect('imageUrl' in built.primaryAuthority).to.equal(false)
    expect(built.name).to.equal('T24 Net')
    expect(built.primaryAuthority).to.deep.equal({ name: 'T24 Net Authority', domainName: 'authority.vt.invalid' })
    expect(built.admin.officers).to.have.lengthOf(1)
    expect(built.admin.officers[0]!.init!.name).to.equal('vt officer')
    expect(built.admin.officers[0]!.init!.title).to.equal('Chair')
  })

  it("buildAuthorityUser output has the engine fixture's User shape, without imageRef", () => {
    const built = buildAuthorityUser({ id: ID, name: 'Officer', publicKeyHex: KEY, nowMs: 1_700_000_000_000 })
    expect(sameShape(shapeOf(built), golden.user)).to.equal(true)
    expect('imageRef' in golden.user).to.equal(false)
    expect('imageRef' in built).to.equal(false)
    expect(built).to.deep.equal({ id: ID, name: 'Officer', activeKeys: [{ key: KEY, type: 'M', expiration: 1_700_000_000_000 + AUTHORITY_KEY_LIFETIME_MS }] })
  })

  it("founding scopes equal the schema's view Scope codes", () => {
    const schema = readFileSync(join(REPO_ROOT, 'packages', 'vote-core', 'schema', 'votetorrent.qsql'), 'utf8')
    const start = schema.indexOf('view Scope as')
    expect(start).to.be.greaterThan(0)
    const block = schema.slice(start, schema.indexOf(';', start))
    const codes: string[] = []
    for (const line of block.split('\n')) {
      const clean = line.replace(/--.*$/, '')
      for (const m of clean.matchAll(/'([a-z]+)' as Code/g)) codes.push(m[1]!)
    }
    expect(codes).to.have.lengthOf(9)
    expect([...FOUNDING_SCOPES].sort()).to.deep.equal([...codes].sort())
    expect([...FOUNDING_SCOPES]).to.deep.equal(codes)
    expect(golden.scopes).to.deep.equal([...codes].sort())
    expect(Object.isFrozen(FOUNDING_SCOPES)).to.equal(true)
    const built = buildNetworkInit({ name: 'T24 Net', relays: [RELAY] })
    expect([...built.admin.officers[0]!.init!.scopes]).to.deep.equal(codes)
  })

  it('threshold policies are rn, mel and ceb at 1 and the network has no timestamp authorities', () => {
    expect(FOUNDING_THRESHOLD_POLICIES).to.deep.equal([{ policy: 'rn', threshold: 1 }, { policy: 'mel', threshold: 1 }, { policy: 'ceb', threshold: 1 }])
    expect(Object.isFrozen(FOUNDING_THRESHOLD_POLICIES)).to.equal(true)
    const built = buildNetworkInit({ name: 'T24 Net', relays: [RELAY], nowMs: 1_700_000_000_000 })
    expect(built.admin.thresholdPolicies).to.deep.equal(FOUNDING_THRESHOLD_POLICIES)
    expect(built.admin.thresholdPolicies).to.not.equal(FOUNDING_THRESHOLD_POLICIES)
    expect(built.admin.effectiveAt).to.equal(1_700_000_000_000)
    expect(built.policies).to.deep.equal({ timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.official })
    expect(buildNetworkInit({ name: 'T24 Net', relays: [RELAY], electionType: 'adhoc' }).policies.electionType).to.equal(ElectionType.adhoc)
  })

  it('relays are copied from the caller, never shared', () => {
    const relays = [RELAY]
    const built = buildNetworkInit({ name: 'T24 Net', relays })
    expect(built.relays).to.deep.equal(relays)
    expect(built.relays).to.not.equal(relays)
    relays.push('/ip4/10.0.0.1/tcp/1/ws/p2p/x')
    expect(built.relays).to.have.lengthOf(1)
  })

  it('refuses a bad name, domain, election type, an empty relay list or a bad key with bad-arg', async () => {
    const base = { name: 'T24 Net', relays: [RELAY] }
    for (const name of ['', ' lead', 'x'.repeat(65), 'bad\nname', '-dash', 'tab\tname']) {
      expect(await codeOf(() => buildNetworkInit({ ...base, name }))).to.equal('bad-arg|officer verb refused (bad-arg name)')
    }
    for (const domain of ['nodot', 'Upper.Case', 'a..b', '.lead', 'has space.com', 'a'.repeat(250) + '.com']) {
      expect(await codeOf(() => buildNetworkInit({ ...base, domain }))).to.equal('bad-arg|officer verb refused (bad-arg domain)')
    }
    expect(await codeOf(() => buildNetworkInit({ ...base, electionType: 'weird' as 'adhoc' }))).to.equal('bad-arg|officer verb refused (bad-arg electionType)')
    expect(await codeOf(() => buildNetworkInit({ ...base, relays: [] }))).to.equal('bad-arg|officer verb refused (bad-arg relays)')
    expect(await codeOf(() => buildNetworkInit({ ...base, relays: ['nope'] }))).to.equal('bad-arg|officer verb refused (bad-arg relays)')
    expect(await codeOf(() => buildNetworkInit({ ...base, relays: ['/ip4/127.0.0.1/tcp/1/ws'] }))).to.equal('bad-arg|officer verb refused (bad-arg relays)')
    expect(await codeOf(() => buildNetworkInit({ ...base, authorityName: '' }))).to.equal('bad-arg|officer verb refused (bad-arg authorityName)')
    expect(await codeOf(() => buildNetworkInit({ ...base, adminName: '' }))).to.equal('bad-arg|officer verb refused (bad-arg adminName)')
    expect(await codeOf(() => buildNetworkInit({ ...base, adminTitle: '' }))).to.equal('bad-arg|officer verb refused (bad-arg adminTitle)')
    expect(await codeOf(() => buildAuthorityUser({ id: ID, name: 'x', publicKeyHex: '04' + 'ab'.repeat(32), nowMs: 1 }))).to.equal('bad-arg|officer verb refused (bad-arg publicKeyHex)')
    expect(await codeOf(() => buildAuthorityUser({ id: ID, name: 'x', publicKeyHex: KEY.toUpperCase(), nowMs: 1 }))).to.equal('bad-arg|officer verb refused (bad-arg publicKeyHex)')
    expect(await codeOf(() => buildAuthorityUser({ id: 'user-1', name: 'x', publicKeyHex: KEY, nowMs: 1 }))).to.equal('bad-arg|officer verb refused (bad-arg id)')
    expect(await codeOf(() => buildAuthorityUser({ id: ID, name: '', publicKeyHex: KEY, nowMs: 1 }))).to.equal('bad-arg|officer verb refused (bad-arg name)')
  })

  it('the user key is type mobile with a ten-year expiry', () => {
    expect(AUTHORITY_KEY_LIFETIME_MS).to.equal(10 * 365 * 24 * 60 * 60 * 1000)
    const built = buildAuthorityUser({ id: ID, name: 'Officer', publicKeyHex: KEY, nowMs: 1_700_000_000_000 })
    expect(built.activeKeys[0]!.type).to.equal(UserKeyType.mobile)
    expect(built.activeKeys[0]!.type).to.equal('M')
    expect(built.activeKeys[0]!.expiration - 1_700_000_000_000).to.equal(AUTHORITY_KEY_LIFETIME_MS)
  })
})
