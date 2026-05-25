/**
 * TDD RED -- minimal import tests for 6 election/elections builders.
 * These tests MUST FAIL until the builder modules are created.
 */
import { expect } from 'chai'
import { ElectionsCreateElectionBuilder } from '../src/elections/builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from '../src/elections/builders/elections-adjust-election-builder.js'
import { ElectionProposeBallotBuilder } from '../src/election/builders/election-propose-ballot-builder.js'
import { ElectionProposeRevisionBuilder } from '../src/election/builders/election-propose-revision-builder.js'
import { ElectionInviteKeyholderBuilder } from '../src/election/builders/election-invite-keyholder-builder.js'
import { ElectionRevokeKeyholderBuilder } from '../src/election/builders/election-revoke-keyholder-builder.js'

describe('Elections/Election Builders - RED gate', () => {
  it('ElectionsCreateElectionBuilder has KIND', () => {
    expect(ElectionsCreateElectionBuilder.KIND).to.equal('elections.createElection')
  })
  it('ElectionsAdjustElectionBuilder has KIND', () => {
    expect(ElectionsAdjustElectionBuilder.KIND).to.equal('elections.adjustElection')
  })
  it('ElectionProposeBallotBuilder has KIND', () => {
    expect(ElectionProposeBallotBuilder.KIND).to.equal('election.proposeBallot')
  })
  it('ElectionProposeRevisionBuilder has KIND', () => {
    expect(ElectionProposeRevisionBuilder.KIND).to.equal('election.proposeRevision')
  })
  it('ElectionInviteKeyholderBuilder has KIND', () => {
    expect(ElectionInviteKeyholderBuilder.KIND).to.equal('election.inviteKeyholder')
  })
  it('ElectionRevokeKeyholderBuilder has KIND', () => {
    expect(ElectionRevokeKeyholderBuilder.KIND).to.equal('election.revokeKeyholder')
  })
})
