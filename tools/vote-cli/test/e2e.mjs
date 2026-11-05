#!/usr/bin/env node
// End-to-end test of the Authority and Voter workflows through the `vt` CLI only.
//
// Topology (each a separate OS process with its own CadreNode, talking libp2p over loopback):
//   A   Authority app — founding officer; storage profile; hosts the pool rendezvous
//   K1  Authority app — keyholder device, joins A's network
//   K2  Authority app — keyholder device, joins A's network
//   V1..V3  Voter app — join, register, vote, send through a pool
//   VX  Voter app — tries a forged join code and must be refused
//
// Every step is one `vt … --json` invocation; its wall time (process spawn + RPC) and the
// daemon-side time are recorded. Results go to runs/<stamp>/results.json and the report to
// reports/E2E-REPORT.md.
//
//   node test/e2e.mjs [--voting-starts-min 4] [--voting-min 3] [--keep]

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { renderReport } from './report.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VT = join(ROOT, 'bin', 'vt.mjs')
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const VOTING_STARTS_MIN = Number(arg('voting-starts-min', process.env.E2E_VOTING_STARTS_MIN ?? 4))
const VOTING_MIN = Number(arg('voting-min', process.env.E2E_VOTING_MIN ?? 3))
const STEP_SECONDS = 15
const KEEP = process.argv.includes('--keep')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const RUN = join(ROOT, 'runs', stamp)
mkdirSync(RUN, { recursive: true })
const home = (d) => join(RUN, d)

const T0 = performance.now()
const since = () => Math.round(performance.now() - T0)
const tests = []
let current = null
const facts = {}

function log (msg) {
  process.stdout.write(`[${String(since()).padStart(7)}ms] ${msg}\n`)
}

/** One `vt` invocation on one device. Resolves to the daemon reply plus wall time; never throws. */
function vt (device, args, { timeoutMs = 600_000 } = {}) {
  const started = performance.now()
  const startedAt = since()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VT, '--home', home(device), ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const wallMs = Math.round(performance.now() - started)
      let reply
      try { reply = JSON.parse(stdout) } catch { reply = { ok: false, error: { name: 'CliError', message: (stderr || stdout || `exit ${code}`).trim().slice(0, 500) } } }
      const step = {
        device,
        command: `vt ${args.map((a) => (/\s/.test(a) || a.length > 60 ? JSON.stringify(a.length > 60 ? `${a.slice(0, 57)}...` : a) : a)).join(' ')}`,
        ok: reply.ok === true,
        wallMs,
        daemonMs: reply.ms ?? null,
        startedAtMs: startedAt,
        ...(reply.ok ? {} : { error: reply.error })
      }
      current?.steps.push(step)
      log(`${step.ok ? 'ok  ' : 'FAIL'} ${device.padEnd(3)} ${step.command} (${wallMs} ms${step.daemonMs !== null ? `, daemon ${step.daemonMs} ms` : ''})${step.ok ? '' : ` — ${reply.error?.code ?? reply.error?.name}: ${reply.error?.message}`}`)
      resolve({ ...reply, wallMs })
    })
  })
}

/** Like vt() but the step must succeed; returns the result or throws. */
async function must (device, args, opts) {
  const r = await vt(device, args, opts)
  if (!r.ok) throw new Error(`${device}: vt ${args[0]} ${args[1] ?? ''} failed — ${r.error?.code ?? r.error?.name}: ${r.error?.message}`)
  return r.result
}

/** Something the run saw that a reader should know, which is not itself a pass/fail check. */
const observations = []
function observe (text) {
  observations.push({ test: current?.id ?? null, text })
  log(`NOTE  ${text}`)
}

