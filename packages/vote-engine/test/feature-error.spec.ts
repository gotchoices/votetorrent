import { FeatureNotAvailableError } from '@votetorrent/vote-core'
import { expect } from 'chai'

describe('FeatureNotAvailableError', () => {
  it('has message equal to the constructor string', () => {
    const msg = 'getHistory — available in Phase 19 (user event table)'
    const err = new FeatureNotAvailableError(msg)
    expect(err.message).to.equal(msg)
  })

  it('has name === FeatureNotAvailableError', () => {
    const err = new FeatureNotAvailableError('test')
    expect(err.name).to.equal('FeatureNotAvailableError')
  })

  it('is instanceof Error', () => {
    const err = new FeatureNotAvailableError('test')
    expect(err).to.be.instanceOf(Error)
  })

  it('exposes gatingPhase readonly property matching the message', () => {
    const msg = 'connectDevice — available in Phase 22 (P2P fabric)'
    const err = new FeatureNotAvailableError(msg)
    expect(err.gatingPhase).to.equal(msg)
  })
})
