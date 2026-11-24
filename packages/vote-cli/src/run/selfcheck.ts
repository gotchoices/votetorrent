// `vt selfcheck`: an offline self-test of the run machinery (line grammar, masking, scan, relay privacy,
// results shape, peer budget, tokens, leg harness). No daemon, no CadreNode, no network: it imports only
// the run modules and the fs/os/path built-ins, works in one temp dir and removes it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOFT_TOKENS, RUN_TOKENS, TOKEN_RE, createLegRunner } from './legs.js'
import { LINE_GRAMMAR, createRunOutput } from './output.js'
import { PeerBudgetError, assertPeerBudget, defaultMaxPeers } from './peer-budget.js'
import { RESULTS_KEYS, ResultsExistError, buildResults, summaryLine, writeResults } from './results.js'
import { SecretRegistry, createLineMasker, relayIsPrivate } from './secret-scan.js'

export const SELFCHECK_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const)

export interface SelfcheckIo {
  out (text: string): void
}

// Synthetic values: a fake peer id (base58 after the 12D3Koo prefix, no 0/O/I/l) and a plain 40-char value.
const FAKE_PEER = '12D3KooW' + 'SyntheticPeerSe1fcheckSamp1eXyzABCDEFGHJKMNPQRSTUVWxyz'
const FAKE_VALUE = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6M5l4K3j2H1g0'
const TAIL = '/tcp/4001/ws/p2p/' + FAKE_PEER
const FIXED_NOW = 1700000000123

type Check = (dir: string) => Promise<string> | string

