/**
 * boot-failure-copy.test.mjs -- 56-34: what an addressed election page says
 * when its network connection FAILED and this browser holds no copy.
 *
 * Three layers, each tested where it lives:
 *   1. `bootFailureKind` (peer/boot.js): a FAILED boot's subject -> 'unreachable' | 'notOnNetwork' | null.
 *   2. `probeAddressedElection`'s `anyRead`, and boot's subject choice from it:
 *      "not on the network" only when a read actually completed.
 *   3. ElectionShell.tsx (comment-stripped source, the convention this suite's
 *      other .tsx checks follow): which sentence pair renders, and that the
 *      three pairs exclude one another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import {
	bootFailureKind,
	BOOT_FAILURE_KIND,
	probeAddressedElection,
	startPublicPeerBoot,
	PEER_BOOT_STATUS,
} from '../../src/peer/boot.js';

// ---------------------------------------------------------------------------
// 1. bootFailureKind
// ---------------------------------------------------------------------------

test('bootFailureKind: the network answered with no such election is notOnNetwork', () => {
	assert.equal(bootFailureKind('election-not-on-network'), BOOT_FAILURE_KIND.NOT_ON_NETWORK);
	assert.equal(BOOT_FAILURE_KIND.NOT_ON_NETWORK, 'notOnNetwork');
});

test('bootFailureKind: every never-heard-the-network subject is unreachable', () => {
	for (const subject of ['no-peer-connected', 'no-coordinator', 'election-read-failed', 'FindCoordinatorError', 'BlockUnavailableError']) {
		assert.equal(bootFailureKind(subject), BOOT_FAILURE_KIND.UNREACHABLE, subject);
	}
	assert.equal(BOOT_FAILURE_KIND.UNREACHABLE, 'unreachable');
});

test('bootFailureKind: any other subject (a build defect, a replication fault, nothing) has no sentence of its own', () => {
	for (const subject of ['coordinatedRepo', 'register', 'PeerReplicationError', 'EdgeNodeConfigError', 'unknown', '', undefined, null, 42]) {
		assert.equal(bootFailureKind(subject), null, String(subject));
	}
});

// ---------------------------------------------------------------------------
// 2. probeAddressedElection.anyRead and boot's subject
// ---------------------------------------------------------------------------

/** @param {Array<'throw' | 'empty' | 'row'>} script */
function scriptedHandle(script) {
	const steps = [...script];
	return {
		db: {
			eval() {
				const step = steps.shift() ?? 'empty';
				return (async function* () {
					if (step === 'throw') throw Object.assign(new Error('row values must not leak'), { name: 'FindCoordinatorError' });
					if (step === 'row') yield { Id: 'el-1' };
				})();
			},
		},
	};
}
const noSleep = { sleep: async () => {} };

test('probe: every read threw -> anyRead false, with the last error name', async () => {
	const out = await probeAddressedElection(scriptedHandle(['throw', 'throw', 'throw']), 'el-1', noSleep);
	assert.deepEqual(out, { found: false, attempts: 3, lastErrorName: 'FindCoordinatorError', anyRead: false });
});

test('probe: one read completed with zero rows -> anyRead true, even if a later one threw', async () => {
	const out = await probeAddressedElection(scriptedHandle(['throw', 'empty', 'throw']), 'el-1', noSleep);
	assert.equal(out.found, false);
	assert.equal(out.anyRead, true);
});

test('probe: a row -> found, anyRead true', async () => {
	const out = await probeAddressedElection(scriptedHandle(['empty', 'row']), 'el-1', noSleep);
	assert.deepEqual(out, { found: true, attempts: 2, lastErrorName: null, anyRead: true });
});

/** A boot whose every step succeeds up to the probe, which returns `probeResult`. @param {any} probeResult */
async function bootWithProbe(probeResult) {
	/** @type {string[]} */
	const calls = [];
	const node = { peerId: { toString: () => 'P' }, coordinatedRepo: {} };
	const result = await startPublicPeerBoot({
		networkHash: 'nh-1',
		electionId: 'el-1',
		deps: /** @type {any} */ ({
			loadBootstrapConfig: async () => ({ ok: true, bootstrapNodes: ['/dns4/x/tcp/443/wss/p2p/QmX'] }),
			loadOrCreateSessionPeerKey: async () => ({}),
			createEdgeNode: async () => ({ node, dbName: 'd', stop: async () => void calls.push('node.stop') }),
			waitForFirstConnection: async () => ({ connected: true }),
			openStrandReadHandle: async () => ({ db: {}, close: async () => void calls.push('handle.close') }),
			probeAddressedElection: async () => probeResult,
			openUiHandleForNetwork: async () => {
				calls.push('store');
				return {};
			},
		}),
	});
	return { result, calls };
}

test('boot: a probe that never completed a read fails "election-read-failed" (unreachable), never "election-not-on-network"', async () => {
	const { result, calls } = await bootWithProbe({ found: false, attempts: 3, lastErrorName: 'FindCoordinatorError', anyRead: false });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(/** @type {any} */ (result).subject, 'election-read-failed');
	assert.equal(bootFailureKind(/** @type {any} */ (result).subject), 'unreachable');
	assert.ok(!calls.includes('store'), 'a store was created');
});

test('boot: a probe that read and found nothing fails "election-not-on-network" (notOnNetwork)', async () => {
	const { result } = await bootWithProbe({ found: false, attempts: 3, lastErrorName: null, anyRead: true });
	assert.equal(/** @type {any} */ (result).subject, 'election-not-on-network');
	assert.equal(bootFailureKind(/** @type {any} */ (result).subject), 'notOnNetwork');
});

