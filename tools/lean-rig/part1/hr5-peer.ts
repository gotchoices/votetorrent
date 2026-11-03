// hr5-peer.ts - one part-1 peer process (plan 64-62, D-62-02, interfaces B and D). One OS process per role, so the Authority
// modules that read the global AsyncStorage see one role each. Control is HTTP on 127.0.0.1 with a 0600 token; verbs are modules
// from $S62/verbs/ only. Never prints a code, an invitation or a key.
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { buildRoleNode, roleNetworksEngine } from './hr5-open.ts'
import { installRedialResolveProbe } from './redial-gate.mjs'
import { readParty, loadUser, roleDir, type Role } from './hr5-lib.ts'

const T0 = performance.now()
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = new URL('../../../', import.meta.url)
const AUTH = (p: string): string => new URL('apps/VoteTorrentAuthority/src/' + p, REPO).href
const VOTER = (p: string): string => new URL('apps/VoteTorrentVoter/src/' + p, REPO).href

const role = process.env.HR5_ROLE as Role
const STATE = process.env.HR5_STATE as string
const RUN = process.env.HR5_RUN as string
const TOKEN_FILE = process.env.HR5_TOKEN_FILE as string
const RELAY_ENV = process.env.HR5_RELAY_ENV as string
const MAX_RUNTIME_MS = Number(process.env.HR5_MAX_RUNTIME_MS ?? 14_400_000)
if (!['officer', 'kh-a', 'kh-b'].includes(role) || !STATE || !RUN || !TOKEN_FILE || !RELAY_ENV) { console.log('HR5-PEER-BOOT-FAILED role=? token=usage'); process.exit(2) }
mkdirSync(RUN, { recursive: true, mode: 0o700 })
const bootN = readdirSync(RUN).filter((f) => /^boot-\d+\.json$/.test(f)).length + 1
const bootId = `${role}-${bootN}-${process.pid}`
const relayAddr = (readFileSync(RELAY_ENV, 'utf8').split('\n').find((l) => l.startsWith('RELAY_MULTIADDR=')) ?? '').slice('RELAY_MULTIADDR='.length)
const relayPeer = relayAddr.split('/p2p/').pop() as string
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

// ------------------------------------------------------------------ instruments (D): installed BEFORE the node starts
const cadre: any = await import('@serfab/cadre-core')
const { ClusterClient }: any = await import('@optimystic/db-p2p')
const CAP_BYTES = 1_048_576
const probe = { installed: false, calls: 0, maxBytes: 0, oversized: 0 }
{
  const origSend = ClusterClient.prototype.send
  const enc = new TextEncoder()
  ClusterClient.prototype.send = async function (this: unknown, message: unknown, options: unknown) {
    try {
      const bytes = enc.encode(JSON.stringify(message)).byteLength
      probe.calls++
      if (bytes > probe.maxBytes) probe.maxBytes = bytes
      if (bytes > CAP_BYTES) probe.oversized++
    } catch { /* a probe failure never changes product behaviour */ }
    return origSend.call(this, message, options)
  }
  probe.installed = true
}

const SM_RE = /Failed to get super-majority: ([0-9]+\/[0-9]+) approvals/
interface Sig { superMajority: number, tornAction: number, invalidDataLength: number, transferLimit: number }
const zero = (): Sig => ({ superMajority: 0, tornAction: 0, invalidDataLength: 0, transferLimit: 0 })
const wallPaths: Record<'hidden' | 'thrown' | 'late', Sig> = { hidden: zero(), thrown: zero(), late: zero() }
let hiddenOpenFailures = 0
function classify (err: unknown): Sig & { names: string[] } {
  const out: any = { ...zero(), names: [] }
  const queue: Array<{ e: any, d: number }> = [{ e: err, d: 0 }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const { e, d } = queue.shift()!
    if (e === null || e === undefined || d > 6) continue
    if (typeof e === 'object') { if (seen.has(e)) continue; seen.add(e) }
    const name = typeof e?.name === 'string' ? e.name : ''
    const msg = typeof e?.message === 'string' ? e.message : (typeof e === 'string' ? e : '')
    if (name && !out.names.includes(name) && out.names.length < 12) out.names.push(name)
    if (SM_RE.test(msg)) out.superMajority++
    if (name === 'Torn' + 'ActionError') out.tornAction++
    if (name === 'InvalidDataLengthError') out.invalidDataLength++
    if (name === 'TransferLimitError') out.transferLimit++
    if (e?.cause !== undefined) queue.push({ e: e.cause, d: d + 1 })
    if (Array.isArray(e?.errors)) for (const x of e.errors) queue.push({ e: x, d: d + 1 })
  }
  return out
}
function record (where: string, err: unknown, path: 'hidden' | 'thrown' | 'late'): void {
  const c = classify(err)
  const w = wallPaths[path]
  w.superMajority += c.superMajority; w.tornAction += c.tornAction; w.invalidDataLength += c.invalidDataLength; w.transferLimit += c.transferLimit
  if (c.superMajority + c.tornAction + c.invalidDataLength + c.transferLimit > 0) {
    console.log(`HR5-WALL where=${where} path=${path} sm=${c.superMajority} torn=${c.tornAction} invalidDataLength=${c.invalidDataLength} transferLimit=${c.transferLimit}`)
  }
}
process.on('uncaughtException', (e) => { record('uncaught', e, 'late'); console.log(`HR5-LATE name=${String((e as any)?.name ?? 'Error')}`) })
process.on('unhandledRejection', (e) => { record('unhandled', e, 'late'); console.log(`HR5-LATE name=${String((e as any)?.name ?? 'Error')}`) })

