// The ONE adapter from leg steps to served verb names and argument names. Every name here is taken from
// the 67-24..67-30 SUMMARYs; leg bodies never spell a verb name (or a `.call('<verb>')`) themselves.
// An approval-class entry carries the per-call tokenFile key, injected by leg-bodies/common.ts.

export type LegVerbRole = 'officer' | 'keyholder' | 'voter'
export type LegVerbInput = Record<string, string | number | undefined>

export interface LegVerbEntry {
  readonly role: LegVerbRole
  readonly verb: string
  readonly approval: boolean
  readonly args: (input: LegVerbInput) => Record<string, string>
}

export type LegVerbKey = keyof typeof LEG_VERBS

function required (input: LegVerbInput, ...keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = input[key]
    if (value === undefined || value === '') throw new TypeError(`leg-verbs: missing ${key}`)
    out[key] = String(value)
  }
  return out
}

function withOptional (base: Record<string, string>, input: LegVerbInput, ...keys: readonly string[]): Record<string, string> {
  const out = { ...base }
  for (const key of keys) {
    const value = input[key]
    if (value !== undefined && value !== '') out[key] = String(value)
  }
  return out
}

function token (base: Record<string, string>, input: LegVerbInput, ...extra: Array<Record<string, string>>): Record<string, string> {
  let out = { ...base }
  for (const e of extra) out = { ...out, ...e }
  return withOptional(out, input, 'tokenFile')
}