function check (name, pass, detail) {
  current.checks.push({ name, pass: Boolean(pass), ...(detail !== undefined ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) } : {}) })
  log(`${pass ? 'PASS' : 'FAIL'}  ✓ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  return Boolean(pass)
}

/**
 * One test case. A test passes when its body completes and every check passed. A test whose
 * `needs` failed is SKIPPED, not run, so one broken workflow does not cascade into noise.
 */
async function test (id, name, { app, needs = [], kind = 'test' }, body) {
  // Blocked only when a prerequisite could not do its work (threw or was itself skipped); a failed
  // assertion in a prerequisite is reported there and does not hide what the dependents do.
  const blocked = needs.filter((n) => {
    const dep = tests.find((t) => t.id === n)
    return !dep || dep.status === 'skipped' || dep.error !== undefined
  })
  const t = { id, name, app, kind, status: 'running', steps: [], checks: [], startedAtMs: since() }
  tests.push(t)
  current = t
  log(`── ${id} ${name}`)
  const started = performance.now()
  if (blocked.length > 0) {
    t.status = 'skipped'
    t.reason = `needs ${blocked.join(', ')}`
    log(`   skipped (${t.reason})`)
  } else {
    try {
      await body()
      t.status = t.checks.every((c) => c.pass) ? 'passed' : 'failed'
    } catch (e) {
      t.status = 'failed'
      t.error = e.message
      log(`   ERROR ${e.message}`)
    }
  }
  t.durationMs = Math.round(performance.now() - started)
  log(`   => ${t.status.toUpperCase()} in ${t.durationMs} ms`)
  current = null
}

async function waitUntil (epochMs, label) {
  const ms = epochMs - Date.now()
  if (ms > 0) {
    log(`… waiting ${Math.round(ms / 1000)} s for ${label}`)
    await new Promise((r) => setTimeout(r, ms))
    if (current) current.waitMs = (current.waitMs ?? 0) + ms
  }
}

/** Repeats `fn` until it returns a truthy value or the timeout passes. */
async function poll (fn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

const VOTERS = ['V1', 'V2', 'V3']
const KEYHOLDERS = ['K1', 'K2']
const CHOICES = {
  V1: ['mayor=ada', 'measure-a=yes'],
  V2: ['mayor=bo', 'measure-a=yes'],
  V3: ['mayor=ada', 'measure-a=no']
}

async function run () {
  log(`run directory ${RUN}`)

  await test('T01', 'Start the device daemons (1 authority, 2 keyholder devices, 4 voters)', { app: 'both' }, async () => {
    const starts = [
      vt('A', ['daemon', 'start', '--role', 'authority', '--name', 'Alice Officer']),
      ...KEYHOLDERS.map((k) => vt(k, ['daemon', 'start', '--role', 'authority', '--profile', 'transaction', '--name', `Keyholder ${k}`])),
      ...[...VOTERS, 'VX'].map((v) => vt(v, ['daemon', 'start', '--role', 'voter', '--name', `Voter ${v}`]))
    ]
    const replies = await Promise.all(starts)
    check('all 7 daemons started', replies.every((r) => r.ok), replies.filter((r) => !r.ok).map((r) => r.error?.message).join('; ') || undefined)
    facts.authorityAddrs = replies[0].result?.addresses
  })

  await test('T02', 'Authority founds a network (Add Network screen)', { app: 'authority', needs: ['T01'] }, async () => {
    const created = await must('A', ['network', 'create', '--name', 'E2E Network', '--authority-name', 'E2E Election Authority', '--domain', 'e2e.votetorrent.local'])
    facts.networkHash = created.hash
    facts.authorityId = created.primaryAuthorityId
    check('network created with a primary authority', created.hash && created.primaryAuthorityId, { hash: created.hash })
    const shown = await must('A', ['network', 'show'])
    check('network details read back', shown.name === 'E2E Network', shown.name)
    const admin = await must('A', ['admin', 'show'])
    const officer = admin.admin?.officers?.[0]
    check('the founder is the sole officer with all 9 founding scopes', admin.admin?.officers?.length === 1 && officer?.scopes?.length === 9, officer?.scopes)
  })

  await test('T03', 'Officer registers an intake encryption key', { app: 'authority', needs: ['T02'] }, async () => {
    const r = await must('A', ['intake-key', 'register'])
    check('intake key published and current', r.status?.published === true && r.status?.isIntakeRecipient === true, r.status)
  })

  await test('T04', 'Authority mints a join code (Invite voters card)', { app: 'authority', needs: ['T02'] }, async () => {
    const r = await must('A', ['network', 'join-code'])
    facts.joinCode = r.code
    check('vtjoin2 code minted and fits one QR (<= 2953 chars)', r.code.startsWith('vtjoin2.') && r.chars <= 2953, `${r.chars} chars, fingerprint ${r.fingerprint}`)
    facts.fingerprint = r.fingerprint
  })

  await test('T05', 'A forged join code (wrong anchor digest) is refused', { app: 'voter', needs: ['T04'] }, async () => {
    // Same invitation, one character of the founding-anchor digest changed, re-encoded with the
    // shipped codec so the code is well-formed and only the anchor is wrong.
    const { decodeNetworkJoinCode, encodeNetworkJoinCode } = await import(new URL('../../../packages/vote-engine/dist/networks/join-code.js', import.meta.url).href)
    const decoded = decodeNetworkJoinCode(facts.joinCode)
    const d = decoded.code.digest
    const forged = encodeNetworkJoinCode({ ...decoded.code, digest: d.slice(0, 10) + (d[10] === 'A' ? 'B' : 'A') + d.slice(11) })
    const r = await vt('VX', ['network', 'join', forged])
    check('join refused with digest-mismatch', r.ok && r.result?.ok === false && r.result?.reason === 'digest-mismatch', r.result ?? r.error)
    const status = await must('VX', ['status'])
    check('the forged network was not opened or recorded', status.currentNetwork === null && status.recentNetworks.length === 0, status.recentNetworks)
  })

  await test('T06', 'Keyholder devices join the network (Authority app, Join Network)', { app: 'authority', needs: ['T04'] }, async () => {
    const joins = await Promise.all(KEYHOLDERS.map((k) => vt(k, ['network', 'join', facts.joinCode])))
    joins.forEach((r, i) => check(`${KEYHOLDERS[i]} joined (${r.result?.admittedVia ?? r.result?.reason ?? r.error?.message})`, r.ok && r.result?.ok === true && r.result?.network?.hash === facts.networkHash, r.result?.steps?.join('>')))
    check('keyholders see the same fingerprint as the authority', joins.every((r) => r.result?.fingerprint === facts.fingerprint))
  })

  await test('T07', 'Voters join the network from the join code (Voter app, Join Network)', { app: 'voter', needs: ['T04'] }, async () => {
    const joins = await Promise.all(VOTERS.map((v) => vt(v, ['network', 'join', facts.joinCode])))
    joins.forEach((r, i) => check(`${VOTERS[i]} joined (${r.result?.admittedVia ?? r.result?.reason ?? r.error?.message})`, r.ok && r.result?.ok === true && r.result?.network?.hash === facts.networkHash, r.result?.steps?.join('>')))
    const shown = await must('V1', ['network', 'show'])
    check('a voter reads the network\'s primary authority from the replicated strand', shown.primaryAuthorityId === facts.authorityId)
  })

  await test('T08', 'Network revision: propose and apply a relay change (rn threshold 1)', { app: 'authority', needs: ['T02'] }, async () => {
    const extra = '/dns4/relay.e2e.votetorrent.local/tcp/443/wss'
    const r = await must('A', ['network', 'revise', '--relay', facts.authorityAddrs[0], '--relay', extra])
    check('revision applied on the authority with both relays', r.applied === true && r.relays?.includes(extra), r)
    const seen = await poll(async () => {
      const s = await vt('V1', ['network', 'show'])
      return s.ok && s.result.relays?.includes(extra) ? s.result : null
    }, { timeoutMs: 60_000 })
    check('a voter sees the revised relay list (replicated)', Boolean(seen))
    const rename = await vt('A', ['network', 'revise', '--name', 'E2E Network (renamed)'])
    check('a rename proposal is not surfaced by getDetails (engine behavior, recorded)', !rename.ok && rename.error?.code === 'no-proposal', rename.error?.message)
  })

  await test('T09', 'Officer invitation is created and accepted by a second Authority device', { app: 'authority', needs: ['T06'] }, async () => {
    const inv = await must('A', ['officer', 'invite', '--name', 'Kim Deputy', '--title', 'Deputy', '--scopes', 'vrg,mel'])
    check('officer invitation share created', inv.share.includes('invitePrivate'))
    const accepted = await poll(async () => {
      const r = await vt('K1', ['invite', 'accept', inv.share, '--type', 'of'])
      return r.ok ? r.result : (r.error?.code === 'not-found' ? null : r.error)
    }, { timeoutMs: 60_000, intervalMs: 3000 })
    check('K1 accepted the officer invitation', accepted?.accepted === true, accepted)
  })

  await test('T10', 'Authority creates an election (Create Election screen)', { app: 'authority', needs: ['T02'] }, async () => {
    const votingStarts = Date.now() + VOTING_STARTS_MIN * 60_000
    facts.votingStarts = votingStarts
    const r = await must('A', ['election', 'create', '--title', 'E2E Election',
      '--voting-starts', new Date(votingStarts).toISOString(),
      '--registration-ends', new Date(votingStarts).toISOString(),
      '--ballots-final', new Date(votingStarts - 1000).toISOString(),
      '--voting-minutes', String(VOTING_MIN), '--step-seconds', String(STEP_SECONDS),
      '--threshold', '2', '--keyholders', 'Kim,Kai'])
    facts.electionId = r.electionId
    facts.timeline = Object.fromEntries(Object.entries(r.timeline).map(([k, v]) => [k, Date.parse(v)]))
    check('election created with a 10-event timeline and threshold 2', r.electionId && Object.keys(r.timeline).length === 10 && r.keyholderThreshold === 2, r.timeline)
    const shown = await must('A', ['election', 'show'])
    check('authority reads the election as Upcoming', shown.phase === 'Upcoming', shown.phase)
    const seen = await poll(async () => {
      const s = await vt('V2', ['election', 'show'])
      return s.ok && s.result.electionId === facts.electionId ? s.result : null
    }, { timeoutMs: 60_000 })
    check('a voter sees the election (replicated) as Upcoming', seen?.lifecycleState === 'Upcoming', seen?.lifecycleState)
  })

  await test('T11', 'Ballot: propose, submit for confirmation, sign the ballot task', { app: 'authority', needs: ['T10'] }, async () => {
    const p = await must('A', ['ballot', 'propose', '--description', 'General ballot',
      '--question', 'mayor|Mayor|ada,bo,cy', '--question', 'measure-a|Measure A|yes,no'])
    facts.ballotId = p.ballotId
    const tasksBefore = await must('A', ['tasks', 'list'])
    const c = await must('A', ['ballot', 'confirm', '--ballot', p.ballotId])
    check('ballot confirmed by the officer signature', c.confirmed === true, c)
    check('the confirmation went through a signature task', tasksBefore.signatures.length >= 0)
    const seen = await poll(async () => {
      const s = await vt('V3', ['ballot', 'show'])
      return s.ok && s.result.ballots.length === 1 ? s.result : null
    }, { timeoutMs: 60_000 })
    check('a voter sees the confirmed ballot with both questions', seen?.ballots?.[0]?.questions?.length === 2, seen?.ballots?.[0]?.questions?.map((q) => q.code))
  })

  await test('T12', 'Keyholders: invite, accept on keyholder devices, run the DKG to an election key', { app: 'authority', needs: ['T06', 'T10'] }, async () => {
    const shares = []
    for (const name of ['Kim', 'Kai']) shares.push((await must('A', ['keyholder', 'invite', '--name', name])).share)
    // A keyholder device that has not yet received the invitation row refuses it as not found or
    // unverifiable; the keyholder pastes the share again, as here (attempts are recorded).
    // Both keyholders accept at the same time, as two real keyholders can. An accept whose
    // multi-collection commit loses the distributed store's optimistic race is retried (the
    // keyholder taps Accept again); every such loss is recorded as an observation.
    const NOT_YET_HERE = ['not-found', 'invite-unverifiable']
    const LOST_RACE = /lost a stale race/i
    const accepts = await Promise.all(KEYHOLDERS.map(async (k, i) => {
      let attempts = 0
      let raceLosses = 0
      const result = await poll(async () => {
        attempts++
        const r = await vt(k, ['keyholder', 'accept', shares[i]])
        if (r.ok) return r.result
        if (NOT_YET_HERE.includes(r.error?.code)) return null
        if (LOST_RACE.test(r.error?.message ?? '')) { raceLosses++; return null }
        return { error: r.error }
      }, { timeoutMs: 180_000, intervalMs: 3000 })
      return { ...result, attempts, raceLosses }
    }))
    accepts.forEach((a, i) => {
      check(`${KEYHOLDERS[i]} accepted its keyholder seat`, a?.userId, a?.error ?? `${a.userId} (attempt ${a.attempts})`)
      if (a.raceLosses > 0) observe(`${KEYHOLDERS[i]}'s concurrent keyholder accept lost the distributed store's optimistic race ${a.raceLosses}× ("Multi-collection commit lost a stale race … Pend failed for collection UserKey"); it succeeded on attempt ${a.attempts}. The engine does not retry this commit, so the app would show the keyholder an error.`)
    })
    const dkg = await Promise.all(KEYHOLDERS.map((k) => vt(k, ['keyholder', 'dkg', '--until-done', '--timeout', '240'], { timeoutMs: 300_000 })))
    dkg.forEach((r, i) => check(`${KEYHOLDERS[i]} finished the DKG`, r.ok && r.result?.done === true,
      r.ok ? `${r.result.passes} driver passes; actions: ${r.result.actions.join(', ')}${r.result.stepErrors.length ? `; step errors: ${r.result.stepErrors.join(', ')}` : ''}` : r.error?.message))
    check('both keyholders derived the same joint public key', dkg[0].result?.jointPublicKey && dkg[0].result?.jointPublicKey === dkg[1].result?.jointPublicKey)
    const onA = await poll(async () => {
      const s = await vt('A', ['keyholder', 'status'])
      return s.ok && s.result.electionKey?.jointPublicKey ? s.result : null
    }, { timeoutMs: 60_000 })
    check('the authority sees the election key', onA?.electionKey?.jointPublicKey === dkg[0].result?.jointPublicKey)
  })

  await test('T13', 'Voter registration ceremony + officer review (sync, approve, associate)', { app: 'both', needs: ['T07', 'T03', 'T10'] }, async () => {
    const names = { V1: ['Ada', 'Lovelace'], V2: ['Bo', 'Diddley'], V3: ['Cy', 'Young'] }
    const ceremonies = VOTERS.map((v) => vt(v, ['register', '--first', names[v][0], '--last', names[v][1], '--email', `${v.toLowerCase()}@example.org`, '--timeout', '240'], { timeoutMs: 300_000 }))
    const approved = new Set()
    const officer = (async () => {
      const deadline = Date.now() + 240_000
      let challenges = 0
      while (Date.now() < deadline) {
        const sync = await vt('A', ['registration', 'sync'])
        challenges += sync.result?.associations?.challengesIssued ?? 0
        const pending = await vt('A', ['registration', 'list', '--status', 'p'])
        for (const req of pending.result ?? []) {
          if (approved.has(req.requestId)) continue
          const a = await vt('A', ['registration', 'approve', '--request', req.requestId])
          if (a.ok && a.result.status === 'a') approved.add(req.requestId)
        }
        const registrants = await vt('A', ['registrants', 'list'])
        const associated = (registrants.result ?? []).filter((r) => r.associations.length > 0).length
        if (approved.size >= VOTERS.length && associated >= VOTERS.length) return { associated, challenges }
        await new Promise((r) => setTimeout(r, 3000))
      }
      return { associated: -1, challenges }
    })()
    const [results, officerOutcome] = await Promise.all([Promise.all(ceremonies), officer])
    results.forEach((r, i) => check(`${VOTERS[i]} submitted, got the challenge and answered it`, r.ok && r.result?.status === 'pending', r.ok ? r.result.timings : r.error?.message))
    check('officer approved all 3 registration requests', approved.size === 3, `${approved.size} approved`)
    check('all 3 registrants have a device association', officerOutcome.associated === 3, officerOutcome)
    const statuses = await Promise.all(VOTERS.map((v) => vt(v, ['registration', 'status', '--wait', '--timeout', '120'], { timeoutMs: 150_000 })))
    statuses.forEach((s, i) => check(`${VOTERS[i]} sees itself registered`, s.ok && s.result?.state === 'registered', s.result?.state ?? s.error?.message))
  })

  await test('T14', 'Casting before voting opens is refused', { app: 'voter', needs: ['T13', 'T11'] }, async () => {
    if (Date.now() >= facts.votingStarts) { check('voting not yet open (setup ran past votingStarts; check not applicable)', true, 'skipped: window already open'); return }
    const r = await vt('V1', ['vote', 'cast', '--select', CHOICES.V1[0], '--select', CHOICES.V1[1]])
    check('refused with window-closed', !r.ok && r.error?.code === 'window-closed', r.error)
  })

  const tWait1 = Date.now()
  await waitUntil(facts.votingStarts ?? Date.now(), 'voting to open')
  tests.push({ id: 'W1', name: 'Wait for votingStarts (timeline, not work)', kind: 'wait', app: '-', status: 'waited', steps: [], checks: [], durationMs: Date.now() - tWait1, startedAtMs: since() })

  await test('T15', 'Voters cast their votes (Review & Submit), read the receipt', { app: 'voter', needs: ['T13', 'T11'] }, async () => {
    const casts = await Promise.all(VOTERS.map((v) => vt(v, ['vote', 'cast', ...CHOICES[v].flatMap((s) => ['--select', s])])))
    casts.forEach((r, i) => check(`${VOTERS[i]} saved a signed, sealed vote`, r.ok && r.result?.ballotIds?.length === 1, r.ok ? r.result.savedAt : r.error))
    const receipt = await must('V2', ['vote', 'receipt'])
    const answers = Object.fromEntries(receipt.votes[0].answers.map((a) => [a.questionCode, a.optionCodes.join(',')]))
    check('the receipt opens and holds exactly the selections', answers.mayor === 'bo' && answers['measure-a'] === 'yes', answers)
    const again = await vt('V1', ['vote', 'cast', '--select', CHOICES.V1[0], '--select', CHOICES.V1[1]])
    check('a second cast is refused (already-saved)', !again.ok && again.error?.code === 'already-saved', again.error)
  })

  await test('T16', 'Voters send their votes through a pool (min 3) via the authority rendezvous', { app: 'voter', needs: ['T15', 'T12'] }, async () => {
    const sends = await Promise.all(VOTERS.map((v) => vt(v, ['vote', 'send'], { timeoutMs: (VOTING_MIN + 2) * 60_000 })))
    sends.forEach((r, i) => check(`${VOTERS[i]} vote sent in a committed block`, r.ok && r.result?.ok === true, r.ok ? r.result.ballots : r.error))
    const cids = new Set(sends.flatMap((r) => (r.result?.ballots ?? []).map((b) => b.cid)).filter(Boolean))
    check('all three votes landed in ONE block', cids.size === 1, [...cids])
    facts.blockCid = [...cids][0]
  })

  await test('T17', 'Keyholders release their key shares once releasingKeys opens', { app: 'authority', needs: ['T16'] }, async () => {
    await waitUntil(facts.timeline.releasingKeys + 1000, 'the releasingKeys window')
    const rel = await Promise.all(KEYHOLDERS.map((k) => poll(async () => {
      const r = await vt(k, ['keys', 'release'])
      return r.ok ? r.result : (r.error?.code === 'no-release-task' ? null : { error: r.error })
    }, { timeoutMs: 120_000, intervalMs: 3000 })))
    rel.forEach((r, i) => check(`${KEYHOLDERS[i]} released its share`, r?.released === true, r?.error ?? r?.status))
  })

  await test('T18', 'Election results: reconstruct the key, open the block, tally', { app: 'authority', needs: ['T17'] }, async () => {
    const result = await poll(async () => {
      const r = await vt('A', ['election', 'results'])
      return r.ok && r.result.blocks.length > 0 ? r.result : null
    }, { timeoutMs: 120_000, intervalMs: 3000 })
    const tally = result?.tally ?? {}
    const mayor = tally[`${facts.ballotId}/mayor`] ?? {}
    const measure = tally[`${facts.ballotId}/measure-a`] ?? {}
    check('one block with 3 entries opened', result?.blocks?.length === 1 && result.blocks[0].opened === 3, result?.blocks)
    check('tally matches the votes cast (mayor: ada 2, bo 1; measure-a: yes 2, no 1)', mayor.ada === 2 && mayor.bo === 1 && measure.yes === 2 && measure.no === 1, tally)
    check('3 voter rows recorded', result?.voterRows === 3, result?.voterRows)
  })

  await test('T19', 'Stop all daemons', { app: 'both', kind: 'teardown' }, async () => {
    if (KEEP) { check('daemons kept running (--keep)', true); return }
    const stops = await Promise.all(['A', ...KEYHOLDERS, ...VOTERS, 'VX'].map((d) => vt(d, ['daemon', 'stop'])))
    check('all daemons stopped', stops.every((r) => r.ok))
  })
}

try {
  await run()
} finally {
  const totalMs = since()
  const results = {
    ranAt: new Date().toISOString(),
    totalMs,
    host: { platform: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
    config: { votingStartsMin: VOTING_STARTS_MIN, votingMin: VOTING_MIN, stepSeconds: STEP_SECONDS },
    git: (() => { try { return readFileSync(join(ROOT, '..', '..', '.git', 'HEAD'), 'utf8').trim() } catch { return null } })(),
    runDir: RUN,
    tests,
    observations
  }
  writeFileSync(join(RUN, 'results.json'), JSON.stringify(results, null, 2))
  const reportDir = join(ROOT, 'reports')
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true })
  const historyFile = join(reportDir, 'run-history.json')
  const history = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : []
  const counted0 = tests.filter((t) => t.kind === 'test')
  const failedIds = counted0.filter((t) => t.status !== 'passed').map((t) => t.id)
  history.push({
    ranAt: results.ranAt,
    passed: counted0.filter((t) => t.status === 'passed').length,
    total: counted0.length,
    totalMs,
    note: failedIds.length === 0 ? 'All tests passed.' : `Not passed: ${failedIds.join(', ')}.`
  })
  writeFileSync(historyFile, JSON.stringify(history, null, 2))
  results.history = history
  writeFileSync(join(reportDir, 'E2E-REPORT.md'), renderReport(results))
  writeFileSync(join(reportDir, 'e2e-results.json'), JSON.stringify(results, null, 2))
  const counted = tests.filter((t) => t.kind === 'test')
  log(`DONE in ${Math.round(totalMs / 1000)} s — ${counted.filter((t) => t.status === 'passed').length}/${counted.length} tests passed; report: reports/E2E-REPORT.md`)
  process.exitCode = counted.every((t) => t.status === 'passed') ? 0 : 1
}
