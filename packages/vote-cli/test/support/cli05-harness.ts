// CLI-05 concurrency harness. Everything here is built from node built-ins plus the delivered vote-cli
// exports. Nothing prints: no console calls, no command line, no file content, no token, no relay address or
// full peer id ever reaches mocha, a report or a reason code. Tokens are read only to be registered in a
// SecretRegistry or reduced to a sha256 digest, and are dropped as soon as the request is made.
//
// The lead/window stay at the values 67-31 recorded for the loopback PASS. Pitfall 11: a shorter
// timeline is untested, and 67-34 compares against these values.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { cpus, loadavg, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { callCtl } from '../../src/ctl/ctl-client.js'
import { CTL_PATH, CTL_TOKEN_HEADER, CTL_TOKEN_FILE, CTL_PORT_FILE } from '../../src/ctl/protocol.js'
import { defaultMaxPeers } from '../../src/run/peer-budget.js'
import { SecretRegistry, type SecretScan } from '../../src/run/secret-scan.js'
import { startDaemon, VT_DIST_BIN, type DaemonProc } from './daemon-fixture.js'

export const CLI05_GATE_ENV = 'VT_CLI05'

/** True only for '1': one live pass takes 30-45 min, so 67-33's host-tier suite must not relaunch it. */
export function cli05Enabled (env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLI05_GATE_ENV] === '1'
}

export const CLI05_LEAD_MS = 600000
export const CLI05_WINDOW_MS = 480000

const RELAY_KEY_FILE = 'relay-key.pb'

function digest (value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function textLines (path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
}

function psRows (): Array<{ pid: number, command: string }> {
  let text = ''
  try {
    text = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8', timeout: 30_000 })
  } catch {
    return []
  }
  const rows: Array<{ pid: number, command: string }> = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m !== null && m[1] !== undefined && m[2] !== undefined) rows.push({ pid: Number(m[1]), command: m[2] })
  }
  return rows
}

function ancestorPids (): Set<number> {
  const out = new Set<number>([process.pid])
  let cur = process.pid
  const seen = new Set<number>()
  for (;;) {
    if (seen.has(cur)) break
    seen.add(cur)
    try {
      const text = execFileSync('ps', ['-o', 'ppid=', '-p', String(cur)], { encoding: 'utf8', timeout: 10_000 })
      const m = /^\s*(\d+)\s*$/.exec(text.trim())
      if (m === null || m[1] === undefined) break
      const parent = Number(m[1])
      if (!Number.isInteger(parent) || parent <= 0 || parent === cur) break
      out.add(parent)
      cur = parent
    } catch {
      break
    }
  }
  return out
}

