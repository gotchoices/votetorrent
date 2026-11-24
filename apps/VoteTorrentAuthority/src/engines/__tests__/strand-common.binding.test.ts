/**
 * strand-common.binding.test.ts — the five Authority strand bindings re-export the shared @votetorrent/workflows
 * objects BY IDENTITY. A second founder-intent slot or a second change hub would silently break the founding
 * window (an app-path `withFounding` the shared factory never sees) or screen reactivity (a hub nobody attaches).
 */

// Module-load-time native deps of the LevelDB half that stays in rn-db-factory.ts (ESM-only exports maps the
// CJS resolver cannot follow, hence `virtual`). '@votetorrent/vote-engine/rn' is deliberately NOT mocked: the
// identity check needs the real shared module graph.
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });
jest.mock('@quereus/store', () => ({ createIsolatedStoreModule: jest.fn(() => ({})) }), { virtual: true });

/* eslint-disable @typescript-eslint/no-var-requires */
const shared = require('@votetorrent/workflows') as Record<string, unknown>;
const founderIntentBinding = require('../founder-intent') as Record<string, unknown>;
const firstSyncBinding = require('../strand-first-sync') as Record<string, unknown>;
const relaySeedBinding = require('../strand-relay-seed') as Record<string, unknown>;
const dbFactoryBinding = require('../rn-db-factory') as Record<string, unknown>;
const strandChangesBinding = require('../strand-changes') as { strandChanges: { subscribe: (...args: unknown[]) => () => void } };
/* eslint-enable @typescript-eslint/no-var-requires */

const FOUNDER_INTENT_VALUES = [
	'FounderIntentBusyError',
	'isFounderIntentBusyError',
	'JoinedNetworksUnreadableError',
	'isJoinedNetworksUnreadableError',
	'withFounding',
	'withJoining',
	'takeFounderIntent',
	'resolveFounderFlag',
	'wrapCreateWithFounding',
];
const FIRST_SYNC_VALUES = [
	'MIN_FIRST_SYNC_RETRY_INTERVAL_MS',
	'isStrandAwaitingFirstSyncError',
	'StrandWaitCancelledError',
	'StrandLaunchFailedError',
	'STRAND_ERROR_POLL_MS',
	'failOnStrandError',
	'waitForStrandWritable',
];
const RELAY_SEED_VALUES = ['normalizeRelaySeed', 'seedStrandWithRelays'];

/** Babel's CJS interop adds a non-enumerable `__esModule` marker; the runtime keys are the value exports. */
function valueKeys(mod: Record<string, unknown>): string[] {
	return Object.keys(mod).filter((k) => k !== '__esModule').sort();
}

describe('strand bindings re-export the shared @votetorrent/workflows objects by identity', () => {
	it('B-1: every value export of founder-intent, strand-first-sync and strand-relay-seed is === the shared export, and the key sets are exactly the old export lists', () => {
		const bindings: Array<[string, Record<string, unknown>, string[]]> = [
			['founder-intent', founderIntentBinding, FOUNDER_INTENT_VALUES],
			['strand-first-sync', firstSyncBinding, FIRST_SYNC_VALUES],
			['strand-relay-seed', relaySeedBinding, RELAY_SEED_VALUES],
		];
		for (const [name, binding, expectedKeys] of bindings) {
			expect({ name, keys: valueKeys(binding) }).toEqual({ name, keys: [...expectedKeys].sort() });
			for (const key of expectedKeys) {
				expect(shared[key]).toBeDefined();
				expect(binding[key]).toBe(shared[key]);
			}
		}
	});

	it('B-2: rn-db-factory re-exports the shared createStrandDbFactory and keeps rnDbFactory, which the shared package does not export', () => {
		expect(typeof shared.createStrandDbFactory).toBe('function');
		expect(dbFactoryBinding.createStrandDbFactory).toBe(shared.createStrandDbFactory);
		expect(typeof dbFactoryBinding.rnDbFactory).toBe('function');
		expect('rnDbFactory' in shared).toBe(false);
	});

	it('B-3: strand-changes re-exports the shared strandChanges object itself, so a spy on the binding is seen through the shared export (one hub)', () => {
		expect(strandChangesBinding.strandChanges).toBe(shared.strandChanges);
		const unsubscribe = jest.fn();
		const spy = jest.spyOn(strandChangesBinding.strandChanges, 'subscribe').mockImplementation(() => unsubscribe);
		try {
			const sharedHub = shared.strandChanges as { subscribe: (tables: readonly string[], listener: () => void, options: { label: string }) => () => void };
			const result = sharedHub.subscribe(['Network'], () => undefined, { label: 'binding-test' });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(result).toBe(unsubscribe);
		} finally {
			spy.mockRestore();
		}
	});
});
