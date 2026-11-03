#!/usr/bin/env node
// Spike 106 classifier - D-14 as amended 2026-10-13 (a hidden failure is a hit). Plain Node ESM, no dependencies.
// (Files under .planning that end in .js are ESM; this one is .mjs so it is explicit.)
//
// Run rules (notes section 7, conservative):
//   CLEAN               L1/L2: join ok, hiddenOpenFailures 0, oversized 0, no wall signal in any cause chain (depth 6).
//   MASKED HIT          L1/L2: join ok, but a failed open was healed by joinNetwork's retry (hiddenOpenFailures > 0),
//                       or an oversized cluster send was seen, or a hidden wall signal exists.
//   HIT                 flow not ok, join/join1 missing, timed out, a thrown or late wall signal, or a leg that
//                       started and never reported.
//   CONTROL WALL SHOWN  L3 only: oversized >= 1 AND (hidden open >= 1 OR join not ok) AND super-majority >= 1.
//   CONTROL NO WALL     L3 otherwise (the detector must see the signal; never tuned to force one).
//   VOID-run (why)      the run says nothing: host-not-quiet, instrument-never-started, instrument-detached,
//                       precondition-not-met, setup-error, wrong-stack, dry-config. A VOID never hides an oversized
//                       send or a wall signal: with wall evidence the run is still classified as a hit.
// Batch (verdict): run 1 must be L3 with CONTROL WALL SHOWN, else the batch is VOID. Executed order must equal the
// planned order. Any HIT or MASKED HIT -> VERDICT-HIT. Else any VOID or missing run -> INCOMPLETE. Else 10 CLEAN ->
// VERDICT-CLEAN. Smoke batches print `BATCH SMOKE l3=<class> l1=<class>` and never the word for a verdict.
// InvalidDataLengthError is counted by name in the leg and never text-matched here (member-side debug text only).
// This L3 is unrelated to tools/multipeer-gate's L3.
//
// CLI: --selftest | --run <log> [--json] | --batch <dir> [--json] | --order --seed <N>
// CLASSIFY_MUTATE (ignore-hidden|ignore-oversized|ignore-l3-control|void-hides-wall|no-ansi-strip) is honoured ONLY
// with --selftest; any other mode refuses (exit 2), so a verdict classification can never run mutated.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PINS = { dbP2p: '1.13.0', dbCore: '1.13.0', pluginOptimystic: '1.13.0', cadreCore: '1.15.0', quereus: '4.20.2', p2pFret: '1.0.2' }
const MAIN_EVENT_MIN = [1, 0, 5]
const MUTATIONS = ['ignore-hidden', 'ignore-oversized', 'ignore-l3-control', 'void-hides-wall', 'no-ansi-strip']

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const semverGte = (v, min) => {
  const p = String(v).split('.').map((x) => parseInt(x, 10))
  for (let i = 0; i < 3; i++) { const a = p[i] || 0; if (a !== min[i]) return a > min[i] }
  return true
}

function parseLog (text, mut) {
  const clean = mut.has('no-ansi-strip') ? text : stripAnsi(text)
  let start = null
  const results = []
  for (const line of clean.split('\n')) {
    let m = /^LEG-START (\{.*\})$/.exec(line)
    if (m && start === null) { try { start = JSON.parse(m[1]) } catch { /* ignore */ } continue }
    m = /^RESULT (\{.*\})$/.exec(line)
    if (m) { try { results.push(JSON.parse(m[1])) } catch { /* ignore */ } }
  }
  return { start, results }
}

const sumSig = (r, key, mut) => {
  const w = r.wallSignals ?? {}
  let n = 0
  for (const part of ['hidden', 'thrown', 'late']) {
    if (part === 'hidden' && mut.has('ignore-hidden')) continue
    n += (w[part]?.[key] ?? 0)
  }
  return n
}
const wallIn = (r, part) => { const s = r.wallSignals?.[part]; return !!s && (s.superMajority > 0 || s.tornAction > 0 || s.invalidDataLength > 0) }