function tcpBusy (port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (busy: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(1000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export interface QuietHostCheck {
  quiet: boolean
  reasons: string[]
  loadavg: number[]
}

/** Fixed reason codes only: a command line is never returned or logged. */
export async function quietHostCheck (): Promise<QuietHostCheck> {
  const reasons: string[] = []
  for (const port of [8081, 8091, 8097]) {
    if (await tcpBusy(port)) reasons.push(`metro-${port}`)
  }
  const own = ancestorPids()
  const forbidden: ReadonlyArray<readonly [string, string]> = [
    ['qemu-system', 'emulator'],
    ['emulator -avd', 'emulator'],
    ['jest-worker', 'jest'],
    ['jest/bin', 'jest'],
    ['relay-only.mjs', 'foreign-relay'],
    ['run election', 'foreign-vt-run']
  ]
  for (const row of psRows()) {
    if (own.has(row.pid)) continue
    for (const [needle, code] of forbidden) {
      if (row.command.includes(needle) && !reasons.includes(code)) reasons.push(code)
    }
  }
  return { quiet: reasons.length === 0, reasons, loadavg: loadavg() }
}

export interface ElectionRunHandle {
  tag: string
  party: string
  stateDir: string
  marksFile: string
  stdoutPath: string
  stderrPath: string
  pid: number
  startedAtMs: number
  done: Promise<{ code: number | null, signal: NodeJS.Signals | null, endedAtMs: number }>
}

export interface StartElectionRunOptions {
  tag: string
  root: string
  party: string
  relayEnvPath: string
  leadMs: number
  windowMs: number
  extraArgs?: readonly string[]
}

function childEnv (): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.DEBUG
  env.FORCE_COLOR = '0'
  return env
}

/** Spawns one `vt run election`, one daemon per peer; the harness does NOT create the state dir. */
export function startElectionRun (opts: StartElectionRunOptions): ElectionRunHandle {
  const stateDir = join(opts.root, opts.tag)
  const marksFile = join(opts.root, `marks-${opts.tag}.txt`)
  const stdoutPath = join(opts.root, `run-${opts.tag}.stdout`)
  const stderrPath = join(opts.root, `run-${opts.tag}.stderr`)
  const outFd = openSync(stdoutPath, 'wx', 0o600)
  const errFd = openSync(stderrPath, 'wx', 0o600)
  const sink = (fd: number) => (chunk: Buffer): void => {
    try { writeSync(fd, chunk) } catch { /* best effort */ }
  }
  const argv = [
    '-n', '10', process.execPath, VT_DIST_BIN,
    'run', 'election',
    '--relay', opts.relayEnvPath,
    '--state', stateDir,
    '--party', opts.party,
    '--keyholders', '2',
    '--voters', '1',
    '--lead-ms', String(opts.leadMs),
    '--window-ms', String(opts.windowMs),
    '--marks-file', marksFile,
    '--alarm-s', '4800',
    ...(opts.extraArgs ?? [])
  ]
  const child = spawn('nice', argv, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', sink(outFd))
  child.stderr?.on('data', sink(errFd))
  const done = new Promise<{ code: number | null, signal: NodeJS.Signals | null, endedAtMs: number }>((resolve) => {
    child.once('close', (code, signal) => {
      try { closeSync(outFd) } catch { /* closed */ }
      try { closeSync(errFd) } catch { /* closed */ }
      resolve({ code, signal, endedAtMs: Date.now() })
    })
    child.once('error', () => {
      try { closeSync(outFd) } catch { /* closed */ }
      try { closeSync(errFd) } catch { /* closed */ }
      resolve({ code: null, signal: null, endedAtMs: Date.now() })
    })
  })
  return {
    tag: opts.tag,
    party: opts.party,
    stateDir,
    marksFile,
    stdoutPath,
    stderrPath,
    pid: child.pid ?? -1,
    startedAtMs: Date.now(),
    done
  }
}

export interface PeerObservation {
  pids: number[]
  peerId8s: string[]
  ports: number[]
  tokenDigests: string[]
  partyIds: string[]
  peakRssBytes: number
}

export interface MonitorReport {
  samples: number
  peers: Record<string, Record<string, PeerObservation>>
  peakRunRssBytes: Record<string, number>
  peakTotalRssBytes: number
  peakCpuPct: number
  capBytes: number
  capExceededTicks: number
}

export interface RunMonitor {
  stop(): MonitorReport
  registerLiveTokens(registry: SecretRegistry, tag: string): number
}

export interface MonitorRun {
  tag: string
  party: string
  stateDir: string
  pid: number
}

export interface StartMonitorOptions {
  runs: readonly MonitorRun[]
  relayDir: string
  intervalMs?: number
  capBytes?: number
  onCapExceeded?: () => void
}

function emptyPeer (): PeerObservation {
  return { pids: [], peerId8s: [], ports: [], tokenDigests: [], partyIds: [], peakRssBytes: 0 }
}

function addOnce<T> (list: T[], value: T): void {
  if (!list.includes(value)) list.push(value)
}

/** Samples ctl files and process RSS/CPU while the runs are live; ctl files vanish on daemon stop. */
export function startRunMonitor (opts: StartMonitorOptions): RunMonitor {
  const intervalMs = opts.intervalMs ?? 5000
  const capBytes = opts.capBytes ?? 0.45 * totalmem()
  const cpuCount = Math.max(1, cpus().length)
  const relayKeyPath = join(opts.relayDir, RELAY_KEY_FILE)
  const peers: MonitorReport['peers'] = {}
  const peakRunRssBytes: Record<string, number> = {}
  const liveTokens: Record<string, string[]> = {}
  const seenPorts = new Map<string, Set<number>>()
  const seenDigests = new Map<string, Set<string>>()
  let samples = 0
  let peakTotalRssBytes = 0
  let peakCpuPct = 0
  let capExceededTicks = 0
  let capNotified = false
  let stopped = false
  for (const run of opts.runs) {
    peers[run.tag] = {}
    peakRunRssBytes[run.tag] = 0
    liveTokens[run.tag] = []
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    const allRows = psRows()
    const relayRow = allRows.find((r) => r.command.includes(relayKeyPath))
    const relayPid = relayRow?.pid ?? -1
    const pids = new Set<number>([relayPid])
    for (const run of opts.runs) {
      pids.add(run.pid)
      const partyDir = join(run.stateDir, run.party)
      let labels: string[] = []
      try {
        labels = readdirSync(partyDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch { /* not booted yet */ }
      for (const label of labels) {
        const peerDir = join(partyDir, label)
        const peer = peers[run.tag]?.[label] ?? emptyPeer()
        try {
          const info = JSON.parse(readFileSync(join(peerDir, 'daemon.json'), 'utf8')) as Record<string, unknown>
          if (typeof info.pid === 'number') addOnce(peer.pids, info.pid)
          if (typeof info.peerId8 === 'string') addOnce(peer.peerId8s, info.peerId8)
          if (typeof info.partyId === 'string') addOnce(peer.partyIds, info.partyId)
          if (typeof info.label === 'string' && info.label !== label) addOnce(peer.partyIds, info.label)
        } catch { /* not written yet */ }
        const portPath = join(peerDir, CTL_PORT_FILE)
        if (existsSync(portPath)) {
          const port = Number(readFileSync(portPath, 'utf8').trim())
          if (Number.isInteger(port) && port > 0) {
            const key = `${run.tag}/${label}`
            const seen = seenPorts.get(key) ?? new Set<number>()
            if (!seen.has(port)) {
              seen.add(port)
              seenPorts.set(key, seen)
              addOnce(peer.ports, port)
            }
          }
        }
        const tokenPath = join(peerDir, CTL_TOKEN_FILE)
        if (existsSync(tokenPath)) {
          const raw = readFileSync(tokenPath, 'utf8').trim()
          if (raw.length >= 8) {
            const key = `${run.tag}/${label}`
            const seen = seenDigests.get(key) ?? new Set<string>()
            const d = digest(raw)
            if (!seen.has(d)) {
              seen.add(d)
              seenDigests.set(key, seen)
              addOnce(peer.tokenDigests, d)
            }
            if (!liveTokens[run.tag]?.includes(raw)) liveTokens[run.tag]?.push(raw)
          }
        }
        if (peers[run.tag] !== undefined) peers[run.tag]![label] = peer
      }
    }
    for (const r of opts.runs) for (const peer of Object.values(peers[r.tag] ?? {})) for (const pid of peer.pids) pids.add(pid)

    const pidList = [...pids].filter((p) => p > 0)
    if (pidList.length > 0) {
      let rows: string[] = []
      try {
        rows = execFileSync('ps', ['-o', 'pid=,rss=,%cpu=', '-p', pidList.join(',')], { encoding: 'utf8', timeout: 30_000 }).split('\n')
      } catch { /* a peer may exit between the ps calls */ }
      const byPid = new Map<number, { rss: number, cpu: number }>()
      for (const row of rows) {
        const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s*$/.exec(row)
        if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) continue
        byPid.set(Number(m[1]), { rss: Number(m[2]) * 1024, cpu: Number(m[3]) })
      }
      let totalRss = 0
      let sumCpu = 0
      for (const run of opts.runs) {
        let runRss = 0
        for (const peer of Object.values(peers[run.tag] ?? {})) {
          let peerRss = 0
          for (const pid of peer.pids) peerRss += byPid.get(pid)?.rss ?? 0
          for (const pid of peer.pids) sumCpu += byPid.get(pid)?.cpu ?? 0
          if (peerRss > peer.peakRssBytes) peer.peakRssBytes = peerRss
          runRss += peerRss
        }
        if (runRss > (peakRunRssBytes[run.tag] ?? 0)) peakRunRssBytes[run.tag] = runRss
        totalRss += runRss
      }
      totalRss += byPid.get(relayPid)?.rss ?? 0
      sumCpu += byPid.get(relayPid)?.cpu ?? 0
      for (const run of opts.runs) sumCpu += byPid.get(run.pid)?.cpu ?? 0
      if (totalRss > peakTotalRssBytes) peakTotalRssBytes = totalRss
      const cpuPct = sumCpu / cpuCount
      if (cpuPct > peakCpuPct) peakCpuPct = cpuPct
      if (totalRss > capBytes) capExceededTicks++
      else capExceededTicks = 0
      if (capExceededTicks >= 3 && !capNotified) {
        capNotified = true
        opts.onCapExceeded?.()
      }
    }
    samples++
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  return {
    registerLiveTokens (registry: SecretRegistry, tag: string): number {
      const tokens = liveTokens[tag] ?? []
      for (const token of tokens) registry.register(token, { windows: true })
      return tokens.length
    },
    stop (): MonitorReport {
      stopped = true
      clearInterval(timer)
      return {
        samples,
        peers,
        peakRunRssBytes,
        peakTotalRssBytes,
        peakCpuPct,
        capBytes,
        capExceededTicks
      }
    }
  }
}

/**
 * One POST to the target peer's ctl endpoint, carrying the OTHER peer's token. The token is read,
 * used and dropped inside this function; only the HTTP status leaves it.
 */
export function ctlStatus (targetPeerDir: string, tokenSourcePeerDir: string): Promise<number> {
  let port = 0
  let token = ''
  try {
    port = Number(readFileSync(join(targetPeerDir, CTL_PORT_FILE), 'utf8').trim())
    token = readFileSync(join(tokenSourcePeerDir, CTL_TOKEN_FILE), 'utf8').trim()
  } catch {
    return Promise.resolve(0)
  }
  const payload = JSON.stringify({ verb: 'readback', args: {} })
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: CTL_PATH,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          [CTL_TOKEN_HEADER]: token
        }
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
      }
    )
    request.setTimeout(30_000, () => {
      request.destroy()
      resolve(0)
    })
    request.once('error', () => resolve(0))
    request.end(payload)
  })
}

