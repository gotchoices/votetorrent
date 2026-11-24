// host-kh.ts (tools/lean-rig, 2026-11-23): ONE host keyholder for an election whose officer is a DEVICE (an emulator or phone
// Authority founded the network and created the election). The lean driver's host keyholders depend on its in-process host officer;
// this runs the same shipped-module calls lean-part2.ts makes for kh-a (legReopen, legAccept, legDkg, legRelease) with no officer:
//   reopen the part-1 kh-a peer (already joined through hr5-peer's `join` verb with the device's join code)
//   -> wait for <SEC>/seat-share.txt (the device officer's keyholder invitation text) -> acceptKeyholderInvitation
//   -> driveKeyholderDkg until this keyholder reads phase complete -> wait for releasingKeys -> releaseKeyholderShare
//   -> stay up as a host replica until <SEC>/flag-stop or HK_MAX_RUNTIME_MS.
// The key vault is the rig's InMemoryTestKeyVault (as in lean-part2): the DKG share lives in this process, so do not restart it
// between accept and release. Prints `HK <iso> <stage> ...` lines; never prints the share text, a code or a key.
// Env: HR5_STATE_DIR (state dir with party.json + <role>/), HR5_SEC, HK_RELAY_ENV, HK_NETWORK_HASH, HK_ROLE (kh-a), HK_SEAT_FILE
// (seat-share.txt, under HR5_SEC), HK_MAX_RUNTIME_MS (default 4 h).
import { readFileSync, existsSync } from 'node:fs'
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const S = fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '')
const SCR = join(S, '..')
const REPO = join(SCR, '../..')
const S62 = join(SCR, 'part1')
const U = (p: string): string => pathToFileURL(p).href
const R = (rel: string): string => U(join(REPO, rel))
const STATE = process.env.HR5_STATE_DIR ?? ''
const SEC = process.env.HR5_SEC ?? ''
const RELAY_ENV = process.env.HK_RELAY_ENV ?? ''
const NET = process.env.HK_NETWORK_HASH ?? ''
const MAX_RUNTIME_MS = Number(process.env.HK_MAX_RUNTIME_MS ?? 4 * 3600_000)
const ROLE = process.env.HK_ROLE ?? 'kh-a' // kh-a for a device-officer run; kh-b in the host proof (LEAN_PHONE_KH=1 driver keeps kh-a in-process)
const T0 = Date.now()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const PEER_RE = /12D3Koo[1-9A-HJ-NP-Za-km-z]{30,}/g
const hk = (stage: string, msg = ''): void => { console.log(`HK ${new Date().toISOString()} +${Math.round((Date.now() - T0) / 1000)}s ${stage} ${msg}`.replace(PEER_RE, (m) => `<peer:${m.slice(-8)}>`)) }
const errText = (e: unknown): string => `${(e as any)?.name ?? 'Error'}${(e as any)?.code ? `[${(e as any).code}]` : ''}: ${String((e as any)?.message ?? e).slice(0, 200)}`
if (!STATE || !SEC || !RELAY_ENV || !NET) { hk('USAGE', 'need HR5_STATE_DIR, HR5_SEC, HK_RELAY_ENV, HK_NETWORK_HASH'); process.exit(2) }
const relayAddr = (readFileSync(RELAY_ENV, 'utf8').split('\n').find((l) => l.startsWith('RELAY_MULTIADDR=')) ?? '').slice('RELAY_MULTIADDR='.length)
// the redaction in hk() only hides peer ids; keep stray library logs from echoing the share text
const rawLog = console.log.bind(console)
for (const lvl of ['info', 'warn', 'error', 'debug'] as const) { const orig = (console as any)[lvl].bind(console); (console as any)[lvl] = (...a: any[]) => orig(...a.map((x) => typeof x === 'string' ? x.replace(PEER_RE, (m: string) => `<peer:${m.slice(-8)}>`) : x)) }
void rawLog

// module loading (mirrors lean-part2.ts "module loading")
await import(U(join(S, 'mocha-shim.js')))
const opener: any = await import(U(join(S62, 'hr5-open.ts')))
register('./s63-hooks.mjs', { parentURL: import.meta.url, data: { authSrc: R('apps/VoteTorrentAuthority/src/') } })
const AUTH = (p: string): string => R('apps/VoteTorrentAuthority/src/' + p)
const VEs = (p: string): string => R('packages/vote-engine/src/' + p)
const [invitationMod, dkgEngMod, keyReleaseMod, keysTasksMod, releaseWindowMod, vaultMod, initMod] = await Promise.all([
  import(VEs('invite/invitation-engine.ts')), import(VEs('keyholder/keyholder-dkg-engine.ts')), import(VEs('key-release/key-release-engine.ts')),
  import(VEs('tasks/keys-tasks-engine.ts')), import(VEs('key-release/release-window.ts')), import(VEs('crypto/vault.ts')), import(VEs('database/initialize.ts'))
]) as any[]
const { InvitationEngine } = invitationMod
const { KeyholderDkgEngine } = dkgEngMod
const { KeyReleaseEngine } = keyReleaseMod
const { KeysTasksEngine } = keysTasksMod
const { releasingKeysAt } = releaseWindowMod
const { InMemoryTestKeyVault } = vaultMod
const { registerDbPlugins, declareViewsInMain } = initMod
const { acceptKeyholderInvitation } = (await import(AUTH('screens/keyholder/keyholder-accept.ts'))) as any
const { driveKeyholderDkg } = (await import(AUTH('screens/keyholder/keyholder-dkg-driver.ts'))) as any
const { releaseKeyholderShare } = (await import(AUTH('screens/keyholder/key-release-ceremony.ts'))) as any
const ownerTrustMod: any = await import(AUTH('engines/owner-trust.ts'))
const poolHostMod: any = await import(AUTH('engines/pool-rendezvous-host.ts'))

