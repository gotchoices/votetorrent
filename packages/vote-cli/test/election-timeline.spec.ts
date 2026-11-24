// election-timeline.spec.ts: the CLI short timeline (the lean rig's rule, second-aligned) and the
// Voter's own rule over the shared deriveTimeline. Pure; no clock, no files, no network.

import { expect } from 'chai'
import { ElectionEvent } from '@votetorrent/vote-core'
import {
  DEFAULT_LEAD_MS,
  DEFAULT_WINDOW_MS,
  MIN_LEAD_MS,
  MIN_WINDOW_MS,
  buildCliTimeline,
  checkVoterTimelineRules,
  parseTimelineArgs
} from '../src/election/parse-timeline.js'

const NOW = 1_700_000_000_123
const EVENTS = Object.values(ElectionEvent)

describe('election timeline', () => {
  it('defaults to 600000 / 480000 and is not below the proven defaults', () => {
    const r = parseTimelineArgs({})
    expect(r).to.deep.equal({ ok: true, leadMs: 600000, windowMs: 480000, belowProvenDefaults: false })
    expect(DEFAULT_LEAD_MS).to.equal(600000)
    expect(DEFAULT_WINDOW_MS).to.equal(480000)
  })

  it('accepts 90000 / 60000 and flags them below the proven defaults', () => {
    const r = parseTimelineArgs({ leadMs: '90000', windowMs: '60000' })
    expect(r).to.deep.equal({ ok: true, leadMs: 90000, windowMs: 60000, belowProvenDefaults: true })
    expect(MIN_LEAD_MS).to.equal(90000)
    expect(MIN_WINDOW_MS).to.equal(60000)
  })

  it('refuses a lead below 90000 as lead-too-short and a window below 60000 as window-too-short', () => {
    expect(parseTimelineArgs({ leadMs: '89999' })).to.deep.equal({ ok: false, code: 'lead-too-short' })
    expect(parseTimelineArgs({ windowMs: '59999' })).to.deep.equal({ ok: false, code: 'window-too-short' })
  })

  it('refuses non-digit, fractional, negative and over-cap values as lead-invalid / window-invalid', () => {
    for (const bad of ['abc', '1.5', '-1', '9999999999999']) {
      expect(parseTimelineArgs({ leadMs: bad }), `lead ${bad}`).to.deep.equal({ ok: false, code: 'lead-invalid' })
      expect(parseTimelineArgs({ windowMs: bad }), `window ${bad}`).to.deep.equal({ ok: false, code: 'window-invalid' })
    }
    expect(parseTimelineArgs({ leadMs: String(30 * 86400000 + 1) })).to.deep.equal({ ok: false, code: 'lead-invalid' })
    expect(parseTimelineArgs({ windowMs: String(7 * 86400000 + 1) })).to.deep.equal({ ok: false, code: 'window-invalid' })
  })

  it('rounds T up to a whole second and keeps every instant second-aligned', () => {
    const t = buildCliTimeline({ now: NOW, leadMs: 600000, windowMs: 480000 })
    expect(t.T).to.equal(1_700_000_001_000)
    for (const ev of EVENTS) expect(t.timeline[ev] % 1000, ev).to.equal(0)
    expect(Object.keys(t.timeline).sort()).to.deep.equal([...EVENTS].sort())
    for (const v of [t.votingStarts, t.date, t.revisionDeadline, t.ballotDeadline]) expect(v % 1000).to.equal(0)
  })

  it("uses the rig's offsets, with date = closed and revisionDeadline = ballotDeadline = votingStarts", () => {
    const lead = 600000
    const window = 480000
    const t = buildCliTimeline({ now: NOW, leadMs: lead, windowMs: window })
    const tl = t.timeline
    const vs = t.T + lead
    const acc = vs + window
    expect(tl.votingStarts).to.equal(vs)
    expect(t.votingStarts).to.equal(vs)
    expect(tl.accruingVotes).to.equal(acc)
    expect(tl.hashingVotes).to.equal(acc + 60000)
    expect(tl.releasingKeys).to.equal(acc + 120000)
    expect(tl.tallyingStarts).to.equal(acc + 180000)
    expect(tl.validation).to.equal(acc + 240000)
    expect(tl.certificationStarts).to.equal(acc + 300000)
    expect(tl.closed).to.equal(acc + 360000)
    expect(tl.registrationEnds).to.equal(vs - 60000)
    expect(tl.ballotsFinal).to.equal(vs - 60000)
    expect(t.date).to.equal(tl.closed)
    expect(t.revisionDeadline).to.equal(vs)
    expect(t.ballotDeadline).to.equal(vs)
  })

  it('the Voter rule accepts the default timeline', () => {
    const t = buildCliTimeline({ now: NOW, leadMs: DEFAULT_LEAD_MS, windowMs: DEFAULT_WINDOW_MS })
    expect(checkVoterTimelineRules({ timeline: t.timeline, date: t.date, ballotDeadline: t.ballotDeadline, now: NOW })).to.deep.equal([])
  })

  it('the Voter rule accepts the 90000 / 60000 timeline', () => {
    const t = buildCliTimeline({ now: NOW, leadMs: 90000, windowMs: 60000 })
    expect(checkVoterTimelineRules({ timeline: t.timeline, date: t.date, ballotDeadline: t.ballotDeadline, now: NOW })).to.deep.equal([])
  })

  it('a planted ballotsFinal after the ballot deadline yields exactly BALLOTS_FINAL_AFTER_DEADLINE (negative control)', () => {
    const t = buildCliTimeline({ now: NOW, leadMs: DEFAULT_LEAD_MS, windowMs: DEFAULT_WINDOW_MS })
    // ballotsFinal stays where the rig puts it; the deadline is planted 1 s before it, so the only rule broken is
    // the ballots-final-vs-deadline one. Moving ballotsFinal past votingStarts instead breaks the ORDER rule too,
    // and the Voter reports both (asserted second: the check can fail, and it never drops a code).
    const codes = checkVoterTimelineRules({ timeline: t.timeline, date: t.date, ballotDeadline: t.timeline.ballotsFinal - 1000, now: NOW })
    expect(codes).to.deep.equal(['BALLOTS_FINAL_AFTER_DEADLINE'])
    const moved = { ...t.timeline, ballotsFinal: t.ballotDeadline + 1000 }
    expect(checkVoterTimelineRules({ timeline: moved, date: t.date, ballotDeadline: t.ballotDeadline, now: NOW })).to.deep.equal(['BALLOTS_FINAL_AFTER_DEADLINE', 'OUT_OF_ORDER'])
  })
})
