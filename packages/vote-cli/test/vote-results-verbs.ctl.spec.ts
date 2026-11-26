// vote-results-verbs.ctl.spec.ts (67-30 Task 4): ONE host-only election through the ctl endpoint of SIX real
// daemons (officer in token posture, kh-a, kh-b, v1, v2, v3) on the loopback relay, on the DEFAULT 600 000 /
// 480 000 timeline: three voters cast and pool one block, the officer proves the ciphertext-only state before
// the release, the keyholders release, the officer confirms releasedCount, tallies against the voters' choice
// files, publishes once, and every peer reads identical results. Gated by VT_HOST_TIER=1 AND VT_VOTE_ELECTION=1
// (about 25 minutes). Nothing here prints a token, a choice, a nonce, a share, a needle, a multiaddr or a
// full peer id; the last case opens each voter's saved record itself and scans every peer dir and log for them.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createApprovalContext } from '../src/approval/token.js'
import { assertFreshBuild } from '../src/engine.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { openDeviceKeys } from '../src/vault/device-keys.js'
import { openFileKv } from '../src/vault/file-kv.js'
import { CLI_VOTE_PROMPT, createCliVoteRecordPorts, createRedactingVoteSendDebug } from '../src/voter/vote-record-seams.js'
import { relayPeerIdOf } from '../src/node/relay-readiness.js'
import { hostTierEnabled } from './support/host-tier.js'
import { ELECTION_STEPS, KEYHOLDER_LABELS, randomParty, RIG_LABELS, startVoteElectionRig, VERB_MS_FILE, VOTER_LABELS, type RigLabel, type VoteElectionRig, type VotingElectionSetup } from './support/vote-election-rig.js'

export const VOTE_ELECTION_ENV = 'VT_VOTE_ELECTION'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const CAST_KEYS = ['ballots', 'castMs', 'castUnwraps', 'choiceFile', 'electionId', 'electionRevision', 'ms', 'replacedStale', 'revealMs', 'savedAt', 'tokenReads']
/** The reply fields compared across every peer (the daemon's agreementSha256 covers AGREEMENT_FIELDS). */
const COMPARED_RESULT_KEYS = ['electionId', 'revision', 'status', 'blockCount', 'valid', 'invalid', 'excluded', 'counts', 'tallyRoot8', 'blockRoot8', 'publication', 'openedCount', 'agreementSha256']