function mapKeyVaultStorage (): any {
  const m = new Map<string, string>()
  return { async getItem (k: string) { return m.has(k) ? m.get(k)! : null }, async setItem (k: string, v: string) { m.set(k, v) }, async removeItem (k: string) { m.delete(k) } }
}
const stopRequested = (): boolean => existsSync(join(SEC, 'flag-stop')) || Date.now() - T0 > MAX_RUNTIME_MS

// ---- reopen (mirrors legReopen for one role) --------------------------------------------------------------------------
const user = JSON.parse(readFileSync(join(STATE, ROLE, 'user.json'), 'utf8'))
const built = await opener.buildRoleNode(STATE, ROLE, relayAddr)
await built.node.start()
try { await Promise.race([ownerTrustMod.reanchorOwnKey(built.node), sleep(30_000)]) } catch (e) { hk('REANCHOR-ERR', errText(e)) }
hk('STARTED', `peer=${built.peerId}`)
for (let i = 0; i < 60; i++) {
  let addrs: string[] = []
  try { addrs = built.node.getControlNode().getMultiaddrs().map((m: any) => m.toString()) } catch { /* not yet */ }
  if (addrs.some((a) => a.includes('/p2p-circuit'))) { hk('CIRCUIT', 'ok'); break }
  await sleep(1000)
}
for (let i = 0; i < 120 && !built.node.hasReachableControlSibling(); i++) await sleep(1000)
hk('SIBLING', String(built.node.hasReachableControlSibling()))
let opened: any
for (let attempt = 1; ; attempt++) {
  try { opened = await opener.openRoleNetwork(built.node, STATE, ROLE, NET); break } catch (e) { hk('OPEN-ERR', `attempt=${attempt} ${errText(e)}`); if (attempt >= 5) throw e; await sleep(10_000) }
}
const est = opened.networksEngine.getEstablishedContext(NET)
for (const fn of [registerDbPlugins, declareViewsInMain]) { try { await fn(est.db) } catch (e) { hk('OPEN-NOTE', `${fn.name} ${errText(e).slice(0, 80)}`) } }
const ctx = { ...est, db: est.db, user: est.user ?? user.user }
const one = async (sql: string, params: Record<string, unknown> = {}): Promise<any> => ctx.db.prepare(sql).get(params)
hk('OPENED', `network=${NET.slice(0, 8)} networkId=${String((await one('select Id from Network').catch(() => null))?.Id ?? '?').slice(0, 8)}`)
// a host peer that is a network member can also serve the pool rendezvous (harmless if the officer device does too)
try { await poolHostMod.hostPoolRendezvous(built.node); hk('RENDEZVOUS', 'hosted') } catch (e) { hk('RENDEZVOUS-ERR', errText(e)) }

// periodic status: what this replica sees (elections, keyholders, voters, blocks)
const statusLine = async (): Promise<string> => {
  const q = async (sql: string): Promise<string> => { try { return String((await one(sql))?.n ?? '?') } catch { return 'E' } }
  return `elections=${await q('select count(*) as n from Election')} keyholders=${await q('select count(*) as n from Keyholder')} registrations=${await q('select count(*) as n from Registration')} associations=${await q('select count(*) as n from Association')} voteBlocks=${await q('select count(*) as n from VoteBlock')}`
}
const statusTimer = setInterval(() => { void statusLine().then((s) => hk('STATUS', s)).catch(() => undefined) }, 60_000)

