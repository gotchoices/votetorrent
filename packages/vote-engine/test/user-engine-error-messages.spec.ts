/**
 * SIGN-01 — user-facing FeatureNotAvailable error copy (D-15 reword).
 *
 * Backfills the automated coverage deferred in 21-15 (todo
 * sign01-ukey02-21-15-coverage / DEBT-03 D-10). Two engine-level error strings
 * were reworded by inspection only:
 *   - UserEngine.connectDevice (user-engine.ts) — the P2P phase-gate message must
 *     carry NO GSD phase number in user-facing copy and read exactly as reworded.
 *   - MockElectionEngine.revokeKeyholder (mock-election-engine.ts) — the mock
 *     "not available" message.
 *
 * Both throw before touching any DB context, so no EngineContext / prepareDb
 * setup is needed here.
 */

import { expect } from 'chai'
import { FeatureNotAvailableError } from '@votetorrent/vote-core'
import type { User } from '@votetorrent/vote-core'
import { UserEngine } from '../src/user/user-engine'
import { MockElectionEngine } from '../src/election/mock-election-engine'

// connectDevice throws immediately — none of these fields are read, so a minimal
// subject is sufficient.
function makeMinimalUser (): User {
  return {
    id: 'user-1',
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: []
  } as unknown as User
}

describe('SIGN-01: FeatureNotAvailable error copy carries no GSD phase number', () => {
  it('UserEngine.connectDevice throws the exact reworded message with no "Phase N" reference (D-15)', async () => {
    const engine = new UserEngine(makeMinimalUser())

    let caught: unknown
    try {
      await engine.connectDevice()
      expect.fail('connectDevice should have thrown FeatureNotAvailableError')
    } catch (err) {
      caught = err
    }

    expect(caught, 'connectDevice rejects with FeatureNotAvailableError').to.be.instanceOf(FeatureNotAvailableError)
    const message = (caught as Error).message
    // Exact reworded value (the string the UI surfaces).
    expect(message).to.equal('connectDevice — requires a paired device (P2P not available)')
    // No GSD phase number leaked into user-facing copy (the reword's whole point).
    expect(message).to.not.match(/Phase\s*\d/i)
  })

  it('MockElectionEngine.revokeKeyholder throws the mock-unavailable message (no phase number)', async () => {
    const engine = new MockElectionEngine()

    let caught: unknown
    try {
      await engine.revokeKeyholder({} as any, 'election-1')
      expect.fail('revokeKeyholder should have thrown FeatureNotAvailableError')
    } catch (err) {
      caught = err
    }

    expect(caught, 'revokeKeyholder rejects with FeatureNotAvailableError').to.be.instanceOf(FeatureNotAvailableError)
    const message = (caught as Error).message
    expect(message).to.equal('revokeKeyholder is not available in the mock engine')
    expect(message).to.not.match(/Phase\s*\d/i)
  })
})