/** Classify one run's log text. `rec` is the optional batch.json run record. */
export function classifyRun (text, rec = {}, mut = new Set()) {
  const { start, results } = parseLog(text, mut)
  const notes = []
  if (results.length === 0) {
    if (rec.quiet === 'not-quiet') return { cls: 'VOID-run (host-not-quiet)', why: 'host not quiet', notes }
    if (start) return { cls: 'HIT', why: 'leg started and never reported a RESULT (killed or crashed mid-flow)', notes }
    return { cls: 'VOID-run (instrument-never-started)', why: 'no LEG-START and no RESULT', notes }
  }
  if (results.length > 1) notes.push('multiple RESULT lines')
  const r = results[0]
  const voidRun = (why, detail) => ({ cls: `VOID-run (${why})`, why: detail, notes })
  if (r.dryConfig) return voidRun('dry-config', 'dry config run')

  const oversized = mut.has('ignore-oversized') ? 0 : (r.oversizedTotal ?? 0)
  const hiddenCount = mut.has('ignore-hidden') ? 0 : (r.hiddenOpenFailuresTotal ?? 0)
  const hiddenWall = !mut.has('ignore-hidden') && wallIn(r, 'hidden')
  const thrownWall = wallIn(r, 'thrown')
  const lateWall = wallIn(r, 'late')
  const wallEvidence = oversized > 0 || hiddenWall || thrownWall || lateWall
  const superMajority = sumSig(r, 'superMajority', mut)

  const voidAllowed = mut.has('void-hides-wall') || !wallEvidence
  if (voidAllowed) {
    const st = r.stack ?? {}
    const wrong = Object.keys(PINS).filter((k) => st[k] !== PINS[k])
    if (!semverGte(st.mainEvent ?? '0', MAIN_EVENT_MIN)) wrong.push('mainEvent')
    if (wrong.length) return voidRun('wrong-stack', `stack differs: ${wrong.join(',')}`)
    if (r.setupError && (r.stage === 'boot' || r.stage === 'genesis')) return voidRun('setup-error', `setup error at stage ${r.stage}`)
    if (r.instrument?.probeInstalled === false || (r.instrument?.probeCalls ?? 0) === 0) return voidRun('instrument-detached', 'size probe saw no cluster send')
    const pre = r.preconditions ?? {}
    const bad = r.shape === 'l1' ? (pre.vAuthorizedBeforeFound !== true || (pre.aConnectionsAtFound ?? 0) < 1) : pre.memberBeforeStrand !== true
    if (bad) return voidRun('precondition-not-met', `precondition not met for ${r.shape}`)
  }

  if (r.shape === 'l3') {
    const joinOk = r.join?.ok === true
    const shown = oversized >= 1 && (hiddenCount >= 1 || !joinOk) && superMajority >= 1
    if (mut.has('ignore-l3-control') || shown) {
      return { cls: 'CONTROL WALL SHOWN', why: `oversized ${oversized}, hidden ${hiddenCount}, super-majority ${superMajority}`, notes }
    }
    return { cls: 'CONTROL NO WALL', why: `oversized ${oversized}, hidden ${hiddenCount}, super-majority ${superMajority}, join ok ${joinOk}`, notes }
  }

  if (r.stall && r.stall.over2000 > 0) notes.push(`stall over 2 s x${r.stall.over2000} (max ${r.stall.maxMs} ms)`)
  if (r.timedOut) notes.push(`timed out at stage ${r.stage}`)
  const o = r.otherSignals ?? {}
  const others = ['missingBlock', 'peersUnreachable', 'claimedElsewhere', 'cohortUnreachable', 'deadConnection'].filter((k) => (o[k] ?? 0) > 0)
  if (others.length) notes.push(`other signals: ${others.join(',')}`)

  const joinOk = r.join?.ok === true
  const join1Bad = r.shape === 'l1' && r.join1?.ok !== true
  if (!joinOk || join1Bad || r.timedOut || thrownWall || lateWall) {
    const why = r.timedOut ? `timed out at stage ${r.stage}`
      : r.join == null ? `no join outcome (stage ${r.stage})`
        : !joinOk ? `join not ok: ${r.join.reason}`
          : join1Bad ? 'first join (join1) not ok'
            : 'thrown or late wall signal'
    return { cls: 'HIT', why, notes }
  }
  if (hiddenCount > 0 || oversized > 0 || hiddenWall) {
    if (hiddenWall && oversized === 0) notes.push('super-majority without oversized (possible unanswered-cohort flake; still a hit under D-14 as amended)')
    return { cls: 'MASKED HIT', why: `join ok but hidden open ${hiddenCount}, oversized ${oversized}${hiddenWall ? ', hidden wall signal' : ''}`, notes }
  }
  return { cls: 'CLEAN', why: `join ok ${r.join.ms} ms, no failed open, no oversized send`, notes }
}

