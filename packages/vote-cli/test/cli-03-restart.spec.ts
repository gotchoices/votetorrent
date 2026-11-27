// cli-03-restart.spec.ts: CLI-03, the restartable keyholder. Two describes:
//  - `cli-03 timeline` (offline, ungated): the 90/60 s experiment timeline and the 600/480 s default
//    both pass the Voter's timeline rules through 67-26's builder, with releasingKeys at
//    T + lead + window + 120 s.
//  - `cli-03 restart` (gated on VT_HOST_TIER=1 AND VT_CLI03=1): officer + kh-a + kh-b on the loopback
//    relay; both keyholders accept, stop and start cleanly, run the DKG from the persisted file vault
//    and sealed identity store, stop and start again, refuse a token-less and a wrong-token release at
//    the first unwrap, then release from the persisted share; replays are no-ops; the released share,
//    the seat shares, the invite keys, the tokens and the token-derived KEK never reached any file or
//    output. VT_CLI03_TIMELINE=short runs the 90/60 s experiment ONCE and is recorded; the committed
//    default stays 600000 / 480000.
// Nothing here prints a token, a share, a key, a code, a multiaddr or a full peer id.

import { expect } from 'chai'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { keyholderDkgReceivingKeyAlias, keyholderDkgShareAlias } from '@votetorrent/vote-engine/rn'
import { keyholderSigningKeyAlias, listKeyholderIdentities } from '@votetorrent/workflows/authority'
import { createApprovalContext } from '../src/approval/token.js'
import { DEFAULT_LEAD_MS, DEFAULT_WINDOW_MS, MIN_LEAD_MS, MIN_WINDOW_MS, buildCliTimeline, checkVoterTimelineRules } from '../src/election/parse-timeline.js'
import { assertFreshBuild } from '../src/engine.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { HKDF_INFO } from '../src/vault/device-keys.js'
import { openDeviceVault } from '../src/vault/device-vault.js'
import { hostTierEnabled } from './support/host-tier.js'
import { randomParty, startKeyholderRig, type ElectionSetup, type ErrorView, type KeyholderRig, type RestartResult, type RigLabel } from './support/keyholder-rig.js'

const NOW = 1_700_000_000_000
const RELEASING_KEYS_AFTER_ACCRUING_MS = 120_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('cli-03 timeline', () => {
  for (const [name, leadMs, windowMs] of [
    ['the 90/60 s experiment timeline passes the timeline rules', MIN_LEAD_MS, MIN_WINDOW_MS],
    ['the 600/480 s default timeline passes the timeline rules', DEFAULT_LEAD_MS, DEFAULT_WINDOW_MS]
  ] as const) {
    it(name, () => {
      const t = buildCliTimeline({ now: NOW, leadMs, windowMs })
      expect(t.T).to.equal(NOW)
      const conflicts = checkVoterTimelineRules({ timeline: t.timeline, date: t.date, ballotDeadline: t.ballotDeadline, now: NOW })
      expect(conflicts).to.deep.equal([])
      expect(t.timeline.releasingKeys - NOW).to.equal(leadMs + windowMs + RELEASING_KEYS_AFTER_ACCRUING_MS)
      // the committed default stays 600000 / 480000; 'short' (90000 / 60000) is the explicit, opt-in experiment
      expect(DEFAULT_LEAD_MS).to.equal(600000)
      expect(DEFAULT_WINDOW_MS).to.equal(480000)
    })
  }
})

type TimelineChoice = 'default' | 'short'

function unwrapsOf(e: ErrorView): number | undefined {
  const m = / unwraps=(\d+)$/.exec(e.message ?? '')
  return m === null ? undefined : Number(m[1])
}

function timelineChoice(): TimelineChoice {
  const v = process.env.VT_CLI03_TIMELINE
  if (v === undefined || v === '' || v === 'default') return 'default'
  if (v === 'short') return 'short'
  throw new Error(`VT_CLI03_TIMELINE must be default or short`)
}