test('boot: a probe result with no anyRead field (an older fake) keeps "election-not-on-network"', async () => {
	const { result } = await bootWithProbe({ found: false, attempts: 3, lastErrorName: null });
	assert.equal(/** @type {any} */ (result).subject, 'election-not-on-network');
});

// ---------------------------------------------------------------------------
// 3. ElectionShell.tsx
// ---------------------------------------------------------------------------

const SHELL = stripComments(readFileSync(publicSrc('screens', 'ElectionShell.tsx'), 'utf8'));
const APP = stripComments(readFileSync(publicSrc('screens', 'PublicApp.tsx'), 'utf8'));

test('ElectionShell: a failure kind is read only for a stopped feed with nothing held and nothing still looked for', () => {
	assert.match(SHELL, /const failedKind = holdsNothing && !stillLooking && peerFeed === 'stopped' \? bootFailure : null;/);
	assert.match(SHELL, /const saysNotHeld = holdsNothing && !stillLooking && failedKind === null;/);
	assert.match(SHELL, /bootFailure = null \}: ElectionShellProps\)/, 'an absent prop must default to null (gate mounts stay byte-identical)');
});

test('ElectionShell: each of the three pairs renders under its own one guard, title and body together', () => {
	/** @type {Array<[string, string]>} */
	const pairs = [
		['saysNotHeld', 'public.election.notHeld'],
		["failedKind === 'unreachable'", 'public.election.unreachable'],
		["failedKind === 'notOnNetwork'", 'public.election.notOnNetwork'],
	];
	for (const [guard, prefix] of pairs) {
		for (const [part, open, tag] of [['title', 'h2 className="election-notice__title"', 'h2'], ['body', 'p', 'p']]) {
			const key = `${prefix}.${part}`;
			assert.ok(key in COPY, `${key} is not in COPY`);
			const line = `{${guard} ? <${open}>{t('${key}')}</${tag}> : null}`;
			assert.ok(SHELL.includes(line), `missing: ${line}`);
			const mounts = SHELL.split(`t('${key}')`).length - 1;
			assert.equal(mounts, 1, `${key} mounted ${mounts} times`);
		}
	}
});

test('ElectionShell: the three guards exclude one another (saysNotHeld requires failedKind === null; the two kinds are distinct values)', () => {
	// Evaluate the two predicates over every input combination, as written.
	const kinds = [null, 'unreachable', 'notOnNetwork'];
	const feeds = [undefined, 'unobserved', 'running', 'stopped'];
	for (const holdsNothing of [false, true]) {
		for (const peerFeed of feeds) {
			for (const bootFailure of kinds) {
				const stillLooking = holdsNothing && (peerFeed === 'unobserved' || peerFeed === 'running');
				const failedKind = holdsNothing && !stillLooking && peerFeed === 'stopped' ? bootFailure : null;
				const saysNotHeld = holdsNothing && !stillLooking && failedKind === null;
				const shown = [stillLooking, saysNotHeld, failedKind === 'unreachable', failedKind === 'notOnNetwork'].filter(Boolean).length;
				assert.equal(shown, holdsNothing ? 1 : 0, JSON.stringify({ holdsNothing, peerFeed, bootFailure }));
			}
		}
	}
});

test('PublicApp: the boot failure kind comes from bootFailureKind of a FAILED result only, and reaches the shell', () => {
	assert.match(APP, /import \{ bootFailureKind \} from '\.\.\/peer\/boot\.js';/);
	assert.match(APP, /bootFailure: result\.status === PEER_BOOT_STATUS\.FAILED \? bootFailureKind\(result\.subject\) : null,/);
	assert.match(APP, /const \{ peerFeed, bootFailure \} = usePeerFeedStatus\(/);
	assert.match(APP, /bootFailure=\{bootFailure\}/);
});

// The failure and still-looking titles were bare h2s, which render at the
// browser default (larger than the election title). They carry one class whose
// rule sits below .election-title (2026-11-23 todo).
test('ElectionShell: no guarded election notice title is a bare h2, and .election-notice__title is smaller than .election-title', () => {
	const BARE = /\? <h2>\{t\('public\.election\./;
	assert.doesNotMatch(SHELL, BARE, 'a notice title is a bare h2, which renders at the browser default size');
	assert.match("{stillLooking ? <h2>{t('public.election.fetching.title')}</h2> : null}", BARE, 'control: the bare-h2 matcher fires');
	const css = readFileSync(publicSrc('app.css'), 'utf8');
	/** @param {string} cls @returns {string | null} */
	const fontSizeToken = (cls) => {
		const m = new RegExp(`(?:^|\\n)\\.${cls}\\s*\\{[^}]*font-size:\\s*var\\(--font-([a-z]+)-size\\)`).exec(css);
		return m ? m[1] : null;
	};
	const ORDER = ['label', 'body', 'heading', 'display'];
	const title = fontSizeToken('election-title');
	const notice = fontSizeToken('election-notice__title');
	assert.ok(title !== null && notice !== null, `font-size tokens: title=${title}, notice=${notice}`);
	assert.ok(ORDER.indexOf(notice) < ORDER.indexOf(title), `.election-notice__title (${notice}) is not smaller than .election-title (${title})`);
	assert.equal(fontSizeToken.call(null, 'nope'), null, 'control: an absent rule reads as null');
});
