// Orchestrator side of `--instruments`: file-channel readers over the daemon preload's control-leaf
// replies, the fork precheck at a run point, wall assembly for results.json.wall and the spike-106
// classify.json. Nothing here imports an engine package or opens a socket; all values that reach the
// evidence are numbers, tokens and fork lines only.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRound, forkPrecheck, type ControlLeafResult } from './control-leaf.js'
import { classifyRun } from './classify.js'
import { createWallCounters, wallTotal, type ErrorViewLike, type ProbeSnapshot, type WallPath } from './wall.js'
import type { DaemonLauncher } from '../daemon-launcher.js'
import type { RunOutput } from '../output.js'

export const INSTRUMENT_REQUEST_TIMEOUT_MS = 10000
const REPLY_POLL_MS = 25

let seqCounter = 0

export interface ControlLeafReply {
  seq: number
  peerId8: string
  read: ControlLeafResult
  digestMismatch: number
}

export interface FileReaderOptions {
  dir: string
  seq: number
  peerId8: string
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface FileReply {
  read: ControlLeafResult
  digestMismatch: number
}

export function writeControlLeafRequest (dir: string, seq: number, peerId8: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `req-${seq}.json`), JSON.stringify({ seq, peerId8 }) + '\n', { flag: 'wx', mode: 0o600 })
}

/** Waits for the preload's `res-<seq>.json`; a missing or malformed reply is always an unreadable read. */
export async function readControlLeafReply (opts: FileReaderOptions): Promise<FileReply> {
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.timeoutMs ?? INSTRUMENT_REQUEST_TIMEOUT_MS)
  for (;;) {
    try {
      const reply = JSON.parse(readFileSync(join(opts.dir, `res-${opts.seq}.json`), 'utf8')) as Partial<ControlLeafReply>
      if (reply.seq === opts.seq && reply.peerId8 === opts.peerId8 && reply.read !== undefined) {
        return { read: reply.read, digestMismatch: typeof reply.digestMismatch === 'number' ? reply.digestMismatch : 0 }
      }
    } catch {
      // the reply is written by temp + rename: a partial read is just a miss
    }
    if (now() >= deadline) return { read: { unreadable: 'read-timeout' }, digestMismatch: 0 }
    await sleep(REPLY_POLL_MS)
  }
}

export async function readFileControlLeaf (opts: FileReaderOptions): Promise<ControlLeafResult> {
  return (await readControlLeafReply(opts)).read
}

const fmtRead = (r: ControlLeafResult | undefined): string => {
  if (r !== undefined && typeof r === 'object' && !('unreadable' in r)) {
    return `leafRev=${r.leafRev} leafAction8=${r.leafAction8} tailRev=${r.tailRev} tailAction8=${r.tailAction8}`
  }
  return `unreadable=${String((r as { unreadable?: unknown } | undefined)?.unreadable ?? 'none').replace(/[^a-z0-9-]/g, '')}`
}

export interface ForkPrecheckOutcome {
  line: string
  pass: boolean
  token: string
}

export interface WallForResults {
  probe: { installed: boolean, calls: number, maxRequestBytes: number, oversized: number }
  paths: Record<WallPath, number>
  forkPrechecks: Array<{ point: string, line: string }>
  classify: Record<string, string>
}

export interface RunInstruments {
  wall: ReturnType<typeof createWallCounters>
  forkPrecheck (point: string, legDir: string, labels: readonly string[]): Promise<ForkPrecheckOutcome>
  probeSnapshot (): Promise<ProbeSnapshot>
  lateFromCrashLogs (): Promise<void>
  wallForResults (): Promise<WallForResults>
  writeClassify (evDir: string, legs: readonly { name: string }[]): Promise<void>
}

export interface RunInstrumentsOptions {
  enabled: boolean
  stateDir: string
  party: string
  evDir: string
  launcher: Pick<DaemonLauncher, 'handle'>
  out: Pick<RunOutput, 'say'>
  timeoutMs?: number
  nowMs?: () => number
}

