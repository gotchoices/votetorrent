// vt — command-line front end. `vt daemon start` launches a device; every other command is sent to
// that device's daemon. Results print as JSON on stdout; a failure prints `{ error }` on stderr and
// exits 1. `--json` prints the whole reply, including the daemon-side duration in ms.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRpc, readDaemonInfo } from './rpc.mjs'

const SRC = dirname(fileURLToPath(import.meta.url))

/** [words, rpc method, positional parameter, role, summary] */
const COMMANDS = [
  [['daemon', 'start'], null, null, 'any', 'start a device: --role authority|voter --name NAME [--profile storage|transaction] [--listen MA] [--bootstrap MA]'],
  [['daemon', 'stop'], 'daemon.stop', null, 'any', 'stop the device daemon'],
  [['status'], 'status', null, 'any', 'device identity, peer id, addresses, networks'],
  [['network', 'show'], 'network.show', null, 'any', 'the current network\'s details'],
  [['network', 'join'], 'network.join', 'code', 'any', 'join a network from a vtjoin1./vtjoin2. code'],
  [['network', 'create'], 'network.create', null, 'authority', 'found a network: --name N [--authority-name A] [--domain D] [--title T] [--relay MA]'],
  [['network', 'revise'], 'network.revise', null, 'authority', 'propose and apply a network revision: [--name N] [--relay MA] [--no-apply]'],
  [['network', 'join-code'], 'network.join-code', null, 'authority', 'mint a voter/officer join code: [--uses 1000] [--days 30]'],
  [['officer', 'invite'], 'officer.invite', null, 'authority', 'invite an officer: --name N [--title T] [--scopes a,b]'],
  [['invite', 'accept'], 'invite.accept', 'share', 'authority', 'accept an invitation share: [--type of|au|k] [--decline]'],
  [['admin', 'show'], 'admin.show', null, 'authority', 'officers, scopes, thresholds, pending invites'],
  [['admin', 'set-scopes'], 'admin.set-scopes', null, 'authority', 'propose an administration change: [--user ID] --scopes a,b [--title T]'],
  [['intake-key', 'register'], 'intake-key.register', null, 'authority', 'register this officer\'s intake encryption key'],
  [['election', 'create'], 'election.create', null, 'authority', 'create an election: --title T [--voting-starts +5m] [--voting-minutes N] [--step-seconds S] [--registration-ends +4m] [--ballots-final +4m] [--threshold K] [--keyholders a,b]'],
  [['election', 'list'], 'election.list', null, 'any', 'elections on the network'],
  [['election', 'show'], 'election.show', null, 'any', 'election details, timeline and lifecycle state: [--election ID]'],
  [['election', 'results'], 'election.results', null, 'authority', 'CLI-only: reconstruct the key, open the vote blocks, tally'],
  [['ballot', 'propose'], 'ballot.propose', null, 'authority', 'propose a ballot: --question "code|Title|opt1,opt2[|voteFor]" ... [--description D]'],
  [['ballot', 'submit'], 'ballot.submit', null, 'authority', 'submit a ballot for confirmation: --ballot ID'],
  [['ballot', 'confirm'], 'ballot.confirm', null, 'authority', 'submit and sign the ballot task: --ballot ID'],
  [['ballot', 'show'], 'ballot.show', null, 'voter', 'the confirmed ballots: [--include-proposed]'],
  [['tasks', 'list'], 'tasks.list', null, 'authority', 'pending signature and key-release tasks'],
  [['tasks', 'sign'], 'tasks.sign', null, 'authority', 'sign a task: --ballot ID | --request ID | --nonce N [--reject]'],
  [['registration', 'field-add'], 'registration.field-add', null, 'authority', 'add a registration field: --field F [--tier public|private|selective] [--requirement required|optional]'],
  [['registration', 'sync'], 'registration.sync', null, 'authority', 'intake staged registration/association requests and attestations (Sync Now)'],
  [['registration', 'list'], 'registration.list', null, 'authority', 'registration requests: [--status p|a|r]'],
  [['registration', 'approve'], 'registration.approve', null, 'authority', 'approve a request: --request ID [--checklist id,roll,eligibility]'],
  [['registration', 'reject'], 'registration.reject', null, 'authority', 'reject a request: --request ID [--reason R]'],
  [['registration', 'status'], 'registration.status', null, 'voter', 'this voter\'s registration state: [--wait] [--timeout S]'],
  [['registrants', 'list'], 'registrants.list', null, 'authority', 'registrants and their device associations'],
  [['keyholder', 'invite'], 'keyholder.invite', null, 'authority', 'invite a keyholder: --name N [--hours 24]'],
  [['keyholder', 'accept'], 'keyholder.accept', 'share', 'authority', 'accept a keyholder invitation share'],
  [['keyholder', 'status'], 'keyholder.status', null, 'authority', 'DKG status and election key'],
  [['keyholder', 'dkg'], 'keyholder.dkg', null, 'authority', 'advance the DKG one step, or [--until-done] [--timeout S]'],
  [['keys', 'release'], 'keys.release', null, 'authority', 'release this keyholder\'s key share (after releasingKeys)'],
  [['register'], 'register', null, 'voter', 'register and associate this device: --first F --last L [--email E] [--party P] [--no-wait] [--timeout S]'],
  [['vote', 'cast'], 'vote.cast', null, 'voter', 'sign and save a vote: --select question=option[,option] ... [--replace]'],
  [['vote', 'receipt'], 'vote.receipt', null, 'voter', 'open the saved vote record'],
  [['vote', 'send'], 'vote.send', null, 'voter', 'send the saved vote through a pool: [--timeout S]']
]

