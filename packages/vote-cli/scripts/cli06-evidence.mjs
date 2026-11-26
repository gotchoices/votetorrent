// CLI-06 evidence helper of plan 67-34. It reads results, profiles, samples and evidence files and
// prints token-only readouts for the inspiringlab acceptance run. The profile scripts it feeds live
// outside the repository and are never copied in; rig processes are recognised by basename only.
import { readFileSync as rd, writeFileSync as wr, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, loadavg, cpus, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const GIB = 1073741824, NPT = 5 * 3600000 + 45 * 60000
const ok = (out) => ({ code: 0, out }), usage = () => ({ code: 2, out: [] }), neg = (out) => ({ code: 1, out })
const read = (p) => { try { return rd(p, 'utf8') } catch { return '' } }
const json = (p) => { try { return JSON.parse(read(p)) } catch { return null } }
const cmd = (f, a) => { try { return execFileSync(f, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }) } catch { return '' } }
function opts (argv, from) {
  const pos = [], map = {}
  for (let i = from; i < argv.length; i++) { const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const n = argv[i + 1]; if (n !== undefined && !n.startsWith('--')) { map[a.slice(2)] = n; i++ } else map[a.slice(2)] = 'true'
  }
  return { pos, map }
}
const npt = (ms) => { const s = new Date(Math.round(ms) + NPT).toISOString(); return s.slice(0, 10) + ' ' + s.slice(11, 19) }
const PEER_MARK = 'hr5-' + 'peer.ts'
const MARKS = [PEER_MARK, 'host-' + 'voter.ts', 'host-' + 'kh.ts', 'lean-' + 'part2.ts', 'drone.mjs', 'relay-only.mjs', 'vote-cli/dist/bin/vt.js', 'bin/vt.mjs', 'multipeer-gate']
const BUILDS = ['jest-worker', '/.bin/jest', '/.bin/tsc', 'typescript/bin/tsc', 'GradleDaemon', 'xcodebuild', '/.bin/mocha']

function cmdQuiet (argv) {
  const { map } = opts(argv, 1), peers = Number(map.peers)
  if (!Number.isInteger(peers) || peers <= 0) return usage()
  let ps, ls, vm, load
  if (map.fixture) { const d = map.fixture
    ps = read(join(d, 'ps.txt')); ls = read(join(d, 'lsof.txt')); vm = read(join(d, 'vm_stat.txt')); load = json(join(d, 'load.json'))
  } else { ps = cmd('ps', ['-axo', 'pid,ppid,pcpu,rss,command']); ls = cmd('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']); vm = cmd('vm_stat', []); load = { load: loadavg(), ncpu: cpus().length } }
  const l1 = Number(load?.load?.[0]) || 0, l5 = Number(load?.load?.[1]) || 0, ncpu = Number(load?.ncpu) || cpus().length || 1
  const rows = []
  for (const line of ps.split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line); if (m) rows.push({ pid: +m[1], ppid: +m[2], c: m[5] }) }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid])), skip = new Set([process.pid, process.ppid])
  let cur = process.pid
  while (parent.has(cur)) { const p = parent.get(cur); if (skip.has(p)) break; skip.add(p); cur = p }
  const metro = new Set(), peer = new Set(), build = new Set(), pids = new Set()
  let emulator = false, tsserver = false
  for (const line of ls.split('\n')) { const m = /:(8081|8091|8097)\b/.exec(line); if (!m) continue
    metro.add('metro:' + m[1]); const f = /^\S+\s+(\d+)/.exec(line); if (f && !skip.has(+f[1])) pids.add(+f[1])
  }
  for (const r of rows) { if (skip.has(r.pid)) continue; const c = r.c
    if (c.includes('qemu-system') || c.includes('/emulator/emulator')) { emulator = true; pids.add(r.pid) }
    if (c.includes('tsserver')) { tsserver = true; pids.add(r.pid) }
    for (const p of MARKS) if (c.includes(p)) { peer.add('peer:' + basename(p)); pids.add(r.pid) }
    for (const p of BUILDS) if (c.includes(p)) { build.add('build:' + basename(p)); pids.add(r.pid) }
  }
  const psz = +(/page size of (\d+) bytes/i.exec(vm)?.[1] ?? 4096)
  const pages = (n) => +((new RegExp('^Pages ' + n + ':\\s*([\\d,]+)', 'm').exec(vm)?.[1] ?? '0').replace(/,/g, ''))
  const avail = (pages('free') + pages('inactive') + pages('speculative')) * psz
  const t = []
  for (const p of [...metro].sort((a, b) => +a.slice(6) - +b.slice(6))) t.push(p)
  if (emulator) t.push('emulator')
  for (const p of [...peer].sort()) t.push(p)
  for (const p of [...build].sort()) t.push(p)
  if (tsserver) t.push('tsserver')
  if (l1 > 0.45 * ncpu || l5 > 0.45 * ncpu) t.push('load')
  if (avail < peers * 734003200) t.push('memory')
  const tail = `load1=${l1.toFixed(2)} load5=${l5.toFixed(2)} ncpu=${ncpu} availGiB=${(avail / GIB).toFixed(1)} needGiB=${(peers * 734003200 / GIB).toFixed(1)}`
  return t.length === 0 ? ok([`QUIET ${tail}`]) : neg([`BUSY ${t.join(',')} pids=${[...pids].sort((a, b) => a - b).join(',')} ${tail}`])
}

