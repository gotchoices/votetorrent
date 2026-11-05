/**
 * admin-change-constant.spec.ts — Phase 66.1 Plan 02 Task 3
 *
 * Pins the shipped administration-change delay at one hour (D-01) and proves no app-level switch
 * can change it (D-02): the shorter test delay exists only as an argument to the helper.
 *
 *   - shipped delay: the constant, the canonical effective-time form, the injected test delay
 *   - error codes: the six admin-change codes, frozen
 *   - officerSelectionFromInvitee (D-12): `existing` only, refuses an unaccepted invitee
 *   - MockAuthorityEngine pending + cancel contract (D-05, D-08 mirror)
 *   - MockInvitationEngine accepted officer invitees (D-12)
 *   - D-02 source scan over the Authority app src, vote-core src and both bootstrap configs, with
 *     positive controls proving every scanner can fail. Every planted token is built from fragments.
 *
 * Imports come from the vote-core package root, so this spec also proves the vote-core dist rebuild.
 */

import { expect } from 'chai'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADMIN_CHANGE_DELAY_MS,
  ADMIN_CHANGE_ERROR_CODES,
  adminChangeEffectiveAt,
  officerSelectionFromInvitee,
  UserKeyType
} from '@votetorrent/vote-core'
import type { AdminInit, Proposal, Signature } from '@votetorrent/vote-core'
import { MockAuthorityEngine } from '../src/authority/mock-authority-engine.js'
import { MockInvitationEngine } from '../src/invite/mock-invitation-engine.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const AUTHORITY_SRC = join(REPO_ROOT, 'apps', 'VoteTorrentAuthority', 'src')
const VOTE_CORE_SRC = join(REPO_ROOT, 'packages', 'vote-core', 'src')
const CONFIG_FILE = ['boot', 'strap', '.config.json'].join('')
const CONFIG_FILES = [
  join(REPO_ROOT, 'apps', 'VoteTorrentAuthority', CONFIG_FILE),
  join(REPO_ROOT, 'apps', 'VoteTorrentVoter', CONFIG_FILE)
]

// ---------------------------------------------------------------------------
// Fragment-built tokens (the spec never carries the literal tokens it hunts)
// ---------------------------------------------------------------------------

const DEV_FLAG = ['__', 'DEV', '__'].join('')
const ENV_READ = ['process', '.env'].join('')
const GLOBAL_OBJ = ['global', 'This'].join('')
const BOOT_WORD = ['boot', 'strap'].join('')
const REQUIRE_CALL = ['req', 'uire('].join('')
const LET_WORD = ['l', 'et'].join('')
const VAR_WORD = ['v', 'ar'].join('')
const DEFINE_PROP = ['Object', '.define', 'Property'].join('')
const CONFIG_DOT = ['Con', 'fig.'].join('')
const DELAY_NAME = ['ADMIN_CHANGE', '_DELAY_MS'].join('')
const HELPER_NAME = ['adminChange', 'EffectiveAt'].join('')

