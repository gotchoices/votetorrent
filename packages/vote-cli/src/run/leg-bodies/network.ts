// The network leg: found the test network, mint the two keyholder codes, join both keyholders on the
// shared workflows, verify every served verb, then restart every authority group and reopen it. The
// reopen is kept so the profile's reopenMs window compares on every run and persistence is exercised.

import { BUILTIN_VERBS_VERB } from '../../ctl/protocol.js'
import { HANDOFF_KEYS } from '../results.js'
import { CLI01_VERB_INVENTORY, SUPPORT_VERBS } from '../verb-inventory.js'
import { type ElectionLegBody, type RunContext } from '../election-legs.js'
import { bool, callVerb, callVerbs, needOk, nowMs, number, sleep, stringOf } from './common.js'

const AUTHORITIES = ['officer', 'kh-a', 'kh-b'] as const
const HASH_RE = /^[0-9a-f]{32}$/
const CONTROL_CONVERGENCE_MS = 120000

async function waitForControlConnections (ctx: RunContext): Promise<boolean> {
  const deadline = nowMs(ctx) + CONTROL_CONVERGENCE_MS
  for (;;) {
    const reads = await Promise.all(AUTHORITIES.map((label) => callVerb(ctx, label, label === 'officer' ? 'officer.readback' : 'keyholder.readback', {})))
    if (reads.every((r) => r.ok && number(r.result.controlConnections) >= 2)) return true
    if (nowMs(ctx) >= deadline) return false
    await sleep(ctx, 1000)
  }
}

function expectedVerbs (role: string): string[] {
  return [
    ...CLI01_VERB_INVENTORY.filter((v) => v.role === role).map((v) => v.verb),
    ...SUPPORT_VERBS.filter((v) => v.role === role && v.verb !== BUILTIN_VERBS_VERB).map((v) => v.verb)
  ]
}