function camel (s) {
  return s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
}

/** argv -> { words, flags }. `--x v` sets x, a bare `--x` is true, `--no-x` is false, repeats collect. */
function parseArgs (argv) {
  const words = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { words.push(a); continue }
    let key = a.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq) } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { value = argv[++i] } else if (key.startsWith('no-')) { key = key.slice(3); value = false } else { value = true }
    const k = camel(key)
    flags[k] = flags[k] === undefined ? value : [].concat(flags[k], value)
  }
  return { words, flags }
}

function usage () {
  const lines = COMMANDS.map(([w, , pos, role, summary]) => `  vt ${[...w, ...(pos ? [`<${pos}>`] : [])].join(' ').padEnd(30)} ${role.padEnd(9)} ${summary}`)
  return [
    'vt — run VoteTorrent Authority and Voter app workflows from Node (no React Native, no Hermes)',
    '',
    'usage: vt [--home DIR] <command> [args] [--json]      (DIR defaults to $VT_HOME or ./.vt/default)',
    '',
    ...lines,
    ''
  ].join('\n')
}

function out (value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function waitFor (predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = predicate()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function startDaemon (home, flags) {
  const existing = readDaemonInfo(home)
  if (existing && alive(existing.pid)) return { alreadyRunning: true, ...existing }
  const role = flags.role
  if (role !== 'authority' && role !== 'voter') throw Object.assign(new Error('--role authority|voter is required'), { code: 'invalid-argument' })
  mkdirSync(home, { recursive: true })
  const opts = {
    home,
    role,
    name: flags.name ?? (role === 'authority' ? 'Officer' : 'Voter'),
    profile: flags.profile ?? (role === 'authority' ? 'storage' : 'transaction'),
    ...(flags.listen ? { listen: [].concat(flags.listen) } : {}),
    ...(flags.bootstrap ? { bootstrap: [].concat(flags.bootstrap) } : {})
  }
  const logFd = openSync(join(home, 'daemon.out'), 'a')
  const child = spawn(process.execPath, [join(SRC, 'daemon.mjs'), JSON.stringify(opts)], { detached: true, stdio: ['ignore', logFd, logFd], cwd: home })
  child.unref()
  const info = await waitFor(() => {
    if (!alive(child.pid)) {
      const tail = existsSync(join(home, 'daemon.out')) ? readFileSync(join(home, 'daemon.out'), 'utf8').split('\n').slice(-20).join('\n') : ''
      throw new Error(`daemon exited during start:\n${tail}`)
    }
    const d = readDaemonInfo(home)
    return d && d.pid === child.pid ? d : undefined
  }, 120_000, 'the daemon to start')
  return info
}

async function main () {
  const { words, flags } = parseArgs(process.argv.slice(2))
  if (words.length === 0 || flags.help === true || words[0] === 'help') {
    process.stdout.write(usage())
    return
  }
  const home = resolve(flags.home ?? process.env.VT_HOME ?? join(process.cwd(), '.vt', 'default'))
  delete flags.home
  const json = flags.json === true
  delete flags.json
  const match = COMMANDS.find(([w]) => w.every((x, i) => words[i] === x))
  if (!match) throw Object.assign(new Error(`unknown command: ${words.join(' ')} (vt help)`), { code: 'unknown-command' })
  const [w, method, positional] = match
  const rest = words.slice(w.length)
  if (positional && rest.length > 0) flags[positional] = rest.join(' ')
  if (method === null) {
    const started = performance.now()
    const info = await startDaemon(home, flags)
    out(json ? { ok: true, result: info, ms: Math.round(performance.now() - started) } : info)
    return
  }
  const info = readDaemonInfo(home)
  if (!info || !alive(info.pid)) throw Object.assign(new Error(`no device daemon running in ${home} (vt daemon start --role …)`), { code: 'no-daemon' })
  const reply = await callRpc(info.port, method, flags)
  if (json) out(reply)
  else if (reply.ok) out(reply.result)
  if (!reply.ok) {
    if (!json) process.stderr.write(`${JSON.stringify({ error: reply.error }, null, 2)}\n`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  process.stderr.write(`${JSON.stringify({ error: { name: e.name, code: e.code, message: e.message } }, null, 2)}\n`)
  process.exitCode = 1
})