function esc (text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Scanners (reused by both the real-file tests and the positive controls)
// ---------------------------------------------------------------------------

function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const PURITY_CHECKS: Array<[string, RegExp]> = [
  ['dev flag', new RegExp(esc(DEV_FLAG))],
  ['env read', new RegExp(esc(ENV_READ))],
  ['global object', new RegExp(`\\b${GLOBAL_OBJ}\\b`)],
  ['boot config', new RegExp(BOOT_WORD, 'i')],
  ['require call', new RegExp(esc(REQUIRE_CALL))],
  ['non-type import', /^\s*import\s+(?!type\b)/m],
  ['mutable binding (l)', new RegExp(`\\b${LET_WORD}\\b`)],
  ['mutable binding (v)', new RegExp(`\\b${VAR_WORD}\\b`)],
  ['exported setter', /export function set[A-Z]/],
  ['property definition', new RegExp(esc(DEFINE_PROP))]
]

function scanModulePurity (stripped: string): string[] {
  return PURITY_CHECKS.filter(([, re]) => re.test(stripped)).map(([name]) => name)
}

function countDelayDeclarations (stripped: string): { declarations: number; assignments: number } {
  const declarations = stripped.match(new RegExp(`\\b(const|${LET_WORD}|${VAR_WORD})\\s+${DELAY_NAME}\\b`, 'g'))?.length ?? 0
  const assignments = stripped.match(new RegExp(`${DELAY_NAME}\\s*=(?!=)`, 'g'))?.length ?? 0
  return { declarations, assignments }
}

const SWITCH_TOKENS = [DEV_FLAG, ENV_READ, BOOT_WORD, CONFIG_DOT].map(esc).join('|')
const DELAY_TOKENS = [DELAY_NAME, HELPER_NAME].join('|')
const SWITCH_THEN_DELAY = new RegExp(`(?:${SWITCH_TOKENS})[^;\\n]*(?:${DELAY_TOKENS})`)
const DELAY_THEN_SWITCH = new RegExp(`(?:${DELAY_TOKENS})[^;\\n]*(?:${SWITCH_TOKENS})`)
const NAMED_ENV_DELAY = new RegExp(`${esc(ENV_READ)}\\.[A-Z0-9_]*(ADMIN|DELAY|EFFECTIVE)`)

function scanSwitchNearDelay (stripped: string): string[] {
  const hits: string[] = []
  if (SWITCH_THEN_DELAY.test(stripped)) hits.push('switch before delay')
  if (DELAY_THEN_SWITCH.test(stripped)) hits.push('delay before switch')
  if (NAMED_ENV_DELAY.test(stripped)) hits.push('named env delay')
  return hits
}

const INJECTED_CALL = new RegExp(`${HELPER_NAME}\\((?:[^()]|\\([^()]*\\))*,`)

function scanInjectedCall (stripped: string): string[] {
  return INJECTED_CALL.test(stripped) ? ['helper called with a second argument'] : []
}

function scanBootstrapConfig (text: string): string[] {
  const hits: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/admin|delay|effective/i.test(key)) hits.push(`key ${path}${key}`)
      walk(child, `${path}${key}.`)
    }
  }
  walk(JSON.parse(text), '')
  if (/admin.?change|change.?delay|effective.?at/i.test(text)) hits.push('raw text')
  return hits
}

// ---------------------------------------------------------------------------
// File sets
// ---------------------------------------------------------------------------

function listFiles (root: string, extensions: RegExp): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((rel) => join(root, rel))
    .filter((file) => extensions.test(file))
}

const SET_A = listFiles(AUTHORITY_SRC, /\.tsx?$/)
  .filter((file) => !file.split(sep).includes('__tests__'))
  .filter((file) => !/\.test\.tsx?$/.test(file))
const SET_B = listFiles(VOTE_CORE_SRC, /\.ts$/)
const ADMIN_CHANGE_FILE = SET_B.find((file) => file.endsWith(join('authority', 'admin-change.ts')))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CodedError = Error & { code?: string }

async function rejectionOf (promise: Promise<unknown>): Promise<CodedError> {
  try {
    await promise
  } catch (err) {
    return err as CodedError
  }
  throw new Error('expected the call to reject')
}

function thrownBy (fn: () => unknown): CodedError {
  try {
    fn()
  } catch (err) {
    return err as CodedError
  }
  throw new Error('expected the call to throw')
}

