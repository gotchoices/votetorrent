// d14map.mjs - plan 64-63 interfaces D. The one place that maps spike 106 classify.mjs's class to a D-14 reading and applies the in-script rule.
// classify.mjs runs UNCHANGED (spawned, --run <log> --json). Exports are pure except classifyFile.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// spike 106 classify.mjs, carried unchanged into tools/lean-rig/lib
export const CLASSIFY = fileURLToPath(new URL('../lib/classify.mjs', import.meta.url))
export const PIN_KEYS = ['dbP2p', 'dbCore', 'pluginOptimystic', 'cadreCore', 'quereus', 'p2pFret']

export const token = (c) => String(c).replace(/[ ()]+/g, '-')

/** Run classify.mjs unchanged over a leg log. Returns {cls, why, stdout, rc}. */
export function classifyFile (logPath) {
  const run = spawnSync(process.execPath, [CLASSIFY, '--run', logPath, '--json'], { encoding: 'utf8' })
  let j = null
  try { j = JSON.parse(run.stdout.trim()) } catch { j = null }
  return { cls: j?.cls ?? null, why: j?.why ?? '', stdout: run.stdout, rc: run.status }
}

/** interfaces D: HIT iff class is HIT or MASKED HIT; CLEAN iff VOID-run (wrong-stack) naming only pins; anything else is an instrument error. */
export function mapClass (cls, why) {
  if (cls === 'HIT' || cls === 'MASKED HIT') return { reading: 'HIT', classToken: token(cls) }
  if (cls === 'VOID-run (wrong-stack)') {
    const named = String(why).replace(/^stack differs: /, '').split(',').map((x) => x.trim()).filter(Boolean)
    if (named.length > 0 && named.every((k) => PIN_KEYS.includes(k))) return { reading: 'CLEAN', classToken: token(cls) }
    return { reading: 'INSTRUMENT', classToken: token(cls) }
  }
  return { reading: 'INSTRUMENT', classToken: cls ? token(cls) : 'NONE' }
}

/** The in-script D-14 rule (plan decision D-14, interfaces D last paragraph). counts: numbers, all deltas for the leg. */
export function inScript (c) {
  const n = (x) => Number(x ?? 0)
  let reason = 'none'
  if (n(c.oversized) > 0) reason = 'oversized'
  else if (n(c.superMajority) > 0) reason = 'super-majority'
  else if (n(c.torn) > 0) reason = 'torn'
  else if (n(c.invalidDataLength) > 0) reason = 'invalid-data-length'
  else if (n(c.transferLimit) > 0) reason = 'transfer-limit'
  else if (n(c.hiddenOpen) > 0) reason = 'hidden-open'
  else if (n(c.hostVoterHit) > 0) reason = 'host-voter-hit'
  return { hit: reason !== 'none', reason }
}

export function d14Line (leg, status, mapped) {
  const hit = mapped.reading === 'HIT' || status.inScriptD14 === 'HIT'
  const verdict = hit ? 'HIT' : (mapped.reading === 'CLEAN' ? 'CLEAN' : 'HIT')
  const reason = status.inScriptD14 === 'HIT' ? String(status.reason) : (mapped.reading === 'HIT' ? 'classifier-hit' : (mapped.reading === 'CLEAN' ? 'none' : 'instrument'))
  return `D14-CLASS: ${leg} ${verdict} classifier=${mapped.classToken} inScript=${status.inScriptD14} reason=${reason}`
}

/** Field-exact count over ^D14-CLASS: lines; null on a malformed line or a leg named twice. */
export function countLines (text) {
  const lines = text.split('\n').filter((l) => l.startsWith('D14-CLASS: '))
  const seen = new Set()
  let hits = 0
  for (const line of lines) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6 || seen.has(f[1])) return null
    seen.add(f[1])
    if (f[2] === 'HIT' || f[3] === 'classifier=HIT' || f[3] === 'classifier=MASKED-HIT' || f[4] === 'inScript=HIT') hits++
  }
  return { legs: lines.length, hits }
}