function cmdWindows (argv) {
  const a = argv.slice(1)
  if (a.length < 2) return usage()
  const d = json(a[0])
  if (!d || !Array.isArray(d.steps)) return usage()
  const w = d.steps.filter((s) => s && s.endMs > s.startMs).map((s) => [s.name, s.startMs, s.endMs]).sort((x, y) => x[1] - y[1])
  try { wr(a[1], JSON.stringify(w) + '\n', { flag: 'wx', mode: 0o600 }) } catch { return usage() }
  return ok([`WINDOWS n=${w.length}`])
}

function cmdSteps (argv) {
  const d = argv[1] ? json(argv[1]) : null
  if (!d) return usage()
  const o = ['| step | start (NPT) | end (NPT) | wall s |', '| --- | --- | --- | --- |']
  for (const s of (d.steps ?? [])) o.push(`| ${s.name} | ${npt(s.startMs)} | ${npt(s.endMs)} | ${((s.endMs - s.startMs) / 1000).toFixed(1)} |`)
  o.push('', '| key | ms |', '| --- | --- |')
  for (const [k, v] of Object.entries(d.durations ?? {})) o.push(`| ${k} | ${v} |`)
  const st = Date.parse(d.startedAt), en = Date.parse(d.endedAt)
  o.push(`RUN startedAt=${d.startedAt} endedAt=${d.endedAt} startNPT=${npt(st)} endNPT=${npt(en)} wallS=${((en - st) / 1000).toFixed(1)}`)
  return ok(o)
}

function table (rows, fmt) {
  const o = ['| name | profile | this run | delta | verdict |', '| --- | --- | --- | --- | --- |']
  for (const r of rows) { let d = 'n/a', v = 'n/a'
    if (r.old !== undefined && r.now !== undefined) { const x = r.now - r.old; d = fmt ? fmt(x) : String(x); v = Math.abs(x) <= Math.abs(r.old) * 0.02 ? 'same' : r.now < r.old ? 'faster' : 'slower' }
    o.push(`| ${r.name} | ${r.old ?? 'n/a'} | ${r.now ?? 'n/a'} | ${d} | ${v} |`)
  }
  return o
}

const windowsOf = (f) => { const d = json(f), m = new Map(); if (Array.isArray(d)) for (const w of d) if (Array.isArray(w) && w.length >= 3 && typeof w[0] === 'string') m.set(w[0], +w[2] - +w[1]); return m }
const sliceOf = (f) => { const m = new Map(); for (const l of read(f).split('\n')) { const x = /^==\s+(\S+)\s+wall=([\d.]+)s\s+busy=([\d.]+)s\s+\((\d+)%\)/.exec(l); if (x) m.set(x[1], { busy: +x[3], pct: +x[4] }) } return m }

