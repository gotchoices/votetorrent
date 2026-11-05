/**
 * join-code-prefix.spec.ts — phase 64 plan 04. Node-only (run under jest.node.config.js).
 *
 * Pins vote-engine's hard-coded `sereus-invite:1.` literal to the Authority's own cadre-core, and
 * checks the BUILT join-code decoder against the real-encoder fixtures. Deliberately narrow and
 * never mocked: under this config the cadre-core package root cannot load (test 4 shows it), so
 * only the leaf `dist/cadre-join-request.js` is loaded. The real decode and byte-identical
 * re-encode run in vote-engine mocha (join-code-v2.spec.ts JV-1, JV-10c); test 3 here proves the
 * Authority ships the same cadre-core bytes those tests ran against.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  CADRE_INVITATION_PREFIX_EXPECTED,
  NETWORK_JOIN_CODE_PREFIX_V2,
  decodeNetworkJoinCode
} from '@votetorrent/vote-engine/rn'

const AUTHORITY_CADRE = path.resolve(__dirname, '../../../node_modules/@serfab/cadre-core')
const VOTE_ENGINE_CADRE = path.resolve(__dirname, '../../../../../packages/vote-engine/node_modules/@serfab/cadre-core')

// A path, because the package `exports` map has only `import` and `react-native` conditions.
const joinRequest = jest.requireActual(path.join(AUTHORITY_CADRE, 'dist/cadre-join-request.js')) as {
  CADRE_INVITATION_PREFIX: string
}

// jest.node.config.js has no fixture mapper, so the generated file is read by relative path.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JOIN_CODE_FIXTURES } = require('../../../../../packages/vote-engine/test/fixtures/join-code-fixtures.generated') as {
  JOIN_CODE_FIXTURES: Record<string, { text: string; fingerprint: string }>
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('join-code prefix pin (64-04, Node-only)', () => {
  it('pins vote-engine\'s literal to cadre-core\'s own CADRE_INVITATION_PREFIX', () => {
    expect(CADRE_INVITATION_PREFIX_EXPECTED).toBe(joinRequest.CADRE_INVITATION_PREFIX)
    expect(CADRE_INVITATION_PREFIX_EXPECTED).toBe('sereus-invite:1.')
  })

  it('the built decoder accepts every v2 real-encoder fixture', () => {
    expect(NETWORK_JOIN_CODE_PREFIX_V2).toBe('vtjoin2.')
    const names = Object.keys(JOIN_CODE_FIXTURES).filter((n) => n.startsWith('v2-'))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const fixture = JOIN_CODE_FIXTURES[name]!
      const decoded = decodeNetworkJoinCode(fixture.text)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) continue
      expect(decoded.code.v).toBe(2)
      expect(decoded.fingerprint).toBe(fixture.fingerprint)
      expect(decoded.code.invitation.startsWith(joinRequest.CADRE_INVITATION_PREFIX)).toBe(true)
    }
  })

  it('the Authority\'s cadre-core copy is byte-identical to the copy the round trip is proven on', () => {
    const version = (root: string): string => (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
    expect(version(AUTHORITY_CADRE)).toBe(version(VOTE_ENGINE_CADRE))
    for (const file of ['dist/cadre-invite-protocol.js', 'dist/cadre-join-request.js']) {
      expect(existsSync(path.join(AUTHORITY_CADRE, file))).toBe(true)
      expect(sha256(path.join(AUTHORITY_CADRE, file))).toBe(sha256(path.join(VOTE_ENGINE_CADRE, file)))
    }
  })

  // Flip-on-fix control, last in the file. Never weaken it to pass.
  it('control: the cadre-core package root does not load under test:node', () => {
    let thrown: unknown
    try {
      jest.requireActual(path.join(AUTHORITY_CADRE, 'dist/index.js'))
    } catch (e) {
      thrown = e
    }
    if (thrown === undefined) {
      throw new Error('cadre-core now loads under test:node: replace the copy-hash pin with a real decode/re-encode round trip in this spec')
    }
    expect((thrown as { code?: string }).code).toBe('MODULE_NOT_FOUND')
  })
})