describe('cli-03 restart', function () {
  const choice: TimelineChoice = process.env.VT_CLI03 === '1' ? timelineChoice() : 'default'
  const leadMs = choice === 'short' ? MIN_LEAD_MS : DEFAULT_LEAD_MS
  const windowMs = choice === 'short' ? MIN_WINDOW_MS : DEFAULT_WINDOW_MS
  this.timeout(choice === 'short' ? 1_500_000 : 3_000_000)
  let rig: KeyholderRig
  let E: ElectionSetup
  let failed = false

  before(async function () {
    this.timeout(600_000)
    if (!hostTierEnabled() || process.env.VT_CLI03 !== '1') this.skip()
    assertFreshBuild()
    rig = await startKeyholderRig({ party: randomParty('vt28r'), leadMs, windowMs })
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (rig !== undefined) await rig.close({ keep: failed })
  })

  const expectRefusal = (e: ErrorView, code: string, verb: string): void => {
    expect(e.name, `${verb}: ${e.name} ${String(e.code)} ${String(e.message)}`).to.equal('KeyholderVerbError')
    expect(e.code, `${verb}: ${String(e.message)}`).to.equal(code)
  }

  const expectCleanRestart = (r: RestartResult, label: string): void => {
    expect(r.killed, `${label} killed`).to.equal(false)
    expect(r.exitCode, `${label} exit`).to.equal(0)
    expect(r.peerId8After, `${label} peerId8`).to.equal(r.peerId8Before)
    expect(r.after.records, `${label} records`).to.deep.equal(r.before.records)
    expect(r.after.salt, `${label} salt`).to.equal(r.before.salt)
    expect(r.after.atRest, `${label} at-rest`).to.equal(r.before.atRest)
    expect(r.after.sealed, `${label} sealed store`).to.equal(r.before.sealed)
    expect(r.after.tokenCheck, `${label} token.check`).to.equal(r.before.tokenCheck)
    expect(r.before.sealed, `${label} sealed store present`).to.not.equal(null)
    console.log(`      restart ${label} stopMs=${r.stopMs} startMs=${r.startMs} records=${r.after.records.length}`)
  }

  it('accept, restart, DKG, restart, release passes host-only on the loopback relay', async () => {
    const t0 = Date.now()
    const unwraps: Record<string, number> = {}
    const restarts: Array<{ label: string, stopMs: number, startMs: number }> = []
    const kh = (label: RigLabel, verb: string, args: Record<string, unknown>, timeoutMs = 600_000) =>
      rig.ok(label, verb, { network: E.networkHash, election: E.electionId, tokenFile: rig.tokens[label], ...args }, { timeoutMs })
    const khRefused = (label: RigLabel, verb: string, args: Record<string, unknown>, timeoutMs = 600_000) =>
      rig.refused(label, verb, { network: E.networkHash, election: E.electionId, ...args }, { timeoutMs })

    // 1. the election
    E = await rig.step('setup-election', () => rig.setupElection())
    console.log(`      timeline=${choice} leadMs=${leadMs} windowMs=${windowMs} releaseIn=${Math.round((E.releasingKeysAt - Date.now()) / 1000)}s`)

    // 2. accept
    const userId8: Record<string, string> = {}
    for (const [label, idx] of [['kh-a', 0], ['kh-b', 1]] as const) {
      const r = await rig.step(`accept-${label.slice(-1)}`, () => rig.ok(label, 'accept', { network: E.networkHash, shareFile: E.seatFiles[idx], tokenFile: rig.tokens[label], waitMs: '180000' }, { timeoutMs: 300_000 }))
      expect(r.accepted).to.equal(true)
      userId8[label] = String(r.userId8)
      unwraps[`accept${label.slice(-1).toUpperCase()}`] = Number(r.acceptUnwraps)
    }
    expect(userId8['kh-a']).to.not.equal(userId8['kh-b'])

    // 3. restart 1, sequential
    for (const label of ['kh-a', 'kh-b'] as const) {
      const r = await rig.step(`restart1-${label.slice(-1)}`, () => rig.restartPeer(label))
      expectCleanRestart(r, label)
      restarts.push({ label, stopMs: r.stopMs, startMs: r.startMs })
    }

    // 4. a token-less drive after the restart: the token is not cached by the daemon
    const noTokenDkg = await rig.step('dkg-no-token-a', () => khRefused('kh-a', 'dkg', { boundMs: '120000' }))
    expectRefusal(noTokenDkg, 'auth-denied', 'dkg')

    // 5. the DKG from the persisted vault and identity store
    const [dkgA, dkgB] = await rig.step('dkg', () => Promise.all([kh('kh-a', 'dkg', {}, 1_000_000), kh('kh-b', 'dkg', {}, 1_000_000)]))
    for (const [r, label] of [[dkgA, 'kh-a'], [dkgB, 'kh-b']] as const) {
      expect(r.phase, label).to.equal('complete')
      expect(r.hasShare, label).to.equal(true)
      expect(r.threshold, label).to.equal(2)
      expect(r.participants, label).to.equal(2)
      expect(Number(r.dkgUnwraps), label).to.be.at.least(1)
      console.log(`      dkg ${label} drives=${String(r.drives)} advancing=${String(r.advancing)} actions=${String(r.actions)} attempt=${String(r.attempt)} ownMessages=${String(r.ownMessages)} dkgUnwraps=${String(r.dkgUnwraps)} ms=${String(r.ms)}`)
    }
    expect(dkgA.jointKeyTag).to.equal(dkgB.jointKeyTag)
    unwraps.dkgA = Number(dkgA.dkgUnwraps)
    unwraps.dkgB = Number(dkgB.dkgUnwraps)

    // 6. restart 2 (the records now hold the DKG share)
    for (const label of ['kh-a', 'kh-b'] as const) {
      const r = await rig.step(`restart2-${label.slice(-1)}`, () => rig.restartPeer(label))
      expectCleanRestart(r, label)
      restarts.push({ label, stopMs: r.stopMs, startMs: r.startMs })
    }

    // 7. a replayed drive is a no-op
    for (const [label, prev] of [['kh-a', dkgA], ['kh-b', dkgB]] as const) {
      const r = await rig.step(`dkg-replay-${label.slice(-1)}`, () => kh(label, 'dkg', {}, 300_000))
      expect(r.phase, label).to.equal('complete')
      expect(r.advancing, label).to.equal(0)
      expect(r.actions, label).to.equal(0)
      expect(r.dkgUnwraps, label).to.equal(0)
      expect(r.attempt, label).to.equal(prev.attempt)
      expect(r.ownMessages, label).to.equal(prev.ownMessages)
      expect(r.jointKeyTag, label).to.equal(prev.jointKeyTag)
      unwraps[`dkgReplay${label.slice(-1).toUpperCase()}`] = Number(r.dkgUnwraps)
    }

    // 8. the release window
    await rig.step('release-wait', async () => {
      const remaining = E.releasingKeysAt - Date.now()
      console.log(`      release window opens in ${Math.round(remaining / 1000)}s`)
      if (remaining > 30_000) {
        const early = await khRefused('kh-a', 'release', { tokenFile: rig.tokens['kh-a'], waitMs: '0' }, 300_000)
        expectRefusal(early, 'window-not-open', 'release')
        expect(unwrapsOf(early)).to.equal(0)
        unwraps.releaseEarlyA = unwrapsOf(early) ?? -1
      } else {
        console.log('      window-not-open check skipped: less than 30 s remained')
      }
      const wait = E.releasingKeysAt + 5_000 - Date.now()
      if (wait > 0) await sleep(wait)
    })

    // 9. a token-less and a wrong-token release refuse at the first unwrap
    const noToken = await rig.step('release-no-token-a', () => khRefused('kh-a', 'release', { waitMs: '0' }))
    expectRefusal(noToken, 'auth-denied', 'release')
    expect(unwrapsOf(noToken), String(noToken.message)).to.equal(1)
    unwraps.releaseNoTokenA = unwrapsOf(noToken) ?? -1
    const wrongToken = await rig.step('release-wrong-token-a', () => khRefused('kh-a', 'release', { tokenFile: rig.tokens.wrong, waitMs: '0' }))
    expectRefusal(wrongToken, 'auth-denied', 'release')

    // 10. both release from the persisted share
    const relA = await rig.step('release-a', () => kh('kh-a', 'release', { waitMs: '0' }))
    expect(relA.released).to.equal(true)
    expect(relA.alreadyReleased).to.equal(false)
    expect(Number(relA.releaseUnwraps)).to.be.at.least(1)
    unwraps.releaseA = Number(relA.releaseUnwraps)
    const relB = await rig.step('release-b', () => kh('kh-b', 'release', { waitMs: '0', awaitCount: '2' }))
    expect(relB.released).to.equal(true)
    expect(relB.alreadyReleased).to.equal(false)
    expect(Number(relB.releaseUnwraps)).to.be.at.least(1)
    expect(Number(relB.releasedCount)).to.be.at.least(2)
    expect(relB.rejected).to.equal(0)
    unwraps.releaseB = Number(relB.releaseUnwraps)
    console.log(`      release kh-a unwraps=${String(relA.releaseUnwraps)} ms=${String(relA.ms)}; kh-b unwraps=${String(relB.releaseUnwraps)} releasedCount=${String(relB.releasedCount)} rejected=${String(relB.rejected)} ms=${String(relB.ms)}`)

    // 11. a repeated release is idempotent and free
    const repeat = await rig.step('release-repeat-a', () => kh('kh-a', 'release', { waitMs: '0' }))
    expect(repeat.released).to.equal(true)
    expect(repeat.alreadyReleased).to.equal(true)
    expect(repeat.releaseUnwraps).to.equal(0)
    unwraps.releaseRepeatA = Number(repeat.releaseUnwraps)

    // 12. stop everything and inspect the vaults from this process
    const tokenKek = new SecretRegistry()
    const revisionSeen: Record<string, number> = {}
    await rig.step('close-and-inspect', async () => {
      for (const label of ['kh-a', 'kh-b', 'officer'] as const) {
        const s = await rig.stopPeer(label)
        expect(s.killed, `${label} killed`).to.equal(false)
        expect(s.exitCode, `${label} exit`).to.equal(0)
      }
      for (const label of ['kh-a', 'kh-b'] as const) {
        const tokenText = readFileSync(rig.tokens[label], 'utf8').trim()
        const tokenBytes = Buffer.from(tokenText, 'base64url')
        const dv = openDeviceVault({ home: rig.peerDir(label), approval: createApprovalContext({ file: rig.tokens[label] }) })
        try {
          const identities = await listKeyholderIdentities(dv.storage)
          expect(identities.length, `${label} identities`).to.equal(1)
          const identity = identities[0]!
          expect(identity.userId.startsWith(userId8[label]!), `${label} userId`).to.equal(true)
          expect(await dv.vault.hasSecret(keyholderSigningKeyAlias(identity.userId)), `${label} signing key`).to.equal(true)
          expect(await dv.vault.hasSecret(keyholderDkgReceivingKeyAlias(identity.userId)), `${label} receiving key`).to.equal(true)
          const held: number[] = []
          for (const revision of [0, 1, 2]) if (await dv.vault.hasSecret(keyholderDkgShareAlias(E.electionId, revision, identity.userId))) held.push(revision)
          expect(held.length, `${label} share aliases held`).to.equal(1)
          revisionSeen[label] = held[0]!
          const share = await dv.vault.getSecret(keyholderDkgShareAlias(E.electionId, held[0]!, identity.userId))
          expect(share, `${label} share`).to.not.equal(null)
          for (const form of [Buffer.from(share!).toString('hex'), Buffer.from(share!).toString('base64'), Buffer.from(share!).toString('base64url')]) rig.registry.add(form, { windows: true })
          share!.fill(0)
          const kek = dv.keys.deriveTokenKey(tokenBytes, HKDF_INFO.userAuthKek)
          for (const form of [kek.toString('hex'), kek.toString('base64'), kek.toString('base64url')]) {
            rig.registry.add(form, { windows: true })
            tokenKek.add(form, { windows: true })
          }
          kek.fill(0)
          for (const form of [tokenText, tokenBytes.toString('hex'), tokenBytes.toString('base64')]) {
            rig.registry.add(form, { windows: true })
            tokenKek.add(form, { windows: true })
          }
          tokenBytes.fill(0)
        } finally {
          dv.close()
        }
      }
    })

    // 13. the scans
    await rig.step('scan', async () => {
      const out = rig.scan()
      console.log(`      scan output files=${out.files} whole=${out.whole} windows=${out.windows}`)
      expect(out.files).to.be.at.least(6)
      expect(out.whole).to.equal(0)
      expect(out.windows).to.equal(0)
      const dirs = rig.scanPeerDirs(tokenKek)
      console.log(`      scan peer dirs (token+KEK) files=${dirs.files} whole=${dirs.whole} windows=${dirs.windows}`)
      expect(dirs.files).to.be.at.least(20)
      expect(dirs.whole).to.equal(0)
      expect(dirs.windows).to.equal(0)
      const vaults = rig.scanVaults(rig.registry)
      console.log(`      scan vaults (every secret) files=${vaults.files} whole=${vaults.whole} windows=${vaults.windows}`)
      expect(vaults.files).to.be.at.least(12)
      expect(vaults.whole).to.equal(0)
      expect(vaults.windows).to.equal(0)
      for (const text of rig.captured) {
        expect(text).to.not.match(/\/p2p\//)
        expect(text).to.not.match(/[0-9a-f]{64}/)
      }
    })

    // 14. the timings record
    const record = {
      timeline: choice,
      leadMs,
      windowMs,
      party: rig.party,
      wallMs: Date.now() - t0,
      revision: revisionSeen,
      steps: rig.steps,
      unwraps,
      restarts
    }
    const text = JSON.stringify(record, null, 2) + '\n'
    const inRun = join(rig.dir, 'cli-03-timings.json')
    writeFileSync(inRun, text, { mode: 0o600 })
    const keepDir = join(process.env.TMPDIR ?? tmpdir(), '67-28')
    mkdirSync(keepDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(keepDir, `cli-03-timings-${choice}-${rig.party}.json`), text, { mode: 0o600 })
    console.log(`      CLI03-TIMINGS ${basename(inRun)}`)
    expect(rig.steps.length).to.be.at.least(20)
    expect(unwraps.dkgReplayA).to.equal(0)
    expect(unwraps.dkgReplayB).to.equal(0)
    expect(unwraps.releaseRepeatA).to.equal(0)
    expect(unwraps.releaseNoTokenA).to.equal(1)
  })
})