const RESULT_RE = /^\s*RESULT (\{.*\})\s*$/

export interface RefusalOptions {
  tag: string
  root: string
  party: string
  relayEnvPath: string
  maxPeers?: number
  voters: number
}

export interface RefusalResult {
  code: number | null
  elapsedMs: number
  stderrLine: string
  result: Record<string, unknown>
  stateExists: boolean
  marksExists: boolean
  procsAfter: number
  activeReservations: number
}

function countPathProcs (root: string, tag: string): number {
  const needle = join(root, tag)
  return psRows().filter((r) => r.command.includes(needle)).length
}

/** A live refusal. The harness creates nothing; a side effect would be a product defect. */
export function runRefusal (opts: RefusalOptions): RefusalResult {
  const stateDir = join(opts.root, opts.tag)
  const marksFile = join(opts.root, `marks-${opts.tag}.txt`)
  const outPath = join(opts.root, `refusal-${opts.tag}.out`)
  const argv = [
    '-n', '10', process.execPath, VT_DIST_BIN,
    'run', 'election',
    '--relay', opts.relayEnvPath,
    '--state', stateDir,
    '--party', opts.party,
    '--keyholders', '2',
    '--voters', String(opts.voters),
    ...(opts.maxPeers === undefined ? [] : ['--max-peers', String(opts.maxPeers)]),
    '--alarm-s', '4800'
  ]
  const started = Date.now()
  const run = spawnSync('nice', argv, { env: childEnv(), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  const elapsedMs = Date.now() - started
  writeFileSync(outPath, (run.stdout ?? '') + '\n' + (run.stderr ?? ''), { flag: 'wx', mode: 0o600 })
  let result: Record<string, unknown> = {}
  for (const line of textLines(outPath)) {
    const m = RESULT_RE.exec(line)
    if (m !== null && m[1] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(m[1])
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) result = parsed as Record<string, unknown>
      } catch { /* keep the last valid RESULT */ }
    }
  }
  const stderrLine = textLines(outPath).map((l) => l.trim()).filter((l) => /^vt run: /.test(l)).at(-1) ?? ''
  const status = readRelayLog(join(dirname(opts.relayEnvPath), 'relay.log')).lastActiveReservations
  return {
    code: typeof run.status === 'number' ? run.status : null,
    elapsedMs,
    stderrLine,
    result,
    stateExists: existsSync(stateDir),
    marksExists: existsSync(marksFile),
    procsAfter: countPathProcs(opts.root, opts.tag),
    activeReservations: status
  }
}