export const networkBody: ElectionLegBody = async (L, ctx) => {
  const t0 = nowMs(ctx)
  await ctx.startPeers(AUTHORITIES)

  for (const label of AUTHORITIES) {
    const reply = await callVerbs(ctx, label)
    needOk(L, 'network', `V-${label}`, `${label} serves the built-in listing`, reply)
    const served = reply.ok && Array.isArray(reply.result.verbs) ? reply.result.verbs.map(String) : []
    const missing = [...new Set(expectedVerbs(label === 'officer' ? 'officer' : 'keyholder'))].filter((v) => !served.includes(v))
    L.need('verb-missing', `VM-${label}`, `${label} serves every verb of its role`, missing.length === 0, { count: missing.length })
  }

  const name = `vt-${ctx.opts.party}`
  const found = await callVerb(ctx, 'officer', 'officer.found', { name, tokenFile: ctx.tokenFile('officer') })
  needOk(L, 'found', 'N1', 'the officer founded the network', found)
  const networkHash = found.ok ? stringOf(found.result.networkHash) : ''
  L.need('found', 'N2', 'found returned a 32-hex network hash', HASH_RE.test(networkHash))
  ctx.shared.networkHash = networkHash
  ctx.shared.networkName = name
  ctx.out.key(HANDOFF_KEYS.network, `networkHash=${networkHash}`)

  const setup = await callVerb(ctx, 'officer', 'officer.owner-setup', {})
  needOk(L, 'owner-setup', 'N3', 'owner setup completed', setup)
  L.need('owner-setup', 'N4', 'the officer holds the invite capability after setup', setup.ok && stringOf(setup.result.capabilityAfter) === 'ready')
  const cap = await callVerb(ctx, 'officer', 'officer.capability', {})
  needOk(L, 'capability', 'N5', 'the officer capability was read', cap)
  const authority = await callVerb(ctx, 'officer', 'officer.authority-id', { networkHash })
  needOk(L, 'authority-id', 'N6', 'the primary authority id was read', authority)
  L.need('authority-id', 'N7', 'exactly one primary authority was found', authority.ok && number(authority.result.count) === 1)
  ctx.shared.authorityId = authority.ok ? stringOf(authority.result.authorityId8) : ''

  const dashboardPath = ctx.secretPath('dashboard-code.txt')
  const dash = await callVerb(ctx, 'officer', 'officer.dashboard-code', { networkHash, codeFile: dashboardPath })
  needOk(L, 'dashboard-code', 'N8', 'a dashboard pairing code was minted', dash)
  ctx.registerSecretFile(dashboardPath, { windows: true })

  for (const label of ['kh-a', 'kh-b']) {
    const codeFile = ctx.secretPath(`code-${label}.txt`)
    const fingerprintFile = ctx.secretPath(`fp-${label}.txt`)
    const mint = await callVerb(ctx, 'officer', 'officer.mint', { networkHash, codeFile, fingerprintFile })
    needOk(L, 'mint', `M-${label}`, `${label} join code and fingerprint were minted`, mint)
    ctx.registerSecretFile(codeFile, { windows: true })
    ctx.registerSecretFile(fingerprintFile, { windows: true })
    ctx.shared.codeFiles[label] = codeFile
    ctx.shared.fingerprintFiles[label] = fingerprintFile
  }

  for (const label of ['kh-a', 'kh-b']) {
    const join = await callVerb(ctx, label, 'keyholder.join', {
      networkHash,
      codeFile: ctx.shared.codeFiles[label]!,
      expectFingerprintFile: ctx.shared.fingerprintFiles[label]!,
      expectName: name,
      timeoutMs: 420000
    }, { timeoutMs: 900000 })
    needOk(L, 'join-outcome', `J-${label}`, `${label} joined the network`, join)
    L.need('join-outcome', `J2-${label}`, `${label} reported outcome joined`, join.ok && stringOf(join.result.outcome) === 'joined')
  }

  const readAll = async (): Promise<Record<string, unknown>> => {
    const reads = await Promise.all(AUTHORITIES.map((label) => callVerb(ctx, label, label === 'officer' ? 'officer.readback' : 'keyholder.readback', {})))
    for (let i = 0; i < reads.length; i++) needOk(L, 'reopen-peers', `R-${AUTHORITIES[i]}`, `${AUTHORITIES[i]} answered readback`, reads[i]!)
    L.need('reopen-peers', 'R1', 'every authority has a relay circuit and a recent network',
      reads.every((r) => r.ok && bool(r.result.circuitReady) && number(r.result.recentCount) >= 1))
    return reads[0]!.ok ? reads[0]!.result : {}
  }
  const before = await readAll()
  ctx.shared.peerId8 = stringOf(before.peerId8)

  const reopenStart = nowMs(ctx)
  await L.step('reopen', async () => {
    const seen = new Set<string>()
    const colocated = ctx.opts.colocate ?? []
    for (const label of AUTHORITIES) {
      const group = colocated.includes(label) ? colocated.join(',') : label
      if (seen.has(group)) continue
      seen.add(group)
      await ctx.restart(label)
    }
    const after = await readAll()
    L.need('reopen-peers', 'R2', 'the peer id survived every restart', stringOf(after.peerId8) === ctx.shared.peerId8)
    if (typeof after.controlConnections === 'number') {
      L.need('reopen-peers', 'R2c', 'every authority re-established two control connections after the restart', await waitForControlConnections(ctx))
    }
    const again = await callVerb(ctx, 'officer', 'officer.authority-id', { networkHash })
    needOk(L, 'reopen-open', 'R3', 'the reopened officer reads its authority again', again)
    L.need('reopen-open', 'R4', 'one authority is visible after the reopen', again.ok && number(again.result.count) === 1)
  })
  const reopenEnd = nowMs(ctx)
  L.duration('reopenMs', reopenEnd - reopenStart)
  L.window('reopen', reopenStart, reopenEnd)

  if (ctx.instruments !== null) {
    const pre = await ctx.instruments.forkPrecheck('reopen', L.dir, AUTHORITIES)
    L.need(`fork-precheck-${pre.token || 'unreadable'}`, 'O5', 'fork precheck after the reopen', pre.pass)
  }
}
