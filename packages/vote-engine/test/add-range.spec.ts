import { computeRange } from '@votetorrent/vote-core'
import { expect } from 'chai'

describe('computeRange', () => {
  it('computeRange([], "1", "3") produces ["1","2","3"]', () => {
    expect(computeRange([], '1', '3')).to.deep.equal(['1', '2', '3'])
  })

  it('computeRange([], "3", "1") (start > end) returns input unchanged', () => {
    expect(computeRange([], '3', '1')).to.deep.equal([])
  })

  it('computeRange(["3"], "2", "4") deduplicates "3" and returns ["3","2","4"]', () => {
    expect(computeRange(['3'], '2', '4')).to.deep.equal(['3', '2', '4'])
  })

  it('computeRange([], "x", "5") (non-numeric from) returns input unchanged', () => {
    expect(computeRange([], 'x', '5')).to.deep.equal([])
  })
})