const attaches: any[] = []
{
  const origInfo = console.info.bind(console)
  const origWarn = console.warn.bind(console)
  console.info = (...a: any[]) => {
    if (a[0] === '[strand-factory] attach') attaches.push({ t: Date.now(), kind: 'attach', ...(a[1] ?? {}) })
    origInfo(...a)
  }
  console.warn = (...a: any[]) => {
    // E30 (a): stamp cadre-core's own [sereus] warnings with the epoch ms so d14 can place them inside or outside H5's isolation window
    if (typeof a[0] === 'string' && a[0].startsWith('[sereus]')) { origWarn(`HR5-T${Date.now()} ` + a[0], ...a.slice(1)); return }
    if (a[0] === '[strand-factory] attach refused') attaches.push({ t: Date.now(), kind: 'refused', ...(a[1] ?? {}) })
    origWarn(...a)
  }
}

const soloCommits: Array<{ at: number, updatedAt: unknown }> = []
const dialOutcomes: Array<{ at: number, peer: string, outcome: string }> = []
const redialRing: any[] = []

function instrumentNode (node: any): void {
  const dial = node.dialControlSibling.bind(node)
  node.dialControlSibling = async (sibling: any, resolved: any) => {
    const outcome = await dial(sibling, resolved)
    dialOutcomes.push({ at: Date.now(), peer: String(sibling.peerId), outcome: String(outcome) })
    return outcome
  }
  installRedialResolveProbe(node, redialRing)
}
function instrumentControlDb (node: any): void {
  const db = node.getControlDatabase()
  if (!db) return
  const update = db.updateSelfPeerRecord.bind(db)
  db.updateSelfPeerRecord = async (...args: any[]) => {
    const reachable = node.hasReachableControlSibling()
    const rec = await update(...args)
    if (rec !== null && !reachable) soloCommits.push({ at: Date.now(), updatedAt: rec.updatedAt })
    return rec
  }
}

// ------------------------------------------------------------------ the role's User (created once, saved before first use)
const fixtures: any = await import(new URL('packages/vote-engine/test/fixtures/test-context.ts', REPO).href)
let user = loadUser(STATE, role)
if (!user) {
  user = role === 'officer' ? fixtures.makeTestUser() : fixtures.makeDistinctTestUser()
  const privateHex = fixtures.testKeyPairFor(user.id).privateHex
  mkdirSync(roleDir(STATE, role), { recursive: true, mode: 0o700 })
  writeFileSync(join(roleDir(STATE, role), 'user.json'), JSON.stringify({ user, privateHex }), { mode: 0o600 })
}

// ------------------------------------------------------------------ boot (CadreNodeProvider's sequence)
const authRecovery: any = await import(AUTH('engines/control-schema-recovery.ts'))
const voterRecovery: any = await import(VOTER('engines/control-schema-recovery.ts'))
const ownerTrust: any = await import(AUTH('engines/owner-trust.ts'))
let rendezvousMod: any = null
try { rendezvousMod = await import(AUTH('engines/pool-rendezvous-host.ts')) } catch { rendezvousMod = null }

const bootRecord: any = { boot: bootN, role, pid: process.pid, startedAt: new Date().toISOString(), firstStart: { ok: true }, recreated: false, recreatedScope: null }
let current = await buildRoleNode(STATE, role, relayAddr)
let node: any = current.node

function refusalOf (e: unknown): { name: string, reason: string } | null {
  for (let x: any = e, d = 0; x != null && d < 6; x = x.cause, d++) {
    if (x.name === 'ControlStoreIncompatibleError') return { name: 'ControlStoreIncompatibleError', reason: String(x.reason ?? '') }
  }
  return null
}
function chainNames (e: unknown): string[] {
  const out: string[] = []
  for (let x: any = e, d = 0; x != null && d < 6; x = x.cause, d++) out.push(String(x.name ?? typeof x))
  return out
}