function proposal (effectiveAt: string): Proposal<AdminInit> {
  return {
    proposed: {
      officers: [{ existing: { userId: 'u-1', authorityId: 'auth-1', title: 'Clerk', scopes: ['rad'] } }],
      effectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    signers: []
  }
}

function newMockAuthority (): MockAuthorityEngine {
  return new MockAuthorityEngine({ id: 'auth-1', name: 'Test', domainName: 'test.org' })
}

function signSpy (): { calls: number; sign: (digest: Uint8Array) => Promise<Signature> } {
  const spy = {
    calls: 0,
    sign: async (_digest: Uint8Array): Promise<Signature> => {
      spy.calls += 1
      return {} as Signature
    }
  }
  return spy
}

const T0 = Date.UTC(2026, 10, 5, 4, 0, 0)

// ---------------------------------------------------------------------------

describe('admin-change-constant (66.1-02)', () => {
  describe('shipped delay (D-01, D-02)', () => {
    it('the shipped delay is exactly one hour', () => {
      expect(ADMIN_CHANGE_DELAY_MS).to.equal(3_600_000)
    })

    it('the effective time is the canonical 19-char UTC form, one hour after now', () => {
      const at = adminChangeEffectiveAt(T0)
      expect(at).to.equal('2026-11-05T05:00:00')
      expect(at).to.have.length(19)
      expect(at).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(at).to.not.include('Z')
    })

    it('the default delay is the shipped constant', () => {
      expect(adminChangeEffectiveAt(T0)).to.equal(adminChangeEffectiveAt(T0, ADMIN_CHANGE_DELAY_MS))
    })

    it('a test passes the short delay as an argument', () => {
      expect(adminChangeEffectiveAt(T0, 5_000)).to.equal('2026-11-05T04:00:05')
    })

    it('truncates sub-second time', () => {
      expect(adminChangeEffectiveAt(T0 + 999, 5_000)).to.equal('2026-11-05T04:00:05')
    })

    it('parsed back as UTC, the result is exactly the delay after now', () => {
      expect(Date.parse(`${adminChangeEffectiveAt(T0)}Z`) - T0).to.equal(ADMIN_CHANGE_DELAY_MS)
    })
  })

  describe('error codes', () => {
    it('is exactly the six admin-change codes, frozen', () => {
      expect(ADMIN_CHANGE_ERROR_CODES).to.deep.equal({
        pending: 'admin-change-pending',
        noRadHolder: 'admin-no-rad-holder',
        inviteeNotAccepted: 'admin-invitee-not-accepted',
        cancelNotAuthorized: 'admin-cancel-not-authorized',
        cancelNotPending: 'admin-cancel-not-pending',
        cancelRefused: 'admin-cancel-refused'
      })
      expect(Object.isFrozen(ADMIN_CHANGE_ERROR_CODES)).to.equal(true)
    })
  })

  describe('officerSelectionFromInvitee (D-12)', () => {
    it('builds an existing selection bound to the accepted invitee', () => {
      const selection = officerSelectionFromInvitee({ slotCid: 'cid-1', name: 'Ana', userId: 'u-1' }, 'auth-1', 'Clerk', ['rad'])
      expect(selection).to.deep.equal({ existing: { userId: 'u-1', authorityId: 'auth-1', title: 'Clerk', scopes: ['rad'] } })
      expect(selection).to.not.have.property('init')
    })

    it('refuses a missing invitee with code admin-invitee-not-accepted', () => {
      const err = thrownBy(() => officerSelectionFromInvitee(undefined, 'auth-1', 'Clerk', ['rad']))
      expect(err.code).to.equal('admin-invitee-not-accepted')
      expect(err.message).to.not.match(/select/i)
      expect(err.message).to.not.include('Quereus')
    })

    it('refuses an invitee without a user id with code admin-invitee-not-accepted', () => {
      const err = thrownBy(() => officerSelectionFromInvitee({ slotCid: 'cid-1', name: 'Ana', userId: '' }, 'auth-1', 'Clerk', ['rad']))
      expect(err.code).to.equal('admin-invitee-not-accepted')
      expect(err.message).to.not.match(/select/i)
      expect(err.message).to.not.include('Quereus')
    })
  })

  describe('MockAuthorityEngine pending + cancel contract (D-05, D-08 mirror)', () => {
    it('a fresh mock has no pending change', async () => {
      expect((await newMockAuthority().getAdminDetails()).pending).to.equal(undefined)
    })

    it('a past effective time sets no pending change', async () => {
      const engine = newMockAuthority()
      await engine.proposeAdmin(proposal(adminChangeEffectiveAt(Date.now(), -60_000)), signSpy().sign)
      expect((await engine.getAdminDetails()).pending).to.equal(undefined)
    })

    it('pending, one-pending refusal, single-shot idempotent cancel, then a new change is accepted', async () => {
      const engine = newMockAuthority()
      const effectiveAt = adminChangeEffectiveAt(Date.now(), 5_000)
      await engine.proposeAdmin(proposal(effectiveAt), signSpy().sign)

      const pending = (await engine.getAdminDetails()).pending
      expect(pending?.effectiveAt).to.equal(effectiveAt)
      expect(pending?.promoted).to.equal(false)
      expect(pending?.officers).to.have.length(1)

      const second = await rejectionOf(engine.proposeAdmin(proposal(adminChangeEffectiveAt(Date.now(), 10_000)), signSpy().sign))
      expect(second.code).to.equal('admin-change-pending')

      const spy = signSpy()
      await engine.cancelAdminChange({ effectiveAt, userId: 'u-1' }, spy.sign)
      expect(spy.calls).to.equal(0)
      expect(engine.cancelCalls).to.have.length(1)
      expect(engine.cancelCalls[0]).to.deep.equal({ effectiveAt, userId: 'u-1' })
      expect((await engine.getAdminDetails()).pending).to.equal(undefined)

      await engine.cancelAdminChange({ effectiveAt, userId: 'u-1' }, spy.sign)
      expect(engine.cancelCalls).to.have.length(1)
      expect(spy.calls).to.equal(0)

      const next = adminChangeEffectiveAt(Date.now(), 10_000)
      await engine.proposeAdmin(proposal(next), signSpy().sign)
      expect((await engine.getAdminDetails()).pending?.effectiveAt).to.equal(next)
    })

    it('cancelling an unknown effective time rejects with code admin-cancel-not-pending', async () => {
      const engine = newMockAuthority()
      await engine.proposeAdmin(proposal(adminChangeEffectiveAt(Date.now(), 5_000)), signSpy().sign)
      const err = await rejectionOf(engine.cancelAdminChange({ effectiveAt: '2000-01-01T00:00:00', userId: 'u-1' }, signSpy().sign))
      expect(err.code).to.equal('admin-cancel-not-pending')
      expect(engine.cancelCalls).to.have.length(0)
    })
  })

  describe('MockInvitationEngine accepted officer invitees (D-12)', () => {
    const invitePrivate = 'a'.repeat(64)
    const officer = {
      userId: 'u-1',
      name: 'Ana',
      signingKey: { key: '02' + 'b'.repeat(64), type: UserKeyType.p256, expiration: Date.now() + 86_400_000 }
    }

    it('an officer accept is listed', async () => {
      const engine = new MockInvitationEngine()
      await engine.respondToInvite('cid-1', true, invitePrivate, undefined, undefined, undefined, officer)
      expect(await engine.getAcceptedOfficerInvitees()).to.deep.equal([{ slotCid: 'cid-1', name: 'Ana', userId: 'u-1' }])
    })

    it('an accept without officer provisioning and a decline record nothing', async () => {
      const engine = new MockInvitationEngine()
      await engine.respondToInvite('cid-1', true, invitePrivate)
      await engine.respondToInvite('cid-2', false, invitePrivate, undefined, undefined, undefined, officer)
      expect(await engine.getAcceptedOfficerInvitees()).to.deep.equal([])
    })

    it('repeating the same accept does not duplicate the entry', async () => {
      const engine = new MockInvitationEngine()
      await engine.respondToInvite('cid-1', true, invitePrivate, undefined, undefined, undefined, officer)
      await engine.respondToInvite('cid-1', true, invitePrivate, undefined, undefined, undefined, officer)
      expect(await engine.getAcceptedOfficerInvitees()).to.have.length(1)
    })
  })

  describe('no app-level switch for the delay (D-02 source scan)', () => {
    describe('non-vacuity', () => {
      it('the file sets are populated and include the delay module and both configs', () => {
        expect(SET_A.length, 'Authority src files').to.be.greaterThan(50)
        expect(SET_B.length, 'vote-core src files').to.be.greaterThan(20)
        expect(ADMIN_CHANGE_FILE, 'admin-change.ts in vote-core src').to.not.equal(undefined)
        for (const file of CONFIG_FILES) expect(existsSync(file), file).to.equal(true)
      })
    })

    describe('real files', () => {
      it('the delay module is pure: no flag, env, global, config, require, value import, mutable binding or setter', () => {
        const stripped = stripComments(readFileSync(ADMIN_CHANGE_FILE!, 'utf8'))
        expect(scanModulePurity(stripped)).to.deep.equal([])
      })

      it('the delay is declared and assigned exactly once, in admin-change.ts', () => {
        const declaredIn: string[] = []
        const assignedIn: string[] = []
        const totals = { declarations: 0, assignments: 0 }
        for (const file of [...SET_A, ...SET_B]) {
          const counts = countDelayDeclarations(stripComments(readFileSync(file, 'utf8')))
          totals.declarations += counts.declarations
          totals.assignments += counts.assignments
          if (counts.declarations > 0) declaredIn.push(file)
          if (counts.assignments > 0) assignedIn.push(file)
        }
        expect(totals).to.deep.equal({ declarations: 1, assignments: 1 })
        expect(declaredIn).to.deep.equal([ADMIN_CHANGE_FILE])
        expect(assignedIn).to.deep.equal([ADMIN_CHANGE_FILE])
      })

      it('no statement in the Authority src or vote-core src joins a switch with the delay', () => {
        const violations: string[] = []
        for (const file of [...SET_A, ...SET_B]) {
          for (const hit of scanSwitchNearDelay(stripComments(readFileSync(file, 'utf8')))) violations.push(`${file}: ${hit}`)
        }
        expect(violations, violations.join('; ')).to.deep.equal([])
      })

      it('the Authority app never passes its own delay to the helper', () => {
        const violations: string[] = []
        for (const file of SET_A) {
          for (const hit of scanInjectedCall(stripComments(readFileSync(file, 'utf8')))) violations.push(`${file}: ${hit}`)
        }
        expect(violations, violations.join('; ')).to.deep.equal([])
      })

      it('neither bundled config carries a delay or effective-time field', () => {
        for (const file of CONFIG_FILES) {
          expect(scanBootstrapConfig(readFileSync(file, 'utf8')), file).to.deep.equal([])
        }
      })
    })

    describe('positive controls (every scanner can fail)', () => {
      const purityPlants: Array<[string, string]> = [
        ['dev flag', `export const d = ${DEV_FLAG} ? 1 : 2`],
        ['env read', `export const e = ${ENV_READ}.X`],
        ['global object', `export const g = ${GLOBAL_OBJ}.x`],
        ['boot config', `import type { C } from './${BOOT_WORD}.js'`],
        ['require call', `const r = ${REQUIRE_CALL}'x')`],
        ['non-type import', "import { x } from './x.js'"],
        ['mutable binding (l)', `${LET_WORD} delay = 1`],
        ['mutable binding (v)', `${VAR_WORD} delay = 1`],
        ['exported setter', 'export function setDelay (ms: number) {}'],
        ['property definition', `${DEFINE_PROP}(exports, 'x', {})`]
      ]
      for (const [category, sample] of purityPlants) {
        it(`positive control: scanModulePurity catches ${category}`, () => {
          expect(scanModulePurity(stripComments(sample))).to.include(category)
        })
      }

      it('positive control: countDelayDeclarations counts a second mutable declaration', () => {
        const sample = `export const ${DELAY_NAME} = 3_600_000\n${LET_WORD} ${DELAY_NAME} = 5_000\n`
        expect(countDelayDeclarations(sample).declarations).to.equal(2)
        expect(countDelayDeclarations(sample).assignments).to.equal(2)
      })

      it('positive control: scanSwitchNearDelay catches a dev-flag ternary', () => {
        expect(scanSwitchNearDelay(`const ms = ${DEV_FLAG} ? 5000 : ${DELAY_NAME}`)).to.not.deep.equal([])
      })

      it('positive control: scanSwitchNearDelay catches a named env delay', () => {
        const hits = scanSwitchNearDelay(`const ms = Number(${ENV_READ}.VT_ADMIN_DELAY)`)
        expect(hits).to.include('named env delay')
      })

      it('positive control: scanSwitchNearDelay catches the delay before a config read', () => {
        expect(scanSwitchNearDelay(`const at = ${HELPER_NAME}(Date.now(), ${CONFIG_DOT}delay)`)).to.include('delay before switch')
      })

      it('positive control: scanInjectedCall catches a second argument but not the default call', () => {
        expect(scanInjectedCall(`const at = ${HELPER_NAME}(Date.now(), 5000)`)).to.not.deep.equal([])
        expect(scanInjectedCall(`const at = ${HELPER_NAME}(Date.now())`)).to.deep.equal([])
      })

      it('positive control: scanBootstrapConfig catches a top-level and a nested field', () => {
        expect(scanBootstrapConfig('{"adminChangeDelayMs": 5000}')).to.not.deep.equal([])
        expect(scanBootstrapConfig('{"x": {"effectiveAt": 1}}')).to.not.deep.equal([])
        expect(scanBootstrapConfig('{"bootstrapNodes": []}')).to.deep.equal([])
      })

      it('positive control: a violation only inside a line comment yields no hit', () => {
        const sample = `// const ms = ${DEV_FLAG} ? 5000 : ${DELAY_NAME}\nexport const a = 1\n`
        expect(scanSwitchNearDelay(sample)).to.not.deep.equal([])
        expect(scanSwitchNearDelay(stripComments(sample))).to.deep.equal([])
        expect(scanModulePurity(stripComments(sample))).to.deep.equal([])
      })

      it('positive control: a violation only inside a block comment yields no hit', () => {
        const sample = `/* ${LET_WORD} ${DELAY_NAME} = ${ENV_READ}.VT_ADMIN_DELAY */\nexport const a = 1\n`
        expect(scanModulePurity(sample)).to.not.deep.equal([])
        expect(scanModulePurity(stripComments(sample))).to.deep.equal([])
        expect(scanSwitchNearDelay(stripComments(sample))).to.deep.equal([])
        expect(countDelayDeclarations(stripComments(sample))).to.deep.equal({ declarations: 0, assignments: 0 })
      })
    })
  })
})