/** The unmodified default formula, used only to CHOOSE the over-budget voter count. */
export function cli05OverBudgetVoters (): number {
  const voters = defaultMaxPeers() + 1 - 3
  if (voters < 1 || voters > 9) throw new Error('host-budget-too-large')
  return voters
}

function walkFiles (root: string, pick: (path: string, name: string) => boolean): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = lstatSync(p)
      } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (name === 'secrets' || name === 'vault' || name === 'node') continue
        walk(p)
        continue
      }
      if (st.isFile() && pick(p, name)) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/** Registers every regular secret file by path; the content is never returned or logged. */
export function collectRunSecrets (stateDir: string, party: string, registry: SecretRegistry): number {
  const files = walkFiles(join(stateDir, 'secrets'), () => true)
  const partyDir = join(stateDir, party)
  try {
    for (const label of readdirSync(partyDir)) {
      files.push(...walkFiles(join(partyDir, label, 'secrets'), () => true))
    }
  } catch { /* no peers booted */ }
  for (const p of files) registry.registerFile(p, { windows: true })
  return files.length
}

/** Evidence files only: no secrets, no vault, no node state, no symlinks. */
export function runLogFiles (stateDir: string, party: string): string[] {
  const ev = walkFiles(join(stateDir, 'ev'), () => true)
  const peer: string[] = []
  const partyDir = join(stateDir, party)
  try {
    for (const label of readdirSync(partyDir)) {
      peer.push(...walkFiles(join(partyDir, label), (_p, name) => name.endsWith('.log') || /^boot-.*\.json$/.test(name) || name === 'daemon.json' || name === 'crash.jsonl'))
    }
  } catch { /* no peers booted */ }
  return [...ev, ...peer].sort()
}

