/**
 * `@serfab/cadre-core` 1.18.0 x `@optimystic/db-p2p` 1.19.0: a JOINER whose first strand read finds
 * no confirmed coordinator tears its runtime down instead of waiting for a seed peer.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/joiner-coordinator-miss-defers.test.mjs
 *
 * The device-side symptom (VoteTorrent debug `nonfounder-cold-reattach-fail`, 2026-10-28): a phone
 * that joined a network, cold-started, logs `[strand-factory] attach { founder: false }` and ~20 s
 * later `Re-attach failed: ... FindCoordinatorError: No coordinator available for key on network
 * /optimystic/strand-...: the remaining candidate peer(s) are foreign or not-yet-confirmed`, every
 * time. Its restored FRET state names five remembered serving peers, none connected; its only
 * connection when the first catalog read runs is the relay (membership `foreign`). The strand-peer
 * redial that would reach a member runs beside `initialize` and is not awaited, so on a JS-starved
 * phone it loses the race on every attempt.
 *
 * Cause: `StrandInstanceManager.buildStrandDatabase` defers a joiner (`'awaiting-seed'`: keep the
 * node and its redial up, rebuild the database every 5 s) only for a `BlockUnavailableError` with
 * reason `cohort-unreachable`. db-p2p's `findCoordinator` reports the same situation, no member
 * reachable yet, as a `FindCoordinatorError` (`NO_NETWORK_COORDINATOR` / `NO_COORDINATOR_AVAILABLE`),
 * which is rethrown, so `addStrand` rejects and the runtime, redial loop included, is released.
 *
 * What this asserts: with `StrandDatabase.initialize` throwing a db-p2p `FindCoordinatorError`, a
 * joiner's database build answers `'awaiting-seed'` and closes that attempt's database; a founder's
 * build still throws. Stock 1.18.0 FAILS the joiner case (the error is rethrown).
 *
 * No network: `initialize` is stubbed, so this checks the build's classification of the error only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrandDatabase, StrandInstanceManager } from '@serfab/cadre-core';
import { FindCoordinatorError, FIND_COORDINATOR_ERROR_CODES } from '@optimystic/db-p2p';

const STRAND = '7f2823797b7124e614cf93bb4a90d5ec';

function manager() {
  const self = Object.create(StrandInstanceManager.prototype);
  self.firstSyncGates = new Map();
  self.strandStorages = new Map();
  return self;
}

async function build(founder, error) {
  const originalInit = StrandDatabase.prototype.initialize;
  const originalClose = StrandDatabase.prototype.close;
  let closed = 0;
  StrandDatabase.prototype.initialize = async function stub() { throw error; };
  StrandDatabase.prototype.close = async function stub() { closed++; };
  try {
    const self = manager();
    const instance = { strandId: STRAND };
    const config = { founder, sAppConfig: {}, strandRow: { Type: 'S' }, firstSync: { timeoutMs: 1000 } };
    const node = { coordinatedRepo: {}, storageRepo: undefined };
    const result = await StrandInstanceManager.prototype.buildStrandDatabase.call(self, instance, config, node);
    return { result, closed, gates: self.firstSyncGates.size };
  } finally {
    StrandDatabase.prototype.initialize = originalInit;
    StrandDatabase.prototype.close = originalClose;
  }
}

const unconfirmed = () => new FindCoordinatorError(FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR,
  `No coordinator available for key on network /optimystic/strand-${STRAND}: the remaining candidate peer(s) are foreign or not-yet-confirmed to serve this network's cluster/repo protocol`);
const noneConnected = () => new FindCoordinatorError(FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE,
  'No coordinator available for key (this node is not among the responsible peers and none of them is connected)');

test('a joiner whose first read finds no confirmed coordinator waits for a seed peer', async () => {
  for (const error of [unconfirmed(), noneConnected(), new Error('catalog read failed', { cause: unconfirmed() })]) {
    const { result, closed, gates } = await build(false, error);
    assert.equal(result, 'awaiting-seed', `${error.message}`);
    assert.equal(closed, 1, 'the attempt\'s database is closed');
    assert.equal(gates, 0, 'the attempt\'s first-sync gate is dropped');
  }
});

test('a founder\'s coordinator miss still fails the build', async () => {
  await assert.rejects(build(true, unconfirmed()), { name: 'FindCoordinatorError' });
});

test('a joiner\'s other read failures still fail the build', async () => {
  await assert.rejects(build(false, new Error('schema signature mismatch')), /schema signature mismatch/);
});