/** The verdict-batch run order: L3 first, then 10 runs alternating l1/l2 over 5 shuffled condition pairs. */
export function makeOrder (seed) {
  let a = seed >>> 0
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pairs = [
    { aProfile: 'transaction', cluster: '2' }, { aProfile: 'transaction', cluster: '2' }, { aProfile: 'transaction', cluster: '2' },
    { aProfile: 'storage', cluster: '2' }, { aProfile: 'transaction', cluster: 'default' }
  ]
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]] }
  const startShape = rnd() < 0.5 ? 'l1' : 'l2'
  const out = [{ n: 1, shape: 'l3', aProfile: 'transaction', cluster: '2' }]
  for (let j = 0; j < 10; j++) {
    const shape = (j % 2 === 0) ? startShape : (startShape === 'l1' ? 'l2' : 'l1')
    out.push({ n: j + 2, shape, ...pairs[Math.floor(j / 2)] })
  }
  return out
}

const pad2 = (n) => String(n).padStart(2, '0')

export function classifyBatch (dir, mut = new Set()) {
  const batch = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8'))
  const lines = []
  const classes = []
  for (const run of batch.runs ?? []) {
    const logPath = run.log ? join(dir, run.log) : null
    const text = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const c = classifyRun(text, run, mut)
    classes.push({ run, cls: c.cls })
    lines.push(`RUN ${pad2(run.n)} ${run.shape} ${run.aProfile} c${run.cluster} ${c.cls} ${c.why}${c.notes.length ? ' [' + c.notes.join('; ') + ']' : ''}`)
  }
  let batchLine
  if (batch.mode === 'smoke') {
    const l3 = classes.find((c) => c.run.shape === 'l3')?.cls ?? 'missing'
    const l1 = classes.find((c) => c.run.shape === 'l1')?.cls ?? 'missing'
    batchLine = `BATCH SMOKE l3=${l3} l1=${l1}`
  } else {
    const planned = (batch.order ?? []).map((o) => `${o.shape}:${o.aProfile}:${o.cluster}`)
    const executed = (batch.runs ?? []).map((o) => `${o.shape}:${o.aProfile}:${o.cluster}`)
    const first = classes[0]
    if (!first || first.run.shape !== 'l3' || first.cls !== 'CONTROL WALL SHOWN') {
      batchLine = `BATCH VOID (positive control: ${first ? first.cls : 'missing'})`
    } else if (planned.length !== executed.length || planned.some((p, i) => p !== executed[i])) {
      batchLine = 'BATCH VOID (order mismatch)'
    } else {
      const rest = classes.slice(1)
      const hits = rest.filter((c) => c.cls === 'HIT' || c.cls === 'MASKED HIT')
      const voids = rest.filter((c) => c.cls.startsWith('VOID-run'))
      const missing = Math.max(0, 10 - rest.length)
      if (hits.length) batchLine = `BATCH VERDICT-HIT ${hits.map((h) => pad2(h.run.n) + ' ' + h.cls).join(', ')}`
      else if (voids.length || missing) batchLine = `BATCH INCOMPLETE (${voids.length + missing} void)`
      else if (rest.length === 10 && rest.every((c) => c.cls === 'CLEAN')) batchLine = 'BATCH VERDICT-CLEAN 10/10 CLEAN'
      else batchLine = 'BATCH INCOMPLETE (unclassified)'
    }
  }
  return { lines, batchLine }
}