describe('vote and results verbs over ctl', function () {
  this.timeout(3_600_000)
  let rig: VoteElectionRig
  let E: VotingElectionSetup
  let failed = false
  const choiceFiles: Record<string, string> = {}
  const wall: Array<[string, number]> = []
  const O = ELECTION_STEPS.officer
  const K = ELECTION_STEPS.keyholder
  const V = ELECTION_STEPS.voter

  const timed = async <T>(title: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now()
    try {
      return await fn()
    } finally {
      wall.push([title, Date.now() - t0])
    }
  }
  const net = (): Record<string, unknown> => ({ network: E.networkHash, election: E.electionId })
  const expectRefusal = (e: { name: string, code?: string, message?: string }, code: string | RegExp, what: string): void => {
    expect(e.name, `${what}: ${e.name} ${String(e.code)} ${String(e.message)}`).to.be.oneOf(['VerbRefusal', 'ApprovalRefusal'])
    if (typeof code === 'string') expect(e.code, `${what}: ${String(e.message)}`).to.equal(code)
    else expect(String(e.code), what).to.match(code)
    expect(String(e.message ?? '').length).to.be.at.most(200)
  }

  before(async function () {
    this.timeout(1_800_000)
    if (!hostTierEnabled() || process.env[VOTE_ELECTION_ENV] !== '1') this.skip()
    assertFreshBuild()
    rig = await startVoteElectionRig({ party: randomParty('vt30') })
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (rig === undefined) return
    for (const [title, ms] of wall) console.log(`      WALL ${title} ${ms}`)
    for (const s of rig.steps) console.log(`      STEP-RECORD ${s.name} ${s.endMs - s.startMs}`)
    await rig.close({ keep: failed })
  })

  it('sets up an election with three associated voters', async () => {
    await timed('setup', async () => {
      E = await rig.setupVotingElection()
      expect(E.networkHash).to.match(/^[0-9a-f]{32}$/)
      expect(E.electionId).to.match(/^election-\d+$/)
      expect(Object.keys(E.registrantIds).sort()).to.deep.equal([...VOTER_LABELS].sort())
      expect(E.votingStartsAt).to.be.greaterThan(Date.now())
      for (const label of RIG_LABELS) {
        const rb = await rig.ok(label, O.readback.verb)
        console.log(`      RSS ${label}=${String(rb.rssMb)}MB`)
        expect(Number(rb.rssMb)).to.be.lessThan(700)
      }
    })
  })

  it('cast refuses before voting opens, and results on v1 refuses results-awaiting-keys', async () => {
    await timed('pre-open-refusals', async () => {
      expect(Date.now()).to.be.lessThan(E.votingStartsAt)
      const e = await rig.refused('v1', V.cast.verb, { ...net(), [V.cast.args.tokenFile]: rig.tokens.v1 })
      expectRefusal(e, /^ineligible:/, 'cast before open')
      const r = await rig.refused('v1', V.results.verb, net())
      expectRefusal(r, 'results-awaiting-keys', 'results before release')
    })
  })

  it('cast refuses without a token and with a wrong token, saving nothing', async () => {
    await timed('cast-token-refusals', async () => {
      expectRefusal(await rig.refused('v1', V.cast.verb, net()), 'token-absent', 'cast no token')
      expectRefusal(await rig.refused('v1', V.cast.verb, { ...net(), [V.cast.args.tokenFile]: rig.tokens.wrong }), /^(sign:|ineligible:)/, 'cast wrong token')
      // nothing saved: a send finds no saved vote (the marker read costs no token)
      expectRefusal(await rig.refused('v1', V.send.verb, { ...net(), [V.send.args.tokenFile]: rig.tokens.v1 }), 'no-saved-vote', 'send before cast')
    })
  })

  it('release-window refuses before the window opens', async () => {
    await timed('release-window-early', async () => {
      const e = await rig.refused('officer', O.releaseWindow.verb, { ...net(), [O.releaseWindow.args.waitMs]: '0' })
      expectRefusal(e, 'window-not-open', 'release-window early')
      expectRefusal(await rig.refused('officer', O.releaseWindow.verb, { ...net(), tokenFile: rig.tokens.officer }), 'bad-arg', 'release-window token key')
    })
  })

  it('tally refuses before the key release', async () => {
    await timed('tally-early', async () => {
      const e = await rig.refused('officer', O.tally.verb, { ...net(), [O.tally.args.tokenFile]: rig.tokens.officer })
      expectRefusal(e, 'results-awaiting-keys', 'tally early')
      expectRefusal(await rig.refused('officer', O.tally.verb, net()), 'token-absent', 'tally no token')
    })
  })

  it('every voter casts after voting opens', async () => {
    await timed('cast', async () => {
      const wait = E.votingStartsAt + 2000 - Date.now()
      if (wait > 0) await rig.step('wait-voting-open', () => sleep(wait))
      // with voting open the eligibility check passes, so a wrong token reaches the signer and is refused there
      // (case 3 runs before the open, where eligibility refuses first); v1's cast below shows nothing was saved
      expectRefusal(await rig.refused('v1', V.cast.verb, { ...net(), [V.cast.args.tokenFile]: rig.tokens.wrong }), /^sign:/, 'cast wrong token after open')
      const choices: Record<string, string> = { v1: '0', v2: '1', v3: '0' }
      for (const v of VOTER_LABELS) {
        const r = await rig.step(`cast-${v}`, () => rig.ok(v, V.cast.verb, { ...net(), [V.cast.args.choiceIndex]: choices[v]!, [V.cast.args.tokenFile]: rig.tokens[v] }, { timeoutMs: 600_000 }))
        expect(Object.keys(r).sort()).to.deep.equal(CAST_KEYS)
        expect(r.electionId).to.equal(E.electionId)
        expect(r.castUnwraps).to.equal(1)
        expect(r.tokenReads).to.equal(3)
        const file = String(r.choiceFile)
        expect(file.startsWith(join(rig.peerDir(v), 'secrets') + '/')).to.equal(true)
        expect(statSync(file).mode & 0o777).to.equal(0o600)
        // whole text only: its 16-char windows are the public ballot id (it embeds the election id) and codes
        rig.registry.add(readFileSync(file, 'utf8').trim())
        choiceFiles[v] = file
        console.log(`      cast ${v} ms=${String(r.ms)} castMs=${String(r.castMs)} revealMs=${String(r.revealMs)}`)
      }
      expectRefusal(await rig.refused('v1', V.cast.verb, { ...net(), [V.cast.args.tokenFile]: rig.tokens.v1 }), 'choice-file-exists', 'second cast')
    })
  })

  it('the three voters pool and send one block', async () => {
    await timed('send', async () => {
      const replies = await rig.step('send-all', () => Promise.all(VOTER_LABELS.map((v) => rig.ok(v, V.send.verb, { ...net(), [V.send.args.tokenFile]: rig.tokens[v] }, { timeoutMs: 900_000 }))))
      for (const [i, r] of replies.entries()) {
        const ballots = r.ballots as Array<{ ballotId: string, phase: string, reason?: string }>
        expect(Number(r.committed), `${VOTER_LABELS[i]} ${JSON.stringify(ballots)}`).to.be.at.least(1)
        expect(ballots.every((b) => b.phase === 'sent')).to.equal(true)
        console.log(`      send ${VOTER_LABELS[i]} sendMs=${String(r.sendMs)} ms=${String(r.ms)} sendUnwraps=${String(r.sendUnwraps)} tokenReads=${String(r.tokenReads)}`)
      }
    })
  })

  it('release-window waits for the window and proves the ciphertext-only state', async () => {
    await timed('release-window-wait', async () => {
      const waitMs = Math.max(0, E.releasingKeysAt - Date.now()) + 60_000
      const r = await rig.ok('officer', O.releaseWindow.verb, { ...net(), [O.releaseWindow.args.waitMs]: String(waitMs), [O.releaseWindow.args.needleFile]: E.needleFile }, { timeoutMs: waitMs + 300_000 })
      const pre = r.preRelease as Record<string, unknown> | null
      expect(pre, 'preRelease').to.not.equal(null)
      expect(pre!.checked).to.equal(true)
      expect(Number(pre!.blocks)).to.be.at.least(1)
      expect(pre!.notReconstructable).to.equal(pre!.blocks)
      expect(pre!.needlesChecked).to.equal(pre!.blocks)
      expect(pre!.needleFound).to.equal(false)
      expect(r.phase).to.not.equal('reconstructable')
      console.log(`      release-window waitedMs=${String(r.waitedMs)} phase=${String(r.phase)} blocks=${String(pre!.blocks)} ms=${String(r.ms)}`)
    })
  })

  it('the keyholders release and the officer confirms releasedCount', async () => {
    await timed('release', async () => {
      for (const kh of KEYHOLDER_LABELS) {
        const r = await rig.step(`release-${kh}`, () => rig.ok(kh, K.release.verb, { ...net(), [K.release.args.tokenFile]: rig.tokens[kh] }, { timeoutMs: 600_000 }))
        console.log(`      release ${kh} ms=${String(r.ms)} releasedCount=${String(r[K.release.reply.releasedCount])}`)
      }
      const r = await rig.step('release-window-await', () => rig.ok('officer', O.releaseWindow.verb, { ...net(), [O.releaseWindow.args.awaitReleased]: '2' }, { timeoutMs: 600_000 }))
      expect(Number(r.releasedCount)).to.be.at.least(2)
      expect(r.rejected).to.equal(0)
      expect(r.phase).to.equal('reconstructable')
      console.log(`      release-window(await) releasedCount=${String(r.releasedCount)} statusReads=${String(r.statusReads)} ms=${String(r.ms)}`)
    })
  })

  it('tally opens every block and matches the voters choice files', async () => {
    await timed('tally', async () => {
      const files = VOTER_LABELS.map((v) => choiceFiles[v]!).join(',')
      const r = await rig.step('tally', () => rig.ok('officer', O.tally.verb, { ...net(), [O.tally.args.expectedFiles]: files, [O.tally.args.needleFile]: E.needleFile, [O.tally.args.tokenFile]: rig.tokens.officer }, { timeoutMs: 600_000 }))
      expect(r.status).to.equal('tallied')
      expect(r.valid).to.equal(3)
      expect(r.invalid).to.equal(0)
      expect(r.excluded).to.equal(0)
      expect(r.openedCount).to.equal(3)
      expect(r.expectedMatch).to.equal(true)
      expect(r.needleInOpened).to.equal(true)
      expect(r.counts).to.deep.equal([1, 2])
      expect(r.signatures).to.equal(0)
      console.log(`      tally tallyMs=${String(r.tallyMs)} decryptMs=${String(r.decryptMs)} ms=${String(r.ms)} blockCount=${String(r.blockCount)}`)
    })
  })

  it('publish signs once and a second publish is already-published', async () => {
    await timed('publish', async () => {
      const first = await rig.step('publish', () => rig.ok('officer', O.publish.verb, { ...net(), [O.publish.args.tokenFile]: rig.tokens.officer }, { timeoutMs: 600_000 }))
      expect(first.outcome).to.equal('published')
      expect(first.signatures).to.equal(1)
      expect(first.rows).to.equal(1)
      console.log(`      publish publishMs=${String(first.publishMs)} ms=${String(first.ms)}`)
      const again = await rig.ok('officer', O.publish.verb, { ...net(), [O.publish.args.tokenFile]: rig.tokens.officer }, { timeoutMs: 600_000 })
      expect(again.outcome).to.equal('already-published')
      expect(again.rows).to.equal(1)
      // the engine returns already-published before it signs, so the two publishes made one signature
      expect(again.signatures).to.equal(0)
    })
  })

  it('results agree on every peer', async () => {
    await timed('results', async () => {
      const files = VOTER_LABELS.map((v) => choiceFiles[v]!).join(',')
      const replies = new Map<RigLabel, Record<string, unknown>>()
      for (const label of RIG_LABELS) {
        const r = await rig.step(`results-${label}`, () => rig.ok(label, O.results.verb, { ...net(), [O.results.args.requirePublished]: true, [O.results.args.waitMs]: '120000', [O.results.args.expectedFiles]: files }, { timeoutMs: 600_000 }))
        replies.set(label, r)
        console.log(`      results ${label} ms=${String(r.ms)} polls=${String(r.polls)} waitedMs=${String(r.waitedMs)} valid=${String(r.valid)} sha8=${String(r.agreementSha256).slice(0, 8)}`)
      }
      const officer = replies.get('officer')!
      expect(officer.valid).to.equal(3)
      expect(officer.expectedMatch).to.equal(true)
      const pub = officer.publication as Record<string, boolean>
      expect(pub.found && pub.signatureValid && pub.treeOk && pub.matchesRecomputed).to.equal(true)
      for (const [label, r] of replies) {
        for (const key of COMPARED_RESULT_KEYS) {
          expect(JSON.stringify(r[key]), `${label}.${key} differs from the officer`).to.equal(JSON.stringify(officer[key]))
        }
        expect(r.valid, label).to.equal(3)
        const p = r.publication as Record<string, boolean>
        expect(p.signatureValid && p.treeOk && p.matchesRecomputed, `${label} publication`).to.equal(true)
      }
      expect(new Set([...replies.values()].map((r) => String(r.agreementSha256))).size).to.equal(1)
    })
  })

  it('results refuses a wrong election id', async () => {
    await timed('results-mismatch', async () => {
      for (const label of ['officer', 'v1'] as const) {
        const e = await rig.refused(label, O.results.verb, { network: E.networkHash, election: 'election-1000000000000' })
        expectRefusal(e, 'election-mismatch', `results mismatch ${label}`)
      }
    })
  })

  it('no plaintext, nonce, share, token, signature or K_vote reaches a log, reply or results', async () => {
    await timed('secret-scan', async () => {
      const reg = new SecretRegistry()
      // Each value keeps the rig's own windowing. The relay address and peer id are left out of THIS registry
      // only: every node stores its dial address in node/ by design. scanOutputs below still holds them, so
      // they may not appear in a log, a reply or a top-level peer record.
      const relayValues = new Set([rig.relay.multiaddr, relayPeerIdOf(rig.relay.multiaddr)])
      for (const [value, windowed] of rig.registry.entries()) if (!relayValues.has(value)) reg.add(value, { windows: windowed })
      for (const label of RIG_LABELS) {
        const tokenText = readFileSync(rig.tokens[label], 'utf8').trim()
        reg.add(Buffer.from(tokenText, 'base64url').toString('hex'), { windows: true })
      }
      reg.add(readFileSync(E.needleFile, 'utf8').trim(), { windows: true })
      for (const v of VOTER_LABELS) {
        const choiceText = readFileSync(choiceFiles[v]!, 'utf8').trim()
        reg.add(choiceText)
        for (const ballot of JSON.parse(choiceText) as Array<{ answers: unknown }>) reg.add(`"answers":${JSON.stringify(ballot.answers)}`)
        const kv = openFileKv({ path: join(rig.peerDir(v), 'node', 'async-storage.json') })
        const keys = openDeviceKeys(join(rig.peerDir(v), 'vault'))
        try {
          const ports = createCliVoteRecordPorts({ kv, keys, approval: createApprovalContext({ file: rig.tokens[v] }), debug: createRedactingVoteSendDebug({ redact: (t) => t }, () => undefined) })
          const load = await ports.receipt.loadVoteReceipt(E.electionId, null)
          expect(load.kind, `${v} saved vote`).to.equal('saved')
          const reveal = await ports.receipt.revealVoteReceipt(E.electionId, load.kind === 'saved' ? load.envelope : (undefined as never), CLI_VOTE_PROMPT)
          expect(reveal.kind, `${v} reveal`).to.equal('ok')
          if (reveal.kind === 'ok') {
            for (const vote of reveal.record.votes) reg.add(vote.nonce, { windows: true })
            reg.add(reveal.record.voter.signature, { windows: true })
          }
        } finally {
          kv.close()
          keys.dispose()
        }
      }
      // the published key shares are public protocol data (D-17) and the seat share text's public invite key is
      // replicated; the strand replica (node/store) and secrets/ are therefore outside this scan (67-26/67-28
      // scope), as is each live daemon's own ctl.token file (any copy of that token elsewhere is a hit)
      const scan = rig.scanPeersAndLogs(reg)
      console.log(`      scan files=${scan.files} whole=${scan.whole} windows=${scan.windows} registered=${reg.size}`)
      expect(scan.files).to.be.above(0)
      expect(scan.whole).to.equal(0)
      expect(scan.windows).to.equal(0)
      const outputs = rig.scanOutputs()
      console.log(`      outputs files=${outputs.files} whole=${outputs.whole} windows=${outputs.windows}`)
      expect(outputs.whole).to.equal(0)
      expect(outputs.windows).to.equal(0)
      const text = rig.captured.join('\n')
      expect(text).to.not.include('/p2p/')
      expect(text).to.not.include('"nonce"')
      expect(text).to.not.include('"optionCodes"')
      const lines = readFileSync(VERB_MS_FILE, 'utf8')
      for (const v of ['voter:cast', 'voter:send', 'voter:results', 'officer:release-window', 'officer:tally', 'officer:publish', 'officer:results', 'keyholder:results']) {
        expect(lines, v).to.match(new RegExp(`^VERB-MS ${v} \\d+ \\d+$`, 'm'))
      }
      expect(/[0-9a-f]{32,}/.test(lines)).to.equal(false)
    })
  })
})
