// Renders the e2e results as Markdown: summary, per-test timings, every step with its wall and
// daemon-side time, per-command timing statistics, and what the CLI substitutes for the phone.

const fmt = (ms) => (ms === null || ms === undefined ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const ICON = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP', waited: 'WAIT' }

function median (xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

/** "vt network join vtjoin2…" -> "network join" */
function commandKey (command) {
  const words = command.replace(/^vt /, '').split(' ')
  const two = ['daemon', 'network', 'officer', 'invite', 'admin', 'intake-key', 'election', 'ballot', 'tasks', 'registration', 'registrants', 'keyholder', 'keys', 'vote']
  return two.includes(words[0]) ? `${words[0]} ${words[1]}` : words[0]
}

export function renderReport (r) {
  const tests = r.tests.filter((t) => t.kind !== 'wait')
  const counted = tests.filter((t) => t.kind === 'test')
  const passed = counted.filter((t) => t.status === 'passed').length
  const failed = counted.filter((t) => t.status === 'failed').length
  const skipped = counted.filter((t) => t.status === 'skipped').length
  const waits = r.tests.filter((t) => t.kind === 'wait')
  const waitMs = waits.reduce((a, t) => a + t.durationMs, 0) + tests.reduce((a, t) => a + (t.waitMs ?? 0), 0)
  const steps = r.tests.flatMap((t) => t.steps.map((s) => ({ ...s, test: t.id })))
  const checks = r.tests.flatMap((t) => t.checks)
  const L = []

  L.push('# VoteTorrent CLI — end-to-end test report', '')
  L.push(`Run: ${r.ranAt} · total ${fmt(r.totalMs)} · branch \`${(r.git ?? '').replace('ref: refs/heads/', '')}\``)
  L.push(`Host: ${r.host.platform}, ${r.host.cpus} × ${r.host.cpuModel}, ${r.host.memGb} GB, Node ${r.host.node}`)
  L.push(`Timeline: voting opened ${r.config.votingStartsMin} min after the election was created and stayed open ${r.config.votingMin} min; later events ${r.config.stepSeconds} s apart.`, '')
  L.push(`**Result: ${passed}/${counted.length} tests passed**${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''} · ${checks.filter((c) => c.pass).length}/${checks.length} checks passed · ${steps.length} CLI invocations (${steps.filter((s) => s.ok).length} succeeded; some failures are expected refusals).`, '')
  L.push(`Of the ${fmt(r.totalMs)} total, ${fmt(waitMs)} was spent waiting for the election timeline (voting to open, the key-release window), not doing work.`, '')

  L.push('## Tests', '')
  L.push('| # | Test | App | Result | Duration | of which waiting on the timeline | Checks |', '|---|---|---|---|---:|---:|---|')
  for (const t of r.tests) {
    const ok = t.checks.filter((c) => c.pass).length
    const waited = t.kind === 'wait' ? t.durationMs : t.waitMs
    L.push(`| ${t.id} | ${esc(t.name)} | ${t.app} | ${ICON[t.status] ?? t.status} | ${fmt(t.durationMs)} | ${waited ? fmt(waited) : '—'} | ${t.checks.length ? `${ok}/${t.checks.length}` : '—'} |`)
  }
  L.push('')

  L.push('## Timing by command', '', 'Wall = the whole `vt` process (Node start, RPC, exit). Daemon = time inside the device daemon, i.e. the workflow itself.', '')
  L.push('| Command | Runs | Wall median | Daemon median | Daemon min | Daemon max |', '|---|---:|---:|---:|---:|---:|')
  const byKey = new Map()
  for (const s of steps) {
    const k = commandKey(s.command)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(s)
  }
  for (const [k, list] of [...byKey.entries()].sort()) {
    const d = list.map((s) => s.daemonMs).filter((x) => typeof x === 'number')
    L.push(`| \`${k}\` | ${list.length} | ${fmt(median(list.map((s) => s.wallMs)))} | ${fmt(median(d))} | ${fmt(d.length ? Math.min(...d) : null)} | ${fmt(d.length ? Math.max(...d) : null)} |`)
  }
  L.push('')

  L.push('## Test details', '')
  for (const t of r.tests) {
    if (t.kind === 'wait') continue
    L.push(`### ${t.id} — ${t.name}`, '', `Result: **${ICON[t.status] ?? t.status}** in ${fmt(t.durationMs)}${t.reason ? ` (${t.reason})` : ''}${t.error ? ` — error: ${esc(t.error)}` : ''}`, '')
    if (t.checks.length) {
      for (const c of t.checks) L.push(`- ${c.pass ? '✅' : '❌'} ${esc(c.name)}${c.detail ? ` — \`${esc(c.detail).slice(0, 300)}\`` : ''}`)
      L.push('')
    }
    if (t.steps.length) {
      L.push('| Device | Command | OK | Wall | Daemon |', '|---|---|---|---:|---:|')
      for (const s of t.steps) L.push(`| ${s.device} | \`${esc(s.command)}\` | ${s.ok ? 'yes' : `no: ${esc(s.error?.code ?? s.error?.name)}`} | ${fmt(s.wallMs)} | ${fmt(s.daemonMs)} |`)
      L.push('')
    }
  }

  L.push('## Reading the timings', '')
  L.push('- `daemon start` (~1.8 s) is one device booting: Node, the vote-engine build, a CadreNode with its control database.')
  L.push('- `network create` and `network join` include opening the network\'s strand (the 88-statement schema applied onto the Optimystic store) — the founder creates it, a joiner waits for the first sync and verifies the founding digest.')
  L.push('- `register` is the voter\'s whole ceremony and **includes waiting for the officer**: it returns only after the authority has imported the request, approved it and issued the challenge (the e2e officer loop syncs every ~3 s).')
  L.push('- `vote send` is dominated by the PoolAgent\'s default 20 s quiet period: a pool forms only after 20 s with no new member (the app\'s defaults, unchanged).')
  L.push('- `keyholder dkg --until-done` repeats the one-step-per-screen-focus DKG driver until the election key exists; both keyholders run it at the same time.')
  L.push('')

  L.push('## Findings', '')
  for (const o of r.observations ?? []) L.push(`- **Observed in this run (${o.test}):** ${esc(o.text)}`)
  L.push('- **Two keyholders accepting at the same moment can collide (intermittent).** In run 5 of the history, K2\'s `respondToInvite` committed for 22.7 s and failed `Multi-collection commit lost a stale race for [InviteResult, User, UserKey, Keyholder, KeyholderDkgBinding] — Pend failed for collection UserKey`. The engine does not retry, so the app would show the keyholder an error; tapping Accept again works. Until the second keyholder is seated the DKG stays `blocked`. The suite now retries a lost race and records each loss here.')
  L.push('- **A network revision that renames the network cannot be applied.** `NetworkEngine.proposeRevision` stores it, but `getDetails()` looks proposals up `where Name = <current name>`, so a proposal under a new name is never surfaced and Network Details has nothing to apply. T08 records this; relay and policy revisions under the current name work.')
  L.push('- Refusals the tests require: casting before voting opens (`window-closed`), a second cast (`already-saved`) and the rename proposal (`no-proposal`) are the failed CLI invocations counted above; the forged join code returns a `digest-mismatch` result rather than an error.')
  L.push('')

  if (Array.isArray(r.history) && r.history.length > 0) {
    L.push('## Run history', '', 'Every full run of this suite, oldest first. This report is the last row.', '')
    L.push('| # | Ran at | Passed | Total time | Notes |', '|---:|---|---|---:|---|')
    r.history.forEach((h, i) => L.push(`| ${i + 1} | ${h.ranAt} | ${h.passed ?? '—'}/${h.total} | ${fmt(h.totalMs)} | ${esc(h.note)} |`))
    L.push('')
  }

  L.push('## What the CLI substitutes for the phone', '')
  L.push('The workflows call the shipped `vote-engine` build (`dist/rn-entry.js`, the entry both apps import) and the same `@serfab/cadre-core` / Optimystic stack, on the patched dependency tree in `packages/vote-engine/node_modules`. Only the React Native seams are replaced:', '')
  L.push('| App seam | CLI stand-in | Consequence |', '|---|---|---|')
  L.push('| AsyncStorage | JSON file per device (`local.json`) | none for these workflows |')
  L.push('| Keystore/Secure Enclave keys | software secp256k1 identity key + software P-256 voting key | no hardware key protection, no biometric prompts |')
  L.push('| Play Integrity / key attestation | the dev stub attestation (nonce echo); the authority runs `StubAttestationVerifier` | **device attestation is not verified** — the app\'s dev-build mode |')
  L.push('| Hardware-wrapped `IKeyVault` | in-process memory vault | secrets are not wrapped |')
  L.push('| rn-leveldb strand + control storage | `MemoryRawStorage` | state lives as long as the daemon; a restart starts empty |')
  L.push('| WebSockets + circuit relay on phones | WebSockets on 127.0.0.1; the founding authority uses the `storage` profile (listens), everyone else `transaction` | no relay, no NAT; all peers on one host |')
  L.push('')
  L.push('`election results` is CLI-only: no app screen tallies votes yet (there is no Tally/Result table), so the CLI reconstructs the key from the released shares and opens the blocks to verify the votes end to end.', '')
  L.push(`Raw results: \`${r.runDir}/results.json\` (per-device daemon logs in the same directory).`, '')
  return L.join('\n')
}