// ---------------------------------------------------------------------------------------------
// Selftest
// ---------------------------------------------------------------------------------------------
const GOOD_STACK = { dbP2p: '1.13.0', dbCore: '1.13.0', pluginOptimystic: '1.13.0', cadreCore: '1.15.0', quereus: '4.20.2', mainEvent: '1.0.5', p2pFret: '1.0.2' }
const sig = (o = {}) => ({ superMajority: 0, superMajorityRatios: [], tornAction: 0, tornReasons: [], invalidDataLength: 0, ...o })
const okJoin = (ms, hid = 0, big = 0) => ({ ok: true, reason: null, ms, hiddenOpenFailures: hid, oversizedRequests: big, steps: 'admitting>syncing>verifying>done' })
function mkResult (shape, over = {}) {
  const base = {
    schema: 'vt64-wall-leg/1', runId: 'selftest', shape, storage: shape === 'l3' ? 'shared' : 'perscope', aProfile: 'transaction', vProfile: 'transaction', cluster: '2',
    stack: GOOD_STACK, instrument: { thresholdBytes: 1048576, probeInstalled: true, probeCalls: 40, probeMeasureErrors: 0, probeRestored: true },
    stage: 'done', setupError: null, timedOut: false,
    preconditions: shape === 'l1' ? { memberBeforeStrand: null, vAuthorizedBeforeFound: true, aConnectionsAtFound: 1 } : { memberBeforeStrand: true, vAuthorizedBeforeFound: null, aConnectionsAtFound: 1 },
    join: okJoin(733), join1: shape === 'l1' ? okJoin(900) : null, foundingOversized: 0, oversizedTotal: 0, hiddenOpenFailuresTotal: 0, sentBigKiB: [],
    wallSignals: { hidden: sig(), thrown: sig(), late: sig() },
    otherSignals: { missingBlock: 0, peersUnreachable: 0, claimedElsewhere: 0, cohortUnreachable: 0, deadConnection: 0, lateErrorNames: [] },
    vOpenErrors: [], aOpenErrors: [], stall: { maxMs: 20, over500: 0, over2000: 0 }, totalMs: 9000
  }
  return { ...base, ...over }
}
const logOf = (r, { ansi = false, startOnly = false, twice = false } = {}) => {
  const start = `LEG-START ${JSON.stringify({ schema: 'vt64-wall-leg/1', runId: r.runId, shape: r.shape })}`
  if (startOnly) return start + '\n'
  let res = `RESULT ${JSON.stringify(r)}`
  if (ansi) res = `\x1b[32m${res}\x1b[39m`
  return `${start}\n${res}\n${twice ? res + '\n' : ''}`
}