/** Uses the delivered scanTree chunk/count logic; roots are the files' parents, include selects exact paths. */
export function scanFiles (registry: SecretRegistry, files: string[]): SecretScan {
  const wanted = new Set(files)
  const roots = [...new Set(files.map((p) => dirname(p)))]
  if (roots.length === 0) return { whole: 0, windows: 0, files: 0 }
  return registry.scanTree(roots, {
    exclude: [],
    include: (p) => wanted.has(p)
  })
}

export interface RelayLogView {
  limits: Record<string, unknown>
  statusCount: number
  peakActiveReservations: number
  lastAdmitted: number
  lastRefused: number
  lastTransferLimitErrors: number
  lastLateErrors: number
  lastActiveReservations: number
  admissionInstrument: string
}

function jsonLine (line: string, prefix: string): Record<string, unknown> | undefined {
  if (!line.startsWith(prefix)) return undefined
  try {
    const parsed: unknown = JSON.parse(line.slice(prefix.length))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* not a complete line */ }
  return undefined
}

/** Parses only LIMITS and STATUS lines; the multiaddr and peer id lines are never read into the report. */
export function readRelayLog (logPath: string): RelayLogView {
  let limits: Record<string, unknown> = {}
  let statusCount = 0
  let peakActiveReservations = 0
  let lastAdmitted = 0
  let lastRefused = 0
  let lastTransferLimitErrors = 0
  let lastLateErrors = 0
  let lastActiveReservations = 0
  let admissionInstrument = ''
  for (const line of textLines(logPath)) {
    const l = jsonLine(line, 'RELAY_LIMITS ')
    if (l !== undefined) { limits = l; continue }
    const s = jsonLine(line, 'RELAY_STATUS ')
    if (s === undefined) continue
    statusCount++
    const num = (k: string): number => typeof s[k] === 'number' ? s[k] as number : 0
    lastActiveReservations = num('activeReservations')
    if (lastActiveReservations > peakActiveReservations) peakActiveReservations = lastActiveReservations
    lastAdmitted = num('reservationsAdmitted')
    lastRefused = num('reservationsRefused')
    lastTransferLimitErrors = num('transferLimitErrors')
    lastLateErrors = num('lateErrors')
    if (typeof s.admissionInstrument === 'string') admissionInstrument = s.admissionInstrument
  }
  return {
    limits,
    statusCount,
    peakActiveReservations,
    lastAdmitted,
    lastRefused,
    lastTransferLimitErrors,
    lastLateErrors,
    lastActiveReservations,
    admissionInstrument
  }
}