try {
  instrumentNode(node)
  try {
    await node.start()
  } catch (startError) {
    const refusal = refusalOf(startError)
    const predicateA = authRecovery.isUnrestorableControlSchemaError(startError)
    const predicateV = voterRecovery.isUnrestorableControlSchemaError(startError)
    bootRecord.firstStart = { ok: false, refusal, predicateA, predicateV, chain: chainNames(startError) }
    if (!predicateA) throw startError
    const scope = cadre.controlStorageScope(readParty(STATE).partyId)
    await node.stop().catch(() => undefined)
    await current.destroyScope(scope)
    bootRecord.recreated = true
    bootRecord.recreatedScope = scope
    current = await buildRoleNode(STATE, role, relayAddr)
    node = current.node
    instrumentNode(node)
    await node.start()
  }
  instrumentControlDb(node)
  bootRecord.reanchor = await ownerTrust.reanchorOwnKey(node)
  bootRecord.classification = await ownerTrust.readOwnerTrustClassification(node, 'persistent')
  bootRecord.rendezvous = 'skipped'
  if (rendezvousMod) {
    try { await rendezvousMod.hostPoolRendezvous(node); bootRecord.rendezvous = 'hosted' } catch (e) { bootRecord.rendezvous = `failed:${String((e as any)?.name ?? 'Error')}` }
  }
} catch (e) {
  record('boot', e, 'thrown')
  bootRecord.failed = { names: chainNames(e) }
  writeFileSync(join(RUN, `boot-${bootN}.json`), JSON.stringify(bootRecord), { mode: 0o600 })
  console.log(`HR5-PEER-BOOT-FAILED role=${role} token=start-error`)
  try { await node.stop() } catch { /* best effort */ }
  process.exit(1)
}

bootRecord.readyMs = Math.round(process.uptime() * 1000)
bootRecord.peerId = current.peerId
writeFileSync(join(RUN, `boot-${bootN}.json`), JSON.stringify(bootRecord), { mode: 0o600 })

// ------------------------------------------------------------------ the verb context and the ctl server
let engineCache: any = null
const wrapDbFactory = (factory: any) => async (hash: string) => {
  try { return await factory(hash) } catch (e) { hiddenOpenFailures++; record('open', e, 'hidden'); throw e }
}
const ctx: any = {
  role, state: STATE, run: RUN, node, peerId: current.peerId, user, relayAddr, relayPeer, bootId, bootN, bootRecord,
  isolated: current.isolated, dialRefused: current.dialRefused,
  attaches, soloCommits, dialOutcomes, redialRing, probe, wallPaths, record,
  get hiddenOpenFailures () { return hiddenOpenFailures },
  engine () { return (engineCache ??= roleNetworksEngine(node, STATE, role, { wrapDbFactory })) },
  wrapDbFactory,
  auth: (p: string) => import(AUTH(p)),
  fixtures,
  repo: REPO,
  exit: async () => {
    try { await Promise.race([node.stop(), new Promise((r) => setTimeout(r, 10_000))]) } catch { /* best effort */ }
    try { await Promise.race([current.closeStores(), new Promise((r) => setTimeout(r, 5_000))]) } catch { /* best effort */ }
    setTimeout(() => process.exit(0), 50)
  }
}

const VERBS_DIR = realpathSync(join(HERE, 'verbs'))
const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.headers['x-hr5-token'] !== token) return send(401, { ok: false, error: { name: 'Unauthorized' } })
  let text = ''
  req.on('data', (d) => { text += d })
  req.on('end', async () => {
    let body: any
    try { body = JSON.parse(text) } catch { return send(400, { ok: false, error: { name: 'BadRequest' } }) }
    const verb = String(body.verb ?? '')
    if (!/^[a-z0-9-]+$/.test(verb)) return send(404, { ok: false, error: { name: 'NoSuchVerb' } })
    let file = join(VERBS_DIR, `${verb}.ts`)
    if (typeof body.module === 'string') {
      let real = ''
      try { real = realpathSync(body.module) } catch { return send(403, { ok: false, error: { name: 'Forbidden' } }) }
      if (!real.startsWith(VERBS_DIR + '/')) return send(403, { ok: false, error: { name: 'Forbidden' } })
      file = real
    }
    if (!existsSync(file)) return send(404, { ok: false, error: { name: 'NoSuchVerb' } })
    try {
      const mod: any = await import(pathToFileURL(file).href)
      const result = await mod.default(ctx, body.args ?? {})
      send(200, { ok: true, ...(result ?? {}) })
    } catch (e) {
      record(`verb.${verb}`, e, 'thrown')
      const err: any = e
      send(500, { ok: false, error: { name: String(err?.name ?? 'Error'), message: String(err?.message ?? err).slice(0, 200), chain: chainNames(e) } })
    }
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as any).port
writeFileSync(join(RUN, 'pid'), String(process.pid) + '\n', { mode: 0o600 })
console.log(`HR5-PEER-READY role=${role} boot=${bootN} readyMs=${bootRecord.readyMs} recreated=${bootRecord.recreated}`)
writeFileSync(join(RUN, 'ctl.port'), String(port) + '\n', { mode: 0o600 })
setTimeout(() => { console.log('HR5-PEER-MAXRUNTIME'); void ctx.exit() }, MAX_RUNTIME_MS).unref()
void T0