export async function runSelfcheck (io: SelfcheckIo): Promise<0 | 1> {
  const dir = mkdtempSync(join(tmpdir(), 'vt-selfcheck-'))
  const failed: string[] = []
  const checks: Record<(typeof SELFCHECK_IDS)[number], Check> = {
    A: checkGrammar,
    B: checkRedact,
    C: checkScan,
    D: checkRelay,
    E: checkResults,
    F: checkBudget,
    G: checkTokens,
    H: checkLegs
  }
  try {
    for (const id of SELFCHECK_IDS) {
      let detail: string
      let pass: boolean
      try {
        detail = await checks[id](join(dir, id))
        pass = true
      } catch (e) {
        detail = (e as Error)?.message?.slice(0, 120) ?? 'failed'
        pass = false
      }
      if (!pass) failed.push(id)
      io.out(`${pass ? 'PASS' : 'FAIL'} ${id} ${detail}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  io.out(failed.length === 0 ? `SELFCHECK: PASS ${SELFCHECK_IDS.length}/${SELFCHECK_IDS.length}` : `SELFCHECK: FAIL ${failed.join(',')}`)
  return failed.length === 0 ? 0 : 1
}

function must (cond: boolean, what: string): void {
  if (!cond) throw new Error(what)
}

interface Capture {
  lines: string[]
  out: ReturnType<typeof createRunOutput>
}

function capture (mask: (s: string) => string, marksFile?: string): Capture {
  const lines: string[] = []
  const out = createRunOutput({ write: (l) => { lines.push(l) }, mask, nowMs: () => FIXED_NOW, perfNow: () => 42, ...(marksFile !== undefined ? { marksFile } : {}) })
  return { lines, out }
}

// (A) every grammar entry matches a line the writer builds, and a corrupted line does not
function checkGrammar (dir: string): string {
  mkdirSync(dir)
  const c = capture((s) => s, join(dir, 'marks.txt'))
  c.out.say('LEG', 'network start')
  c.out.runMark('p1-start')
  c.out.approve({ n: 1, readMs: 1, decideMs: 2, publishMs: 3, publish: 'ok' })
  c.out.leanWait('phone-join')
  c.out.leanGo('phone-join', true, 5)
  c.out.leanNote('note')
  c.out.key('VT-START', 'at=x')
  c.out.result({ tool: 'vt-run' })
  c.out.summary('FAIL network leg-unwired')
  const order = ['say', 'runMark', 'approve', 'leanWait', 'leanGo', 'leanNote', 'key', 'result', 'summary'] as const
  must(c.lines.length === order.length, 'line count')
  order.forEach((g, i) => must(LINE_GRAMMAR[g].test(c.lines[i]!), `grammar ${g}`))
  must(!LINE_GRAMMAR.summary.test('SUMMARY PASSED'), 'corrupted summary matched')
  must(!LINE_GRAMMAR.summary.test('SUMMARY FAIL network'), 'short summary matched')
  must(!LINE_GRAMMAR.runMark.test('RUN-MARK p1-start 17000'), 'short mark matched')
  let threw = false
  try {
    c.out.say('LEG', 'x')
  } catch {
    threw = true
  }
  must(threw, 'write after summary')
  return `${order.length} grammar entries`
}

// (B) the rig redact test: whole value, 16-char window, a full peer id and a LAN ip
function checkRedact (dir: string): string {
  const registry = new SecretRegistry()
  registry.register(FAKE_VALUE, { windows: true })
  const mask = createLineMasker({ registry, stateDir: dir })
  const line = mask(`v=${FAKE_VALUE} w=${FAKE_VALUE.slice(5, 21)} p=${FAKE_PEER} ip=192.168.77.77 d=${dir}/x`)
  must(line === `v=<secret> w=<secret> p=<peer:${FAKE_PEER.slice(-8)}> ip=<lan> d=<run>/x`, 'masked line differs')
  must(!line.includes(FAKE_VALUE.slice(5, 21)), 'window leaked')
  return 'whole, window, peer, lan masked'
}

// (C) scanTree over three planted files
function checkScan (dir: string): string {
  mkdirSync(dir)
  const registry = new SecretRegistry()
  registry.register(FAKE_VALUE, { windows: true })
  writeFileSync(join(dir, 'clean.log'), 'clean\n')
  writeFileSync(join(dir, 'whole.log'), `x ${FAKE_VALUE} y\n`)
  writeFileSync(join(dir, 'window.log'), `x ${FAKE_VALUE.slice(10, 26)} y\n`)
  const scan = registry.scanTree([dir], { exclude: [] })
  must(scan.whole === 1 && scan.windows === 1 && scan.files === 3, `scan ${JSON.stringify(scan)}`)
  return 'whole=1 windows=1 files=3'
}

// (D) the relayIsPrivate table
function checkRelay (): string {
  const table: Array<[string, boolean]> = [
    ['/ip4/127.0.0.1' + TAIL, true],
    ['/ip4/10.1.2.3' + TAIL, true],
    ['/ip4/192.168.1.2' + TAIL, true],
    ['/ip4/172.20.0.1' + TAIL, true],
    ['/ip4/169.254.1.1' + TAIL, true],
    ['/ip6/::1' + TAIL, true],
    ['/dns4/box.local' + TAIL, true],
    ['/dns4/relay.example.org' + TAIL, false],
    ['/ip4/8.8.8.8' + TAIL, false]
  ]
  for (const [addr, want] of table) must(relayIsPrivate(addr) === want, `relayIsPrivate ${addr.slice(0, 20)}`)
  must(relayIsPrivate('/ip4/8.8.8.8' + TAIL, '8.8.8.8'), 'lanIp match')
  return `${table.length + 1} addresses`
}

// (E) results.json keys and the write-once rule
function checkResults (dir: string): string {
  mkdirSync(dir)
  const obj = buildResults({
    summary: 'PASS',
    legs: [{ leg: 'network', status: 'PASS', token: '', inScriptD14: 'OFF', reason: 'instruments-off', checks: ['N1'] }],
    durations: { reopenMs: 10 },
    steps: [{ name: 'network', startMs: FIXED_NOW, endMs: FIXED_NOW + 1 }],
    secretScan: { whole: 0, windows: 0, files: 1 },
    keys: { 'VT-START': 'at=x' },
    startedAt: new Date(FIXED_NOW).toISOString(),
    endedAt: new Date(FIXED_NOW + 1).toISOString()
  })
  must(JSON.stringify(Object.keys(obj)) === JSON.stringify(RESULTS_KEYS), 'results keys')
  const p = join(dir, 'results.json')
  writeResults(p, obj)
  let threw = false
  try {
    writeResults(p, obj)
  } catch (e) {
    threw = e instanceof ResultsExistError
  }
  must(threw, 'second write accepted')
  return `${RESULTS_KEYS.length} keys, write-once`
}

// (F) the peer budget
function checkBudget (): string {
  must(defaultMaxPeers(17179869184) === 10, 'defaultMaxPeers(16 GiB)')
  let threw = false
  try {
    assertPeerBudget(11, 10)
  } catch (e) {
    threw = e instanceof PeerBudgetError && e.code === 'max-peers'
  }
  must(threw, 'assertPeerBudget(11, 10)')
  return 'max 10 on 16 GiB, 11 refused'
}

// (G) every token is a token
function checkTokens (): string {
  for (const t of SOFT_TOKENS) must(TOKEN_RE.test(t), `soft ${t}`)
  for (const t of RUN_TOKENS) must(TOKEN_RE.test(t), `run ${t}`)
  must(SOFT_TOKENS.size === 8, 'soft count')
  return `${SOFT_TOKENS.size} soft, ${RUN_TOKENS.length} run tokens`
}

// (H) three legs: pass, soft, hard
async function checkLegs (dir: string): Promise<string> {
  mkdirSync(dir)
  const evDir = join(dir, 'ev')
  mkdirSync(evDir)
  const registry = new SecretRegistry()
  const mask = createLineMasker({ registry, stateDir: dir })
  let now = FIXED_NOW
  const nowMs = (): number => (now += 1)
  const c = capture(mask)
  const runner = createLegRunner({ evDir, flagsDir: dir, out: c.out, mask, nowMs, abort: new Promise<string>(() => {}) })
  const a = await runner.runLeg('network', async (L) => {
    L.check('N1', 'ok', true)
  })
  const b = await runner.runLeg('h6-election', async (L) => {
    L.need('officer-loop', 'O1', 'soft', false)
    L.check('O2', 'went on', true)
  })
  const d = await runner.runLeg('h7-accept', async (L) => {
    L.need('election', 'E1', 'hard', false)
    L.check('E2', 'never', true)
  })
  must(a.status === 'PASS' && a.token === '', 'pass leg')
  must(b.status === 'FAIL' && b.token === 'officer-loop' && b.checks.length === 2, 'soft leg')
  must(d.status === 'FAIL' && d.token === 'election' && d.checks.length === 1, 'hard leg')
  const summary = summaryLine({ statuses: runner.statuses, planLength: 3, scan: { whole: 0, windows: 0, files: 0 } })
  must(summary === 'FAIL h6-election officer-loop', `summary ${summary}`)
  must(!c.lines.some((l) => l.startsWith('LEAN-')), 'host-only leg printed a hand-off line')
  return 'PASS, FAIL officer-loop, FAIL election'
}