function runSelftest () {
  const mut = new Set((process.env.CLASSIFY_MUTATE ?? '').split(',').filter(Boolean))
  const cases = []
  const tc = (name, fn) => cases.push({ name, fn })
  const cls = (text, rec) => classifyRun(text, rec, mut)
  const eq = (got, want) => { if (got !== want) throw new Error(`got ${got}, want ${want}`) }
  const wallHidden = { hidden: sig({ superMajority: 1, superMajorityRatios: ['1/2'] }), thrown: sig(), late: sig() }

  tc('clean l1', () => eq(cls(logOf(mkResult('l1'))).cls, 'CLEAN'))
  tc('clean l2', () => eq(cls(logOf(mkResult('l2'))).cls, 'CLEAN'))
  tc('masked hit l2 hidden+oversized', () => eq(cls(logOf(mkResult('l2', { join: okJoin(4019, 1, 4), oversizedTotal: 4, hiddenOpenFailuresTotal: 1, wallSignals: wallHidden }))).cls, 'MASKED HIT'))
  tc('masked hit l1 founding oversized only', () => eq(cls(logOf(mkResult('l1', { foundingOversized: 1, oversizedTotal: 1 }))).cls, 'MASKED HIT'))
  tc('masked hit l2 super-majority without oversized (+note)', () => {
    const c = cls(logOf(mkResult('l2', { join: okJoin(4000, 1, 0), hiddenOpenFailuresTotal: 1, wallSignals: wallHidden })))
    eq(c.cls, 'MASKED HIT')
    if (!c.notes.some((n) => n.startsWith('super-majority without oversized'))) throw new Error('note missing')
  })
  tc('hit l1 join not ok', () => eq(cls(logOf(mkResult('l1', { join: { ok: false, reason: 'open-failed', ms: 120000, hiddenOpenFailures: 3, oversizedRequests: 0, steps: '' } }))).cls, 'HIT'))
  tc('hit l1 join1 not ok', () => eq(cls(logOf(mkResult('l1', { join1: { ok: false, reason: 'no-peers', ms: 1, hiddenOpenFailures: 0, oversizedRequests: 0, steps: '' } }))).cls, 'HIT'))
  tc('hit l2 thrown torn', () => eq(cls(logOf(mkResult('l2', { wallSignals: { hidden: sig(), thrown: sig({ tornAction: 1 }), late: sig() } }))).cls, 'HIT'))
  tc('hit l2 late torn', () => eq(cls(logOf(mkResult('l2', { wallSignals: { hidden: sig(), thrown: sig(), late: sig({ tornAction: 1 }) } }))).cls, 'HIT'))
  tc('hit l2 timed out', () => eq(cls(logOf(mkResult('l2', { timedOut: true, stage: 'join-1', join: null }))).cls, 'HIT'))
  tc('hit leg-start without result', () => eq(cls(logOf(mkResult('l2'), { startOnly: true })).cls, 'HIT'))
  tc('void never started', () => eq(cls('noise\n').cls, 'VOID-run (instrument-never-started)'))
  tc('void host not quiet record', () => eq(cls('', { quiet: 'not-quiet' }).cls, 'VOID-run (host-not-quiet)'))
  tc('void detached', () => eq(cls(logOf(mkResult('l2', { instrument: { thresholdBytes: 1048576, probeInstalled: true, probeCalls: 0, probeMeasureErrors: 0, probeRestored: true } }))).cls, 'VOID-run (instrument-detached)'))
  tc('void precondition l2', () => eq(cls(logOf(mkResult('l2', { preconditions: { memberBeforeStrand: false, vAuthorizedBeforeFound: null, aConnectionsAtFound: 1 } }))).cls, 'VOID-run (precondition-not-met)'))
  tc('void precondition l1 no connection', () => eq(cls(logOf(mkResult('l1', { preconditions: { memberBeforeStrand: null, vAuthorizedBeforeFound: true, aConnectionsAtFound: 0 } }))).cls, 'VOID-run (precondition-not-met)'))
  tc('void wrong stack', () => eq(cls(logOf(mkResult('l2', { stack: { ...GOOD_STACK, dbP2p: '1.12.1' } }))).cls, 'VOID-run (wrong-stack)'))
  tc('void setup error at boot', () => eq(cls(logOf(mkResult('l2', { stage: 'boot', setupError: 'boom', join: null }))).cls, 'VOID-run (setup-error)'))
  tc('void dry config', () => eq(cls(logOf(mkResult('l2', { dryConfig: true }))).cls, 'VOID-run (dry-config)'))
  tc('void never hides a wall', () => eq(cls(logOf(mkResult('l2', { preconditions: { memberBeforeStrand: false, vAuthorizedBeforeFound: null, aConnectionsAtFound: 1 }, join: okJoin(4000, 1, 0), hiddenOpenFailuresTotal: 1, wallSignals: wallHidden }))).cls, 'MASKED HIT'))
  tc('l3 wall shown', () => eq(cls(logOf(mkResult('l3', { join: okJoin(4019, 1, 4), oversizedTotal: 4, hiddenOpenFailuresTotal: 1, wallSignals: wallHidden }))).cls, 'CONTROL WALL SHOWN'))
  tc('l3 clean = no wall', () => eq(cls(logOf(mkResult('l3'))).cls, 'CONTROL NO WALL'))
  tc('l3 oversized+hidden but no super-majority = no wall', () => eq(cls(logOf(mkResult('l3', { join: okJoin(4019, 1, 4), oversizedTotal: 4, hiddenOpenFailuresTotal: 1 }))).cls, 'CONTROL NO WALL'))
  tc('ansi-wrapped masked hit', () => eq(cls(logOf(mkResult('l2', { join: okJoin(4019, 1, 4), oversizedTotal: 4, hiddenOpenFailuresTotal: 1, wallSignals: wallHidden }), { ansi: true })).cls, 'MASKED HIT'))
  tc('multiple RESULT lines noted', () => {
    const c = cls(logOf(mkResult('l1'), { twice: true }))
    eq(c.cls, 'CLEAN')
    if (!c.notes.includes('multiple RESULT lines')) throw new Error('note missing')
  })

  // ---- batches
  const root = mkdtempSync(join(tmpdir(), 'vt64-classify-'))
  const buildBatch = (name, mode, results, orderOverride) => {
    const dir = join(root, name)
    mkdirSync(dir)
    const order = mode === 'smoke' ? [{ n: 1, shape: 'l3', aProfile: 'transaction', cluster: '2' }, { n: 2, shape: 'l1', aProfile: 'transaction', cluster: '2' }] : makeOrder(1)
    const runs = []
    results.forEach((res, i) => {
      const o = (orderOverride ?? order)[i] ?? order[i]
      const log = `${pad2(i + 1)}-${o.shape}.log`
      if (res !== null) writeFileSync(join(dir, log), res.text ?? logOf(res))
      runs.push({ n: i + 1, shape: o.shape, aProfile: o.aProfile, cluster: o.cluster, log, ...(res === null ? { quiet: 'not-quiet' } : {}) })
    })
    writeFileSync(join(dir, 'batch.json'), JSON.stringify({ schema: 'vt64-wall-batch/1', mode, order, runs }))
    return dir
  }
  const l3Wall = () => mkResult('l3', { join: okJoin(4019, 1, 4), oversizedTotal: 4, hiddenOpenFailuresTotal: 1, wallSignals: wallHidden })
  const cleanFor = (order) => order.slice(1).map((o) => mkResult(o.shape, { aProfile: o.aProfile, cluster: o.cluster }))
  const ord = makeOrder(1)
  const bl = (dir) => classifyBatch(dir, mut).batchLine
  try {
    tc('batch clean', () => { if (!bl(buildBatch('clean', 'verdict', [l3Wall(), ...cleanFor(ord)])).startsWith('BATCH VERDICT-CLEAN')) throw new Error('not clean') })
    tc('batch l3 no wall is void', () => { if (!bl(buildBatch('nowall', 'verdict', [mkResult('l3'), ...cleanFor(ord)])).startsWith('BATCH VOID (positive control')) throw new Error('not void') })
    tc('batch with a masked hit', () => {
      const rest = cleanFor(ord)
      rest[3] = mkResult(ord[4].shape, { join: okJoin(4000, 1, 0), hiddenOpenFailuresTotal: 1, wallSignals: wallHidden })
      if (!bl(buildBatch('hit', 'verdict', [l3Wall(), ...rest])).startsWith('BATCH VERDICT-HIT')) throw new Error('not hit')
    })
    tc('batch with a host-not-quiet void is incomplete', () => {
      const rest = cleanFor(ord)
      rest[2] = null
      if (!bl(buildBatch('void', 'verdict', [l3Wall(), ...rest])).startsWith('BATCH INCOMPLETE')) throw new Error('not incomplete')
    })
    tc('batch first run not l3 is void', () => {
      const shifted = [{ n: 1, shape: 'l1', aProfile: 'transaction', cluster: '2' }, ...ord.slice(1)]
      const dir = buildBatch('notl3', 'verdict', [mkResult('l1'), ...cleanFor(ord)], shifted)
      const b = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')); b.order = shifted
      writeFileSync(join(dir, 'batch.json'), JSON.stringify(b))
      if (!bl(dir).startsWith('BATCH VOID')) throw new Error('not void')
    })
    tc('batch order mismatch is void', () => {
      const dir = buildBatch('order', 'verdict', [l3Wall(), ...cleanFor(ord)])
      const b = JSON.parse(readFileSync(join(dir, 'batch.json'), 'utf8')); b.order = makeOrder(2)
      writeFileSync(join(dir, 'batch.json'), JSON.stringify(b))
      eq(bl(dir), 'BATCH VOID (order mismatch)')
    })
    tc('smoke batch never says the verdict word', () => {
      const dir = buildBatch('smoke', 'smoke', [l3Wall(), mkResult('l1')])
      const out = classifyBatch(dir, mut)
      if (!out.batchLine.startsWith('BATCH SMOKE l3=CONTROL WALL SHOWN l1=CLEAN')) throw new Error(out.batchLine)
      if ((out.lines.join('\n') + out.batchLine).includes('VERDICT')) throw new Error('verdict word in smoke output')
    })
    tc('order: seeds 1 and 2 have 11 entries, l3 first, strict alternation', () => {
      for (const seed of [1, 2]) {
        const o = makeOrder(seed)
        if (o.length !== 11 || o[0].shape !== 'l3' || o[0].aProfile !== 'transaction' || o[0].cluster !== '2') throw new Error('shape ' + seed)
        for (let i = 2; i < 11; i++) if (o[i].shape === o[i - 1].shape) throw new Error('alternation ' + seed)
      }
    })
    tc('order: every condition pair once as l1 and once as l2', () => {
      const o = makeOrder(3).slice(1)
      const key = (e) => `${e.aProfile}:${e.cluster}`
      const count = (shape) => o.filter((e) => e.shape === shape).map(key).sort().join('|')
      eq(count('l1'), count('l2'))
      eq(count('l1'), ['storage:2', 'transaction:2', 'transaction:2', 'transaction:2', 'transaction:default'].sort().join('|'))
    })
    tc('order: reproducible, and varies over seeds', () => {
      eq(JSON.stringify(makeOrder(7)), JSON.stringify(makeOrder(7)))
      const conds = new Set(); const starts = new Set()
      for (let s = 1; s <= 10; s++) { const o = makeOrder(s); conds.add(o.slice(1).map((e) => `${e.aProfile}${e.cluster}`).join(',')); starts.add(o[1].shape) }
      if (conds.size < 2 || starts.size < 2) throw new Error(`conds ${conds.size} starts ${starts.size}`)
    })
    tc('CLASSIFY_MUTATE is refused outside --selftest', () => {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--order', '--seed', '1'], { env: { ...process.env, CLASSIFY_MUTATE: 'ignore-hidden' }, encoding: 'utf8' })
      if (r.status !== 2 || !/REFUSED/.test(r.stdout)) throw new Error(`status ${r.status}`)
    })

    const failed = []
    for (const c of cases) {
      try { c.fn(); console.log(`ok   ${c.name}`) } catch (e) { failed.push(c.name); console.log(`FAIL ${c.name}: ${e.message}`) }
    }
    if (failed.length) { console.log(`SELFTEST FAIL ${failed.join(' | ')}`); return 1 }
    console.log(`SELFTEST PASS ${cases.length}/${cases.length}`)
    return 0
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function main (argv) {
  const has = (f) => argv.includes(f)
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
  if (has('--selftest')) {
    const bad = (process.env.CLASSIFY_MUTATE ?? '').split(',').filter(Boolean).filter((m) => !MUTATIONS.includes(m))
    if (bad.length) { console.log(`REFUSED: unknown CLASSIFY_MUTATE ${bad.join(',')}`); return 2 }
    return runSelftest()
  }
  if ((process.env.CLASSIFY_MUTATE ?? '') !== '') { console.log('REFUSED: CLASSIFY_MUTATE is set'); return 2 }
  if (has('--order')) {
    const seed = Number(arg('--seed') ?? Math.floor(Date.now() / 1000))
    console.log(JSON.stringify(makeOrder(seed)))
    return 0
  }
  if (has('--run')) {
    const c = classifyRun(readFileSync(arg('--run'), 'utf8'))
    console.log(has('--json') ? JSON.stringify(c) : `${c.cls} ${c.why}${c.notes.length ? ' [' + c.notes.join('; ') + ']' : ''}`)
    return 0
  }
  if (has('--batch')) {
    const out = classifyBatch(arg('--batch'))
    if (has('--json')) console.log(JSON.stringify(out))
    else { for (const l of out.lines) console.log(l); console.log(out.batchLine) }
    return 0
  }
  console.log('usage: classify.mjs --selftest | --run <log> [--json] | --batch <dir> [--json] | --order --seed <N>')
  return 64
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)))
