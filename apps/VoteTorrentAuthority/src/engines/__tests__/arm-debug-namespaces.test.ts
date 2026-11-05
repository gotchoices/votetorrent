/**
 * arm-debug-namespaces.test.ts
 *
 * Gates the device-side half of the read-repair instrument. The property that matters is not
 * "the function ran" — it is that a line emitted on device is one the host-side analyzer
 * (`scripts/lib/analyze-read-repair.mjs`) can classify. The two live in different languages
 * and different processes, so the seam between them is bound here to a committed golden
 * fixture that the analyzer's own selftest parses. Drift on either side breaks a test.
 *
 * The single most load-bearing assertion in this file is `ageMs: undefined` being ABSENT from
 * the serialized payload: the whole verdict rests on absence meaning "lastSeenCommitMs was
 * never stamped". If a future edit made it serialize as `null` or `"undefined"`, the analyzer
 * would silently reclassify the Optimystic issue #8 defect as something else.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const GOLDEN_PATH = join(__dirname, '../../../../../scripts/lib/__fixtures__/optidbg-golden.txt');

/** Replace the emit timestamp with a fixed token so lines compare across runs. */
function normalize(line: string): string {
	return line.replace(/\[optidbg] \d+ \|/, '[optidbg] <T> |');
}

/**
 * Load the arming module AND `debug` from one isolated registry, with the generated namespace
 * constant mocked.
 *
 * Both must come from the SAME registry: `jest.doMock` gives each call a genuinely fresh
 * `debug` (verified — two loads are not identical, and neither equals a top-level import), so
 * a test that armed one instance and asserted against another would silently observe nothing.
 * That mirrors the real constraint on device, where the whole instrument works only because
 * the app and `@optimystic/db-p2p` resolve to ONE shared `debug` copy.
 */
function loadIsolated(namespaces: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let debugModule: any;
	let armDebugNamespaces: () => string | null = () => null;
	jest.isolateModules(() => {
		jest.doMock('../debug-namespaces.generated', () => ({ DEBUG_NAMESPACES: namespaces }));
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		debugModule = require('debug');
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		armDebugNamespaces = require('../arm-debug-namespaces').armDebugNamespaces;
	});
	return { debug: debugModule, arm: () => armDebugNamespaces() };
}

describe('armDebugNamespaces', () => {
	let logSpy: jest.SpyInstance;

	beforeEach(() => {
		// Under jest, `require('debug')` resolves the NODE build, whose save() writes
		// `process.env.DEBUG` — a process-global that survives module isolation and would arm
		// every later instance at construction. (On device Metro resolves the BROWSER build,
		// whose save() targets localStorage and is inert on RN, which is the whole reason
		// armDebugNamespaces has to exist.) Clear it so each test starts genuinely unarmed.
		delete process.env.DEBUG;
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		jest.resetModules();
	});

	const lines = () => logSpy.mock.calls.map(c => String(c[0]));
	const events = () => lines().filter(l => !l.includes('[optidbg] armed'));

	it('is a no-op with the committed default (empty namespaces)', () => {
		const m = loadIsolated('');
		expect(m.arm()).toBeNull();
		expect(lines()).toHaveLength(0);
	});

	it('arms, and reports the namespace it armed', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		expect(m.arm()).toBe('optimystic:db-p2p:coordinator-repo:*');
		expect(lines()[0]).toBe('[optidbg] armed namespaces=optimystic:db-p2p:coordinator-repo:*');
	});

	it('switches on a logger that was created BEFORE arming', () => {
		// The property the whole instrument depends on: `@optimystic/db-p2p` builds its loggers
		// at construction time, long before index.js gets to call us. debug 4.x re-reads
		// `createDebug.namespaces` through a getter, which is why arming later still works. If
		// that regressed, every capture would come back empty and read as "nothing happened".
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		// Note: debug reports `undefined`, not `false`, for a namespace it has never evaluated
		// (its cache starts equal to the unset `namespaces`, so the getter short-circuits).
		expect(log.enabled).toBeFalsy();
		m.arm();
		expect(log.enabled).toBe(true);
		log('cluster-tx:read-repair-triggered', { blockId: 'default/Revocation', mode: 'lazy' });
		expect(events()).toHaveLength(1);
	});

	it('leaves namespaces outside the filter silent', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const other = m.debug('optimystic:db-p2p:cluster-client');
		other('should not appear', { blockId: 'x' });
		expect(other.enabled).toBe(false);
		expect(events()).toHaveLength(0);
	});

	it('OMITS an undefined ageMs — absence is what marks a never-armed window', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		log('cluster-tx:read-repair-triggered', {
			blockId: 'default/Revocation',
			mode: 'lazy',
			ageMs: undefined,
			localRev: 3,
		});
		const line = events()[0];
		expect(line).toContain('"blockId":"default/Revocation"');
		expect(line).not.toContain('ageMs');
		expect(line).not.toContain('null');
	});

	it('emits a REAL ageMs when the window was armed', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		log('cluster-tx:read-repair-triggered', { blockId: 'default/Strand', mode: 'lazy', ageMs: 14321 });
		expect(events()[0]).toContain('"ageMs":14321');
	});

	it('emits one single line per event, with a parseable field order', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		log('cluster-fetch:solo-self-skip', { blockId: 'default/CadrePeer' });
		const line = events()[0];
		expect(line.split('\n')).toHaveLength(1);
		expect(line).toMatch(
			/^\[optidbg] \d+ \| optimystic:db-p2p:coordinator-repo:12D3KooWaaaa \| cluster-fetch:solo-self-skip \| \{"blockId":"default\/CadrePeer"}$/,
		);
	});

	it('degrades a circular payload instead of throwing inside a library log call', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		const cyclic: Record<string, unknown> = { blockId: 'default/Strand' };
		cyclic.self = cyclic;
		expect(() => log('cluster-tx:read-repair-noop', cyclic)).not.toThrow();
		expect(events()[0]).toContain('[Circular]');
	});

	it('is idempotent', () => {
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		expect(m.arm()).toBe('optimystic:db-p2p:coordinator-repo:*');
		expect(m.arm()).toBe('optimystic:db-p2p:coordinator-repo:*');
		expect(lines().filter(l => l.includes('armed namespaces='))).toHaveLength(1);
	});

	it("produces lines byte-identical to the analyzer's golden fixture", () => {
		// The binding to scripts/lib/analyze-read-repair.mjs. That analyzer's --selftest parses
		// this same file and asserts the classification it yields; this test asserts the device
		// side still produces it. Neither side can drift alone.
		const golden = readFileSync(GOLDEN_PATH, 'utf8').trim().split('\n');
		const m = loadIsolated('optimystic:db-p2p:coordinator-repo:*');
		m.arm();
		const log = m.debug('optimystic:db-p2p:coordinator-repo:12D3KooWaaaa');
		log('cluster-tx:read-repair-triggered', {
			blockId: 'default/Revocation', mode: 'lazy', ageMs: undefined, localRev: 3,
		});
		log('cluster-fetch:solo-self-skip', { blockId: 'default/Revocation' });
		log('cluster-tx:read-repair-noop', { blockId: 'default/Revocation' });
		log('commit:solo-cohort', { blockId: 'default/Strand', cohortSize: 1, soleIsSelf: true });

		expect(lines().map(normalize)).toEqual(golden.map(normalize));
	});
});