// ---- accept (mirrors legAccept for one host keyholder) -----------------------------------------------------------------
const vault = new InMemoryTestKeyVault()
const store = mapKeyVaultStorage()
const dkg = new KeyholderDkgEngine(ctx, { vault })
const invitations = new InvitationEngine(ctx)
const cache = new Map<string, any>()
const getEngine = async (n: string): Promise<any> => {
  if (n === 'keyholderDkg') return dkg
  if (n === 'invitations') return invitations
  if (n === 'keysTasksEngine') {
    if (!cache.has(n)) {
      const ref = (await opened.networksEngine.getRecentNetworks()).find((x: any) => x.hash === NET)
      cache.set(n, new KeysTasksEngine(ref, ctx, { vault, now: () => Date.now() } as any))
    }
    return cache.get(n)
  }
  throw new Error(`getEngine: unknown engine ${n}`)
}
const seatFile = join(SEC, process.env.HK_SEAT_FILE ?? 'seat-share.txt')
hk('WAIT-SEAT', `role=${ROLE} waiting for secrets/${process.env.HK_SEAT_FILE ?? 'seat-share.txt'}`)
while (!existsSync(seatFile)) { if (stopRequested()) process.exit(0); await sleep(2000) }
const shareText = readFileSync(seatFile, 'utf8').trim()
let userId = ''
let electionId = ''
for (let attempt = 1; !userId; attempt++) {
  try {
    const res = await acceptKeyholderInvitation({
      invitationEngine: invitations, vault, storage: store,
      readKeyholderSeatFacts: async (eid: string) => { try { const s = await dkg.getDkgStatus(eid); return { revision: s.revision, liveRoster: s.liveRoster, earlierRevisionUserIds: s.earlierRevisionUserIds } } catch { return undefined } }
    }, shareText)
    userId = res.userId
    electionId = String((await invitations.getKeyholderSlotSeat(res.slotCid))?.electionId ?? '')
  } catch (e) {
    // a seat invitation can arrive before its slot replicates here: retry not-found for a while, stop on anything else after 3
    hk('ACCEPT-ERR', `attempt=${attempt} ${errText(e)}`)
    if (attempt >= 40) process.exit(1)
    await sleep(15_000)
  }
}
hk('ACCEPTED', `userId=${userId.slice(0, 8)} election=${electionId.slice(0, 8)} prompts=${vault.authPromptCount}`)

// ---- DKG (mirrors legDkg's host drive loop; the device keyholder drives its half on screen focus) -----------------------
const kr = new KeyReleaseEngine(ctx)
let lastPhase = ''
for (let drives = 1; !stopRequested(); drives++) {
  let out: any
  try { out = await driveKeyholderDkg({ getEngine, vault, storage: store }, electionId, userId) } catch (e) { hk('DKG-THREW', errText(e)); await sleep(5000); continue }
  const phase = String(out.status?.phase ?? 'null')
  if (phase !== lastPhase || out.actions.length > 0 || out.error) hk('DKG', `drive=${drives} phase=${phase} attempt=${out.status?.currentAttempt ?? '?'} advanced=${out.advanced} actions=${out.actions.length}${out.error ? ` error=${out.error.code}` : ''}`)
  lastPhase = phase
  if (phase === 'complete') {
    const ks: any = await kr.getKeyReleaseStatus(electionId).catch(() => null)
    if (ks?.electionKey != null) { hk('DKG-COMPLETE', `threshold=${ks.electionKey.threshold} participants=${ks.electionKey.participants} hasShare=${out.status?.self?.hasShare === true}`); break }
  }
  await sleep(out.actions.length > 0 ? 1500 : 4000)
}

// ---- release (mirrors legRelease for one host keyholder) ---------------------------------------------------------------
let releaseAt: number | null = null
while (releaseAt === null && !stopRequested()) {
  try { const tl = (await one('select Timeline as tl from ElectionRevision where ElectionId = :e order by Revision desc', { e: electionId }))?.tl; releaseAt = releasingKeysAt(JSON.parse(String(tl))) } catch (e) { hk('TIMELINE-ERR', errText(e)) }
  if (releaseAt === null) await sleep(10_000)
}
hk('WAIT-RELEASE', `releasingKeys=${new Date(releaseAt ?? 0).toISOString()}`)
while (releaseAt !== null && Date.now() < releaseAt && !stopRequested()) await sleep(5000)
for (let attempt = 1; !stopRequested(); attempt++) {
  try {
    const eng = await getEngine('keysTasksEngine')
    const tasks = await eng.getKeysToRelease(true)
    const task = tasks.find((t: any) => t.userId === userId) ?? null
    if (task === null) { if (attempt % 6 === 1) hk('RELEASE-WAIT-TASK', `attempt=${attempt} tasks=${tasks.length}`); await sleep(10_000); continue }
    const o = await releaseKeyholderShare({ getEngine, vault, storage: store }, task)
    hk('RELEASE', `attempt=${attempt} outcome=${o.kind}${o.kind === 'failed' ? ` code=${o.code}` : ''}`)
    if (o.kind === 'released') break
  } catch (e) { hk('RELEASE-THREW', `attempt=${attempt} ${errText(e)}`) }
  await sleep(10_000)
}
for (let i = 0; i < 60 && !stopRequested(); i++) {
  const s: any = await kr.getKeyReleaseStatus(electionId).catch(() => null)
  if ((s?.releasedCount ?? 0) >= 2) { hk('RELEASED-ALL', `releasedCount=${s.releasedCount} rejected=${s.rejectedReleases?.length ?? 0} phase=${s.phase}`); break }
  await sleep(5000)
}

// ---- stay up as a host replica ------------------------------------------------------------------------------------------
hk('HOLD', 'serving as a host replica until secrets/flag-stop')
while (!stopRequested()) await sleep(5000)
clearInterval(statusTimer)
try { await built.node.stop() } catch (e) { hk('STOP-ERR', errText(e)) }
try { await built.closeStores() } catch { /* best effort */ }
hk('STOPPED')
process.exit(0)