function cmdCompare (argv) {
  const { pos, map } = opts(argv, 1)
  if (pos.length < 2) return usage()
  const now = json(pos[0]) ?? {}, old = json(pos[1]) ?? {}, o = []
  const keys = [...new Set([...Object.keys(now.durations ?? {}), ...Object.keys(old.durations ?? {})])]
  o.push(...table(keys.map((k) => ({ name: k, old: old.durations?.[k], now: now.durations?.[k] }))))
  if (map['new-windows'] && map['old-windows']) { const nw = windowsOf(map['new-windows']), ow = windowsOf(map['old-windows']); o.push('', ...table([...nw.keys()].filter((n) => ow.has(n)).map((n) => ({ name: n, old: ow.get(n), now: nw.get(n) })))) }
  if (map['new-slice'] && map['old-slice']) { const ns = sliceOf(map['new-slice']), os = sliceOf(map['old-slice']); o.push('', ...table([...ns.keys()].filter((n) => os.has(n)).map((n) => ({ name: n, old: os.get(n).busy, now: ns.get(n).busy })), (d) => d.toFixed(1))) }
  return ok(o)
}

function cmdBudget (argv) {
  const { pos, map } = opts(argv, 1), ncpu = Number(map.ncpu ?? cpus().length), total = Number(map.totalmem ?? totalmem())
  if (!pos[0] || !(ncpu > 0) || !(total > 0)) return usage()
  let files = []
  try { files = readdirSync(pos[0], { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.samples')) } catch { return usage() }
  const rss = new Map(), cores = new Map()
  for (const e of files) for (const l of read(join(pos[0], e.name)).split('\n')) {
    if (!l || l.startsWith('#')) continue
    const p = l.trim().split(/\s+/), wall = Number(p[0])
    if (!Number.isFinite(wall)) continue
    const b = Math.floor(wall / 5000)
    rss.set(b, (rss.get(b) ?? 0) + (Number(p[7]) || 0))
    cores.set(b, (cores.get(b) ?? 0) + ((Number(p[2]) || 0) + (Number(p[3]) || 0)) / 5e6)
  }
  const peakRss = Math.max(0, ...rss.values()), peakCores = Math.max(0, ...cores.values())
  const capRss = Math.round(0.45 * total / 1048576), capCores = 0.45 * ncpu
  return ok([`BUDGET files=${files.length} peakRssMB=${peakRss} capRssMB=${capRss} peakCores=${peakCores.toFixed(2)} capCores=${capCores.toFixed(2)} within=${peakRss <= capRss && peakCores <= capCores ? 'yes' : 'no'}`])
}

function cmdSpan (argv) {
  const { pos, map } = opts(argv, 1), prof = pos[0] ? json(pos[0]) : null
  if (pos.length < 2 || !prof || !Array.isArray(prof.timeDeltas)) return usage()
  const span = prof.timeDeltas.reduce((a, b) => a + b, 0) / 1000
  let lastWall = 0
  for (const l of read(pos[1]).split('\n')) { if (!/^\d/.test(l)) continue; const w = Number(l.trim().split(/\s+/)[0]); if (Number.isFinite(w)) lastWall = w }
  const start = Math.round(lastWall - span), sp = map['spawn-ms']
  const diff = sp !== undefined && Number.isFinite(Number(sp)) ? String(Math.round(start - Number(sp))) : 'n/a'
  return ok([`SPAN profileS=${(span / 1000).toFixed(1)} samplesS=${(lastWall / 1000).toFixed(1)} startWallMs=${start} spawnDiffMs=${diff}`])
}

function cmdScan (argv) {
  const a = argv.slice(1)
  if (a.length < 3) return usage()
  const [evFile, envFile, stateDir] = a, secrets = new Set()
  for (const l of read(envFile).split('\n')) { const m = /^\s*(RELAY_MULTIADDR|PEER_ID|LAN_IP)=(.*)$/.exec(l); if (m && m[2].trim()) secrets.add(m[2].trim()) }
  const walk = (dir, only) => { let es = []; try { es = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of es) { const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, only); continue }
      if (!e.isFile() || (only && e.name !== only)) continue
      const v = read(p).trim(); if (v) secrets.add(v)
    }
  }
  walk(join(stateDir, 'secrets')); walk(stateDir, 'ctl.token')
  const ev = read(evFile), lineOf = (i) => ev.slice(0, i).split('\n').length, hits = []
  for (const s of secrets) { let from = 0
    for (;;) { const i = ev.indexOf(s, from); if (i < 0) break; hits.push({ line: lineOf(i), kind: 'secret' }); from = i + Math.max(1, s.length) }
  }
  const windows = new Set()
  for (const s of secrets) { if (s.length < 16) continue; for (let i = 0; i + 16 <= s.length; i++) windows.add(s.slice(i, i + 16)) }
  for (const w of windows) { const i = ev.indexOf(w); if (i >= 0) hits.push({ line: lineOf(i), kind: 'window' }) }
  for (const m of ev.matchAll(/12D3KooW[1-9A-HJ-NP-Za-km-z]{44}/g)) hits.push({ line: lineOf(m.index), kind: 'peer-id' })
  for (const m of ev.matchAll(/[0-9a-f]{64}/g)) hits.push({ line: lineOf(m.index), kind: 'hex64' })
  for (const m of ev.matchAll(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/g)) hits.push({ line: lineOf(m.index), kind: 'lan-ip' })
  hits.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
  const o = [`EVIDENCE-SCAN secrets=${secrets.size} hits=${hits.length}`]
  for (const h of hits) o.push(`hit line=${h.line} kind=${h.kind}`)
  return hits.length === 0 ? ok(o) : neg(o)
}

function runCases (dir) {
  const checks = [], check = (id, c) => checks.push([id, !!c])
  const put = (n, s) => { const p = join(dir, n); wr(p, s); return p }
  const fresh = (n) => { const p = join(dir, n); rmSync(p, { recursive: true, force: true }); mkdirSync(p); return p }
  const PS = '  PID  PPID  %CPU   RSS COMMAND\n    1     0   0.0  1000 /sbin/launchd\n', LS = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'
  const VM = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:                                2000000.\nPages inactive:                             1000000.\nPages speculative:                           500000.\n'
  const fix = (n, ps, ls, load) => { const d = fresh(n); wr(join(d, 'ps.txt'), ps); wr(join(d, 'lsof.txt'), ls); wr(join(d, 'vm_stat.txt'), VM); wr(join(d, 'load.json'), JSON.stringify(load)); return d }
  const tok = (r) => r.out[0]?.split(' ')[1] ?? ''
  const q0 = dispatch(['quiet', '--peers', '6', '--fixture', fix('q0', PS, LS, { load: [0.1, 0.1, 0.1], ncpu: 8 })])
  check('quiet-empty', q0.code === 0 && q0.out[0]?.startsWith('QUIET '))
  const q1 = dispatch(['quiet', '--peers', '6', '--fixture', fix('q1', PS + ' 5555     1   0.0  1000 node /somewhere/' + PEER_MARK + '\n', LS + 'node 4242 root 12u IPv4 0x0 0t0 TCP *:8081 (LISTEN)\n', { load: [0.1, 0.1, 0.1], ncpu: 8 })])
  check('quiet-busy', q1.code === 1 && tok(q1) === 'metro:8081,peer:' + PEER_MARK)
  const q2 = dispatch(['quiet', '--peers', '6', '--fixture', fix('q2', PS, LS, { load: [4.0, 0.1, 0.1], ncpu: 8 })])
  check('quiet-load', q2.code === 1 && tok(q2).split(',').includes('load'))
  const results = { steps: [{ name: 'alpha', startMs: 1000, endMs: 2000 }, { name: 'beta', startMs: 500, endMs: 900 }, { name: 'gamma', startMs: 3000, endMs: 3500 }], durations: { reopenMs: 100, dkgMs: 200 }, startedAt: '2026-11-24T00:00:00.000Z', endedAt: '2026-11-24T00:01:00.000Z' }
  const rp = put('results.json', JSON.stringify(results)), op = join(dir, 'windows.json')
  check('windows', dispatch(['windows', rp, op]).out[0] === 'WINDOWS n=3')
  check('windows-refuse', dispatch(['windows', rp, op]).code === 2)
  const st = dispatch(['steps', rp])
  check('steps', st.out.includes('| step | start (NPT) | end (NPT) | wall s |') && st.out.at(-1) === 'RUN startedAt=2026-11-24T00:00:00.000Z endedAt=2026-11-24T00:01:00.000Z startNPT=2026-11-24 05:45:00 endNPT=2026-11-24 05:46:00 wallS=60.0')
  const nw = put('nw.json', '[["alpha",1000,1100]]'), ow = put('ow.json', '[["alpha",1000,1200]]')
  const ns = put('ns.txt', '== alpha  wall=1.0s busy=0.5s (50%) gc=0.0s samples=10\n'), os = put('os.txt', '== alpha  wall=1.0s busy=0.8s (80%) gc=0.0s samples=10\n')
  const orp = put('old.json', JSON.stringify({ durations: { reopenMs: 200, dkgMs: 100 } }))
  const text = dispatch(['compare', rp, orp, '--new-windows', nw, '--old-windows', ow, '--new-slice', ns, '--old-slice', os]).out.join('\n')
  check('compare', text.includes('| reopenMs | 200 | 100 | -100 | faster |') && text.includes('| dkgMs | 100 | 200 | 100 | slower |') && text.includes('| alpha | 200 | 100 | -100 | faster |') && text.includes('| alpha | 0.8 | 0.5 | -0.3 | faster |'))
  const sd = fresh('samples')
  wr(join(sd, 'a.samples'), '# h\n0 0 1000000 1000000 0 0 0 100\n5000 0 1000000 1000000 0 0 0 200\n')
  wr(join(sd, 'b.samples'), '# h\n0 0 1000000 1000000 0 0 0 50\n5000 0 1000000 1000000 0 0 0 75\n')
  const bg = dispatch(['budget', sd, '--ncpu', '8', '--totalmem', '8589934592'])
  check('budget', bg.out[0]?.includes('files=2 peakRssMB=275') && bg.out[0]?.includes('peakCores=0.80'))
  const pf = put('p.json', JSON.stringify({ timeDeltas: [1000000, 2000000, 3000000] })), sf = put('s.txt', '# h\n20000 0 0 0 0 0 0 100\n')
  const sp = dispatch(['span', pf, sf, '--spawn-ms', '13000'])
  check('span', sp.out[0] === 'SPAN profileS=6.0 samplesS=20.0 startWallMs=14000 spawnDiffMs=1000')
  const secret = randomBytes(24).toString('hex'), pid = '12D3KooW' + Array.from(randomBytes(44), (b) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58]).join('')
  const sc = fresh('scan')
  wr(join(sc, 'relay.env'), `RELAY_MULTIADDR=/ip4/127.0.0.1/tcp/4001\nPEER_ID=${secret}\nLAN_IP=192.0.2.1\n`)
  wr(join(sc, 'evidence.md'), `line one\nplanted ${secret.slice(8, 24)} here\npeer ${pid}\n`)
  mkdirSync(join(sc, 'state'))
  const scn = dispatch(['scan-evidence', join(sc, 'evidence.md'), join(sc, 'relay.env'), join(sc, 'state')])
  check('scan-window', scn.code === 1 && scn.out.some((l) => l.includes('kind=window')))
  check('scan-peer', scn.out.some((l) => l.includes('kind=peer-id')))
  check('scan-no-leak', !scn.out.join('\n').includes(secret))
  const cl = fresh('clean')
  wr(join(cl, 'relay.env'), 'RELAY_MULTIADDR=/ip4/127.0.0.1/tcp/4001\nPEER_ID=peer-abc\nLAN_IP=192.0.2.1\n')
  wr(join(cl, 'evidence.md'), 'nothing to see here\n')
  mkdirSync(join(cl, 'state'))
  const cln = dispatch(['scan-evidence', join(cl, 'evidence.md'), join(cl, 'relay.env'), join(cl, 'state')])
  check('scan-clean', cln.code === 0 && cln.out[0] === 'EVIDENCE-SCAN secrets=3 hits=0')
  check('usage', dispatch([]).code === 2)
  const failed = checks.find((c) => !c[1])
  return failed ? neg([`CLI06-EVIDENCE SELFTEST FAIL ${failed[0]}`]) : ok([`CLI06-EVIDENCE SELFTEST PASS ${checks.length}/${checks.length}`])
}

function dispatch (argv) {
  switch (argv[0]) {
    case 'quiet': return cmdQuiet(argv)
    case 'windows': return cmdWindows(argv)
    case 'steps': return cmdSteps(argv)
    case 'compare': return cmdCompare(argv)
    case 'budget': return cmdBudget(argv)
    case 'span': return cmdSpan(argv)
    case 'scan-evidence': return cmdScan(argv)
    case 'selftest': {
      const dir = mkdtempSync(join(tmpdir(), 'cli06-'))
      let result
      try { result = runCases(dir) } catch { result = neg(['CLI06-EVIDENCE SELFTEST FAIL setup']) }
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      return result
    }
    default: return usage()
  }
}

const result = dispatch(process.argv.slice(2))
if (result.out.length > 0) console.log(result.out.join('\n'))
process.exitCode = result.code
