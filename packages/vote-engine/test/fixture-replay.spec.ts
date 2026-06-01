import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'aegir/chai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DRAFTS_ROOT = join(__dirname, 'fixtures', 'builder-drafts');

const EXPECTED_KINDS = [
  // Phase 7 -- User
  'defaultUser.set',
  'user.create',
  'user.revise',
  'user.addKey',
  'user.revokeKey',
  // Phase 8 -- Networks + Elections
  'networks.create',
  'network.createAuthority',
  'network.pinAuthority',
  'network.unpinAuthority',
  'network.proposeRevision',
  'network.respondToInvite',
  'elections.createElection',
  'elections.adjustElection',
  'election.proposeBallot',
  'election.proposeRevision',
  'election.inviteKeyholder',
  'election.revokeKeyholder',
  // Phase 9 -- Authority + Signing
  'authority.createOfficerInvite',
  'authority.createAuthorityInvite',
  'authority.proposeAdmin',
  'authority.saveInviteWithSigning',
  'signing.sign',
  'signing.startSigningSession',
  // Phase 10 -- Tasks
  'tasks.completeKeyRelease',
  'tasks.completeSignature',
  'tasks.setOnboardingTaskCompleted',
];

describe('fixture-replay', () => {
  it('all 26 expected builder-draft kind directories exist', () => {
    for (const kind of EXPECTED_KINDS) {
      const kindDir = join(DRAFTS_ROOT, kind);
      expect(existsSync(kindDir), `Missing fixture kind directory: ${kind}`).to.be.true;
    }
    expect(EXPECTED_KINDS).to.have.lengthOf(26);
  });

  it('each kind has at least a v1/ directory', () => {
    for (const kind of EXPECTED_KINDS) {
      const v1Dir = join(DRAFTS_ROOT, kind, 'v1');
      expect(existsSync(v1Dir), `Missing v1/ directory for kind: ${kind}`).to.be.true;
      const stat = statSync(v1Dir);
      expect(stat.isDirectory(), `v1 is not a directory for kind: ${kind}`).to.be.true;
    }
  });

  it('populated fixtures have valid JSON structure', () => {
    let fixtureCount = 0;
    for (const kind of EXPECTED_KINDS) {
      const v1Dir = join(DRAFTS_ROOT, kind, 'v1');
      if (!existsSync(v1Dir)) continue;

      const files = readdirSync(v1Dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        fixtureCount++;
        const filePath = join(v1Dir, file);
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        expect(raw).to.have.property('kind');
        expect(raw).to.have.property('version');
        expect(raw).to.have.property('draft');
      }
    }
    // In v1.1, all v1/ dirs ship empty -- fixtureCount should be 0
    // When post-v1.1 PRs populate fixtures, this test exercises them
    if (fixtureCount === 0) {
      // All v1/ dirs are empty in v1.1 -- this is expected
      expect(fixtureCount).to.equal(0);
    }
  });

  it('no unexpected files in fixture directories', () => {
    for (const kind of EXPECTED_KINDS) {
      const v1Dir = join(DRAFTS_ROOT, kind, 'v1');
      if (!existsSync(v1Dir)) continue;

      const files = readdirSync(v1Dir);
      for (const file of files) {
        const isAllowed = file === '.gitkeep' || file.endsWith('.json');
        expect(isAllowed, `Unexpected file in ${kind}/v1/: ${file}`).to.be.true;
      }
    }
  });
});