export interface ReleaseIds {
  network: string
  election: string
  tokenFiles: { 'kh-a': string, 'kh-b': string }
  releasingKeysAtMs?: number
}

export interface PostReleaseResult {
  ran: true
  khA: { ok: boolean, alreadyReleased: boolean, ms: number }
  khB: { ok: boolean, alreadyReleased: boolean, ms: number }
  bootRefusal?: string
}

/** Case F fallback only: a reduced run that stopped before h10. Never patches or deletes a daemon lock. */
export async function postRunRelease (opts: {
  stateDir: string
  party: string
  relayEnvPath: string
  ids: ReleaseIds
  logDir: string
}): Promise<PostReleaseResult> {
  const logDir = opts.logDir
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const waitMs = opts.ids.releasingKeysAtMs === undefined
    ? 0
    : Math.min(900000, Math.max(0, opts.ids.releasingKeysAtMs - Date.now() + 5000))
  const daemons: DaemonProc[] = []
  let bootRefusal: string | undefined
  for (const label of ['officer', 'kh-a', 'kh-b']) {
    const role = label === 'officer' ? 'officer' : 'keyholder'
    const daemon = await startDaemon({
      role,
      peerDir: join(opts.stateDir, opts.party, label),
      relayEnvPath: opts.relayEnvPath,
      party: opts.party,
      logDir
    })
    if (!daemon.ready && daemon.bootFailedToken !== undefined && bootRefusal === undefined) bootRefusal = daemon.bootFailedToken
    daemons.push(daemon)
  }
  const release = async (label: 'kh-a' | 'kh-b'): Promise<PostReleaseResult['khA']> => {
    const started = Date.now()
    const reply = await callCtl({
      dir: join(opts.stateDir, opts.party, label),
      role: 'keyholder',
      verb: 'release',
      args: {
        network: opts.ids.network,
        election: opts.ids.election,
        tokenFile: opts.ids.tokenFiles[label],
        waitMs: String(waitMs),
        awaitCount: '2'
      },
      timeoutMs: 900000
    })
    return {
      ok: reply.status === 200 && reply.body.ok === true,
      alreadyReleased: reply.body.ok === true && reply.body.result?.alreadyReleased === true,
      ms: Date.now() - started
    }
  }
  let khA: PostReleaseResult['khA'] = { ok: false, alreadyReleased: false, ms: 0 }
  let khB: PostReleaseResult['khB'] = { ok: false, alreadyReleased: false, ms: 0 }
  if (bootRefusal === undefined) [khA, khB] = await Promise.all([release('kh-a'), release('kh-b')])
  for (const daemon of daemons) await daemon.stop()
  const out: PostReleaseResult = { ran: true, khA, khB }
  if (bootRefusal !== undefined) out.bootRefusal = bootRefusal
  return out
}

/** Written once, 0600. Only numbers, codes, party ids, labels, durations, SUMMARY lines and counts. */
export function writeCli05Report (path: string, report: unknown): void {
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

/** A scratch positive control: a copied secret is scanned once and unlinked immediately. */
export function positiveControl (secretFile: string, controlDir: string, registry: SecretRegistry): SecretScan {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 })
  const planted = join(controlDir, 'planted.txt')
  copyFileSync(secretFile, planted)
  chmodSync(planted, 0o600)
  const scan = scanFiles(registry, [planted])
  unlinkSync(planted)
  rmdirSync(controlDir)
  return scan
}

/** The first sorted regular file under a run's secret dir; only its PATH is returned. */
export function firstSecretFile (stateDir: string): string {
  const files = walkFiles(join(stateDir, 'secrets'), () => true)
  const first = files[0]
  if (first === undefined) throw new Error('no-secret-file')
  return first
}

/** Helper for the survivor check: a count only, never a command line. */
export function survivorCount (needles: readonly string[]): number {
  return psRows().filter((r) => needles.some((n) => r.command.includes(n))).length
}