export function createRunInstruments (opts: RunInstrumentsOptions): RunInstruments | null {
  if (!opts.enabled) return null
  const wall = createWallCounters()
  const classifications: Record<string, string> = {}
  const prechecks: Array<{ point: string, line: string }> = []
  const timeoutMs = opts.timeoutMs ?? INSTRUMENT_REQUEST_TIMEOUT_MS

  const peerDirs = (): string[] => {
    const partyDir = join(opts.stateDir, opts.party)
    try {
      return readdirSync(partyDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(partyDir, e.name))
    } catch {
      return []
    }
  }

  const probeSnapshot = async (): Promise<ProbeSnapshot> => {
    const out: ProbeSnapshot = { installed: false, calls: 0, maxBytes: 0, oversized: 0 }
    for (const dir of peerDirs()) {
      try {
        const p = JSON.parse(readFileSync(join(dir, 'instruments', 'size-probe.json'), 'utf8')) as Partial<ProbeSnapshot>
        if (p.installed === true) out.installed = true
        if (typeof p.calls === 'number') out.calls += p.calls
        if (typeof p.maxBytes === 'number' && p.maxBytes > out.maxBytes) out.maxBytes = p.maxBytes
        if (typeof p.oversized === 'number') out.oversized += p.oversized
      } catch {
        // a daemon that never installed the probe has no file
      }
    }
    return out
  }

  const lateFromCrashLogs = async (): Promise<void> => {
    for (const dir of peerDirs()) {
      let text = ''
      try {
        text = readFileSync(join(dir, 'crash.jsonl'), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          wall.record('late', JSON.parse(line) as ErrorViewLike)
        } catch {
          // a torn tail line is not a wall signal
        }
      }
    }
  }

  const forkPrecheckAt = async (point: string, legDir: string, labels: readonly string[]): Promise<ForkPrecheckOutcome> => {
    const readers: Record<string, () => Promise<ControlLeafResult>> = {}
    let digests = 0
    for (const label of labels) {
      const handle = opts.launcher.handle(label)
      if (handle === undefined) {
        readers[label] = async () => ({ unreadable: 'role-missing' })
        continue
      }
      let peerId8 = ''
      try {
        const back = await handle.call('readback', {}, { timeoutMs })
        if (back.ok && typeof back.result.peerId8 === 'string') peerId8 = back.result.peerId8
      } catch {
        // an unreachable peer reads as unreadable, never as a fork
      }
      if (peerId8.length === 0) {
        readers[label] = async () => ({ unreadable: 'readback-failed' })
        continue
      }
      const seq = ++seqCounter
      const dir = handle.instrDir
      try {
        writeControlLeafRequest(dir, seq, peerId8)
      } catch {
        readers[label] = async () => ({ unreadable: 'request-failed' })
        continue
      }
      readers[label] = async () => {
        const reply = await readControlLeafReply({ dir, seq, peerId8, timeoutMs })
        digests += reply.digestMismatch
        return reply.read
      }
    }
    const result = await forkPrecheck({ readers, digestMismatch: () => digests })
    const body = [
      result.line,
      `rounds: ${result.rounds}`,
      `round-verdict: ${classifyRound(result.last).verdict}`,
      ...labels.map((l) => `read ${l}: ${fmtRead(result.last[l])}`)
    ].join('\n') + '\n'
    try {
      writeFileSync(join(legDir, `fork-precheck-${point}.md`), body, { flag: 'wx', mode: 0o600 })
    } catch {
      // evidence is write-once: a second precheck at the same point never overwrites the first
    }
    opts.out.say('FORK', result.line)
    prechecks.push({ point, line: result.line })
    const parts = result.line.split(' ')
    return { line: result.line, pass: parts[1] === 'PASS', token: parts[1] === 'FAIL' ? (parts[2] ?? '') : '' }
  }

  const writeClassify = async (evDir: string, legs: readonly { name: string }[]): Promise<void> => {
    const out: Record<string, { cls: string, why: string }> = {}
    for (const leg of legs) {
      let text = ''
      try {
        text = readFileSync(join(evDir, leg.name, 'wall-leg.log'), 'utf8')
      } catch {
        // a leg that never wrote a wall log classifies as instrument-never-started
      }
      const c = classifyRun(text)
      out[leg.name] = { cls: c.cls, why: c.why }
      classifications[leg.name] = c.cls
    }
    try {
      writeFileSync(join(evDir, 'classify.json'), JSON.stringify(out, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch {
      // EEXIST: never overwrite evidence
    }
  }

  const wallForResults = async (): Promise<WallForResults> => {
    try {
      const saved = JSON.parse(readFileSync(join(opts.evDir, 'classify.json'), 'utf8')) as Record<string, { cls?: unknown }>
      for (const [name, value] of Object.entries(saved)) {
        if (typeof value?.cls === 'string') classifications[name] = value.cls
      }
    } catch {
      // no classify.json yet: use what writeClassify recorded in memory
    }
    const probe = await probeSnapshot()
    const snap = wall.snapshot()
    return {
      probe: { installed: probe.installed, calls: probe.calls, maxRequestBytes: probe.maxBytes, oversized: probe.oversized },
      paths: { hidden: wallTotal(snap.paths.hidden), thrown: wallTotal(snap.paths.thrown), late: wallTotal(snap.paths.late) },
      forkPrechecks: [...prechecks],
      classify: { ...classifications }
    }
  }

  return { wall, forkPrecheck: forkPrecheckAt, probeSnapshot, lateFromCrashLogs, wallForResults, writeClassify }
}

/** Kept exported so the file-channel reply shape has a single, reviewable definition. */
export function controlLeafReplyShape (): readonly string[] {
  return Object.freeze(['seq', 'peerId8', 'read', 'digestMismatch'])
}
