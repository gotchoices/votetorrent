// The CLI-05 reduced leg-set contract and its pure evaluator. No I/O, no imports: every input is a
// structural view handed in by the caller, and every failure is a short code with no file content.
//
// D-16 / assertDkgThreshold (packages/vote-engine/src/crypto/dkg.ts) refuses threshold < 2, so a
// 1-keyholder election can never run the DKG leg. The reduced topology therefore keeps 2 keyholders
// (officer, kh-a, kh-b, v1 = 4 peers) and reduces only the voters to 1. Pooling, decrypt, tally and
// publish need 3 votes, are skipped by the reduced run, and are proven only by 67-31 (loopback) and
// 67-34 (inspiringlab).
//
// POOL_TOKENS are the tokens the delivered h9-voters body can raise after its send gate opens
// (src/run/leg-bodies/voters.ts, W0 at line 184: timeline-missed, hv-commit, cid-disagree). A stop on
// any other h9 token is a real failure. RELEASE_STEP_NAMES are the h10 windows from
// src/run/leg-bodies/release.ts lines 39-46: both keyholders release concurrently inside ONE step
// named `release`, so the same step name proves each keyholder's release.

export const REDUCED_TOPOLOGY = Object.freeze({
  keyholders: 2,
  voters: 1,
  peers: 4,
  labels: Object.freeze(['officer', 'kh-a', 'kh-b', 'v1'])
})

export const REQUIRED_PASS_LEGS = Object.freeze(['network', 'h6-election', 'h7-accept', 'h8-dkg'])

/** Every name is in the delivered VOTER_STAGES list (src/run/daemon-launcher.ts lines 70-87). */
export const REQUIRED_VOTER_STAGES = Object.freeze([
  'joined',
  'registration-staged',
  'association-staged',
  'challenge-received',
  'challenge-answered',
  'associated'
])

export const POOL_TOKENS = Object.freeze(['timeline-missed', 'hv-commit', 'cid-disagree'])

/** The eight plan-listed tokens plus every 67-21 RUN_TOKENS entry that means an instrument/driver failure. */
export const HARD_STOP_TOKENS = Object.freeze([
  'secret-leak',
  'crash',
  'daemon-boot',
  'daemon-timeout',
  'leg-unwired',
  'alarm',
  'interrupted',
  'results-write',
  'leg-dir-exists',
  'daemon-unreachable',
  'delegate-timeout',
  'no-result',
  'bad-token'
])

export const RELEASE_STEP_NAMES = Object.freeze({ 'kh-a': 'release', 'kh-b': 'release' })

export interface ReducedLegView {
  leg: string
  status: string
  token: string
}

export interface ReducedStepView {
  name: string
  startMs: number
  endMs: number
  ok?: boolean
}

export interface ReducedScanView {
  whole: number
  windows: number
  files: number
}

export interface ReducedResultsView {
  summary: string
  legs: readonly ReducedLegView[]
  steps: readonly ReducedStepView[]
  secretScan: ReducedScanView
}

export interface PostReleaseView {
  ran: boolean
  khA?: { ok: boolean }
  khB?: { ok: boolean }
}

export interface ReducedLegSetInput {
  results: ReducedResultsView
  voterLog: string
  postRelease?: PostReleaseView
}

export interface ReachedLegSet {
  passLegs: string[]
  voterStages: string[]
  stopLeg: string | null
  stopToken: string | null
  releasePath: 'in-run' | 'post-run' | 'none'
}

export interface ReducedLegSetVerdict {
  ok: boolean
  failures: string[]
  reached: ReachedLegSet
}

function stageSeen (log: string, name: string): boolean {
  return new RegExp('^STAGE ' + name + '$', 'm').test(log)
}

function stepPassed (step: ReducedStepView): boolean {
  return step.endMs >= step.startMs && step.ok !== false
}

/**
 * Accepts both delivered shapes: Case R (all six legs PASS, both keyholders release inside h10) and
 * the Case F fallback (h9 stops on a pool token, key release proven post-run on the same peer dirs).
 */
export function evaluateReducedLegSet (input: ReducedLegSetInput): ReducedLegSetVerdict {
  const failures: string[] = []
  const fail = (code: string): void => {
    if (!failures.includes(code)) failures.push(code)
  }
  const legs = new Map<string, ReducedLegView>()
  for (const leg of input.results.legs) legs.set(leg.leg, leg)

  const scan = input.results.secretScan
  if (scan.whole !== 0 || scan.windows !== 0 || scan.files === 0) fail('secret-scan')

  const hard = new Set<string>(HARD_STOP_TOKENS)
  for (const leg of input.results.legs) {
    const token = typeof leg.token === 'string' ? leg.token : ''
    if (hard.has(token) || token.startsWith('crash-')) fail(`token:${token}`)
    if (leg.status === 'VOID') fail(`leg:${leg.leg}`)
  }

  const passLegs: string[] = []
  for (const name of REQUIRED_PASS_LEGS) {
    if (legs.get(name)?.status === 'PASS') passLegs.push(name)
    else fail(`leg:${name}`)
  }

  const voterStages: string[] = []
  for (const name of REQUIRED_VOTER_STAGES) {
    if (stageSeen(input.voterLog, name)) voterStages.push(name)
    else fail(`stage:${name}`)
  }

  const releaseSteps = Object.values(RELEASE_STEP_NAMES)
  const inRun = releaseSteps.every((name) => input.results.steps.some((s) => s.name === name && stepPassed(s)))
  const h10 = legs.get('h10-release-decrypt')
  const releasedInRun = inRun !== false && h10 !== undefined && (h10.status === 'PASS' || h10.status === 'FAIL')
  const post = input.postRelease
  const releasedPostRun = post?.ran === true && post.khA?.ok === true && post.khB?.ok === true
  let releasePath: ReachedLegSet['releasePath'] = 'none'
  if (releasedInRun) releasePath = 'in-run'
  else if (releasedPostRun) releasePath = 'post-run'
  else fail('key-release')

  let stopLeg: string | null = null
  let stopToken: string | null = null
  const h9 = legs.get('h9-voters')
  if (h9?.status === 'FAIL') {
    const token = typeof h9.token === 'string' ? h9.token : ''
    if ((POOL_TOKENS as readonly string[]).includes(token)) {
      stopLeg = 'h9-voters'
      stopToken = token
    } else {
      fail(`token:${token}`)
    }
  } else if (h10?.status === 'FAIL' && releasedInRun) {
    stopLeg = 'h10-release-decrypt'
    stopToken = typeof h10.token === 'string' ? h10.token : ''
  }

  return {
    ok: failures.length === 0,
    failures,
    reached: { passLegs, voterStages, stopLeg, stopToken, releasePath }
  }
}