export const LEG_VERBS = Object.freeze({
  // officer: network (67-24), election setup (67-26), intake (67-27), results (67-30)
  'officer.found': Object.freeze({
    role: 'officer', verb: 'found', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'name'), i)
  }),
  'officer.owner-setup': Object.freeze({
    role: 'officer', verb: 'owner-setup', approval: false,
    args: () => ({})
  }),
  'officer.capability': Object.freeze({
    role: 'officer', verb: 'capability', approval: false,
    args: () => ({})
  }),
  'officer.authority-id': Object.freeze({
    role: 'officer', verb: 'authority-id', approval: false,
    args: (i: LegVerbInput) => required(i, 'networkHash')
  }),
  'officer.dashboard-code': Object.freeze({
    role: 'officer', verb: 'dashboard-code', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'networkHash', 'codeFile'), i)
  }),
  'officer.mint': Object.freeze({
    role: 'officer', verb: 'mint', approval: false,
    args: (i: LegVerbInput) => required(i, 'networkHash', 'codeFile', 'fingerprintFile')
  }),
  'officer.enable-intake': Object.freeze({
    role: 'officer', verb: 'enable-intake', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'authority', 'network'), i)
  }),
  'officer.create-election': Object.freeze({
    role: 'officer', verb: 'create-election', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'title', 'keyholders', 'threshold'), i, withOptional({}, i, 'leadMs', 'windowMs'))
  }),
  'officer.keyholder-policy': Object.freeze({
    role: 'officer', verb: 'keyholder-policy', approval: false,
    args: (i: LegVerbInput) => required(i, 'network', 'election')
  }),
  'officer.invite-keyholder': Object.freeze({
    role: 'officer', verb: 'invite-keyholder', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election', 'name'), i, withOptional({}, i, 'shareName'))
  }),
  'officer.ballot-submit': Object.freeze({
    role: 'officer', verb: 'ballot-submit', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i, withOptional({}, i, 'ballotId'))
  }),
  'officer.task-sign': Object.freeze({
    role: 'officer', verb: 'task-sign', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election', 'ballot'), i, withOptional({}, i, 'waitMs'))
  }),
  'officer.peer-sync': Object.freeze({
    role: 'officer', verb: 'peer-sync', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'authority', 'network'), i)
  }),
  'officer.registrations': Object.freeze({
    role: 'officer', verb: 'registrations', approval: false,
    args: (i: LegVerbInput) => withOptional(required(i, 'authority', 'network'), i, 'status')
  }),
  'officer.approve': Object.freeze({
    role: 'officer', verb: 'approve', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'authority', 'network', 'request', 'checklist'), i)
  }),
  'officer.refuse': Object.freeze({
    role: 'officer', verb: 'refuse', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'authority', 'network', 'request', 'checklist', 'reasonFile'), i)
  }),
  'officer.release-window': Object.freeze({
    role: 'officer', verb: 'release-window', approval: false,
    args: (i: LegVerbInput) => required(i, 'network', 'election')
  }),
  'officer.tally': Object.freeze({
    role: 'officer', verb: 'tally', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i)
  }),
  'officer.publish': Object.freeze({
    role: 'officer', verb: 'publish', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i)
  }),
  'officer.results': Object.freeze({
    role: 'officer', verb: 'results', approval: false,
    args: (i: LegVerbInput) => withOptional(required(i, 'network', 'election'), i, 'waitMs')
  }),
  'officer.readback': Object.freeze({
    role: 'officer', verb: 'readback', approval: false,
    args: () => ({})
  }),

  // keyholder (67-28 ceremony, 67-30 results)
  'keyholder.join': Object.freeze({
    role: 'keyholder', verb: 'join', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'codeFile', 'expectFingerprintFile', 'networkHash'), i, withOptional({}, i, 'expectName', 'userName', 'timeoutMs'))
  }),
  'keyholder.accept': Object.freeze({
    role: 'keyholder', verb: 'accept', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'shareFile'), i, withOptional({}, i, 'waitMs'))
  }),
  'keyholder.dkg': Object.freeze({
    role: 'keyholder', verb: 'dkg', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i, withOptional({}, i, 'boundMs'))
  }),
  'keyholder.release': Object.freeze({
    role: 'keyholder', verb: 'release', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i, withOptional({}, i, 'waitMs', 'awaitCount'))
  }),
  'keyholder.results': Object.freeze({
    role: 'keyholder', verb: 'results', approval: false,
    args: (i: LegVerbInput) => withOptional(required(i, 'network', 'election'), i, 'waitMs')
  }),
  'keyholder.readback': Object.freeze({
    role: 'keyholder', verb: 'readback', approval: false,
    args: () => ({})
  }),

  // voter (67-29 ceremony, 67-30 vote and results)
  'voter.join': Object.freeze({
    role: 'voter', verb: 'join', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'codeFile'), i, withOptional({}, i, 'expectFingerprintFile', 'timeoutMs'))
  }),
  'voter.register': Object.freeze({
    role: 'voter', verb: 'register', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'registrantFile'), i, withOptional({}, i, 'election'))
  }),
  'voter.stage-association': Object.freeze({
    role: 'voter', verb: 'stage-association', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network'), i)
  }),
  'voter.answer-challenge': Object.freeze({
    role: 'voter', verb: 'answer-challenge', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network'), i, withOptional({}, i, 'waitMs'))
  }),
  'voter.read-decision': Object.freeze({
    role: 'voter', verb: 'read-decision', approval: false,
    args: (i: LegVerbInput) => withOptional(required(i, 'network'), i, 'waitFor', 'waitMs')
  }),
  'voter.cast': Object.freeze({
    role: 'voter', verb: 'cast', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i, withOptional({}, i, 'choiceIndex'))
  }),
  'voter.send': Object.freeze({
    role: 'voter', verb: 'send', approval: true,
    args: (i: LegVerbInput) => token(required(i, 'network', 'election'), i)
  }),
  'voter.results': Object.freeze({
    role: 'voter', verb: 'results', approval: false,
    args: (i: LegVerbInput) => withOptional(required(i, 'network', 'election'), i, 'waitMs')
  }),
  'voter.readback': Object.freeze({
    role: 'voter', verb: 'readback', approval: false,
    args: () => ({})
  })
} satisfies Record<string, LegVerbEntry>)
