/**
 * Tier-1 proof of the dashboard's member node (`src/peer/member-node.js`): the platform it hands
 * cadre-core, the subscriber-only posture against the installed (patched) cadre-core, the
 * per-network storage names and their deletion, the strand claim and storage withdrawal, the join
 * reasons, resume, events, stop, log hygiene and the source bans.
 *
 * Honesty note: almost everything here runs over a FAKE edge node (a recorder of calls with
 * events the test fires), so it proves what this module asks of cadre-core, not what cadre-core
 * then does on a network. Three cases use the real installed cadre-core: the D-24
 * `strandCohortTopicOption` case, and the construction case that reads the identity through the
 * real `identityPeerId()`. `deleteMemberStorage` runs over `fake-indexeddb`. The real two-node
 * behaviour (a joined edge node reaching the strand, the withdrawal on real libp2p) is proven by
 * the vote-engine member-watch harness, and the browser behaviour by the browser gates.
 *
 * Sequential by design (`--test-concurrency=1`).
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { dashboardSrc, workspacePath } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import {
	InMemoryKeyStore,
	strandCohortTopicOption,
	encodeCadreInvitation,
	CadreInviteRejectedError,
	DEFAULT_IDENTITY_KEY_ID,
} from '@serfab/cadre-core';
import { DEFAULT_STRAND_CLUSTER_SIZE } from '@serfab/quereus-plugin-sereus';
import { openOptimysticWebDb } from '@optimystic/db-p2p-storage-web';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';
import {
	LOG_PREFIX,
	MEMBER_SAPP_CONFIG,
	MEMBER_STRAND_CLUSTER_SIZE,
	MemberNodeConfigError,
	MemberNodeError,
	MemberStorageBusyError,
	createMemberNode,
	createMemberPlatform,
	deleteMemberStorage,
	memberStorageDbName,
	validateRelayAddrs,
} from '../../src/peer/member-node.js';

const STRAND = 'strand0abc';
const RELAY = '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelayPeer1';
const HASH = 'netHash-7c1d';

let caseCounter = 0;
function uniqueHash() {
	caseCounter += 1;
	return `mn-${caseCounter}-${Date.now()}`;
}

/** Let queued macrotasks run (the strand:started handler is async). */
async function settle(turns = 5) {
	for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
	/** @type {(value?: any) => void} */
	let resolve = () => {};
	/** @type {(err: any) => void} */
	let reject = () => {};
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * @param {string} id
 * @param {{ unhandle?: (protocols: string[]) => Promise<void> }} [options]
 */
function fakeLibp2p(id, options = {}) {
	/** @type {string[][]} */
	const unhandleCalls = [];
	/** @type {string[]} */
	const handleCalls = [];
	return {
		peerId: { toString: () => id },
		unhandleCalls,
		handleCalls,
		/** @param {string} protocol */
		handle(protocol) {
			handleCalls.push(protocol);
			return Promise.resolve();
		},
		/** @type {Array<{ remotePeer: { toString(): string } }>} */
		connections: [],
		/** @param {string[]} protocols */
		unhandle(protocols) {
			unhandleCalls.push(protocols);
			return options.unhandle ? options.unhandle(protocols) : Promise.resolve();
		},
		getConnections() {
			return this.connections;
		},
	};
}

/**
 * A recording fake of cadre-core's EdgeNode. `state` drives its answers; `calls` records every
 * call in order; `fire` delivers an event to the handlers the member node registered.
 *
 * @param {{ order?: string[] }} [options]
 */
function fakeEdge(options = {}) {
	const order = options.order ?? [];
	/** @type {Array<[string, ...any[]]>} */
	const calls = [];
	/** @type {Map<string, Array<(payload: any) => void>>} */
	const handlers = new Map();
	/** @type {Map<string, any>} */
	const strands = new Map();
	/** @type {Set<(status: any) => void>} */
	const statusListeners = new Set();
	const controlNode = { id: 'control-node' };
	const state = {
		/** @type {{ state: string }} */
		status: { state: 'stopped' },
		/** @type {any} */
		savedStart: undefined,
		authorized: false,
		/** @type {string | null} */
		ownerKey: null,
		/** @type {any} */
		joinResult: { peerId: 'IdentityPeerX', redeemedAt: 1, asOwner: false },
		/** @type {any} */
		joinError: null,
		/** @type {any} */
		addStrandError: null,
		/** @type {any} */
		reconcileError: null,
		forceNode: false,
	};
	const node = {
		isRunning: true,
		/** @param {string} id */
		getStrand: (id) => strands.get(id),
		/** @param {any} arg */
		async addStrand(arg) {
			calls.push(['addStrand', arg]);
			if (state.addStrandError) throw state.addStrandError;
			return {};
		},
		getControlNode: () => controlNode,
		/** @param {string} peerId */
		async isAuthorizedMember(peerId) {
			calls.push(['isAuthorizedMember', peerId]);
			return state.authorized;
		},
		async reconcileControlCohort() {
			calls.push(['reconcileControlCohort']);
			if (state.reconcileError) throw state.reconcileError;
			return {};
		},
	};
	const edge = {
		/** @type {any} */
		platform: null,
		get status() {
			return state.status;
		},
		get node() {
			return state.status.state === 'running' || state.forceNode ? node : null;
		},
		/** @param {string} event @param {(payload: any) => void} handler */
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		async identityPeerId() {
			calls.push(['identityPeerId']);
			return 'IdentityPeerX';
		},
		/** @param {any} opts */
		async start(opts) {
			calls.push(['start', opts]);
			state.status = { state: 'running' };
			return node;
		},
		async stop() {
			calls.push(['stop']);
			state.status = { state: 'stopped' };
		},
		async loadSavedStart() {
			calls.push(['loadSavedStart']);
			return state.savedStart;
		},
		/** @param {any} credential @param {any} opts */
		async joinCadre(credential, opts) {
			calls.push(['joinCadre', credential, opts]);
			order.push('edge.joinCadre');
			if (state.joinError) throw state.joinError;
			opts?.onProgress?.({ state: 'admitted', asOwner: false, secret: 'not-forwarded' });
			state.status = { state: 'running' };
			return state.joinResult;
		},
		ownerPublicKey() {
			return state.ownerKey;
		},
		/** @param {string} event @param {any} payload */
		fire(event, payload) {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
		/** @param {(status: any) => void} listener */
		onStatus(listener) {
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		/** Set the status AND notify the onStatus listeners, as cadre-core's setStatus does. @param {{ state: string, [key: string]: unknown }} status */
		setStatus(status) {
			state.status = status;
			for (const listener of [...statusListeners]) listener(status);
		},
	};
	/** @param {any} platform */
	const createEdgeNode = (platform) => {
		edge.platform = platform;
		return edge;
	};
	return { edge, node, state, calls, strands, controlNode, createEdgeNode, statusListeners };
}

/**
 * @param {ReturnType<typeof fakeEdge>} fake
 * @param {{ keyStore?: any, strandId?: string | undefined, networkHash?: string, deps?: any }} [options]
 */
async function memberOver(fake, options = {}) {
	const keyStore = options.keyStore ?? new InMemoryKeyStore();
	if (!options.keyStore) await keyStore.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([8, 1, 18, 64, 1, 2, 3]));
	return createMemberNode({
		networkHash: options.networkHash ?? HASH,
		keyStore,
		relayAddrs: [RELAY],
		strandId: 'strandId' in options ? options.strandId : STRAND,
		deps: { createEdgeNode: fake.createEdgeNode, ...(options.deps ?? {}) },
	});
}

function ed25519PublicB64() {
	const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
	return /** @type {string} */ (jwk.x);
}

/** @param {{ partyId?: string, totalUses?: number | null }} [overrides] */
function makeInvitation(overrides = {}) {
	const invitation = {
		v: /** @type {1} */ (1),
		partyId: overrides.partyId ?? 'party-a',
		invitePrivateKey: ed25519PublicB64(),
		invite: {
			key: ed25519PublicB64(),
			peerId: null,
			expiresAt: null,
			totalUses: overrides.totalUses === undefined ? 1 : overrides.totalUses,
			stampId: 'stamp-1',
			issuerKey: ed25519PublicB64(),
			issuerSig: 'issuer-signature',
		},
		ownerKeys: [ed25519PublicB64()],
		members: ['/dns4/member.example/tcp/443/wss/p2p/12D3KooWMemberPeer'],
	};
	return { invitation, encoded: encodeCadreInvitation(/** @type {any} */ (invitation)) };
}

/**
 * @param {() => unknown} fn
 * @returns {unknown}
 */
function rejectionSync(fn) {
	try {
		fn();
	} catch (err) {
		return err;
	}
	assert.fail('expected a throw');
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function rejection(promise) {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	assert.fail('expected a rejection');
}

// ── Task 2: platform, posture, names, claim and withdrawal ──────────────────

test('1 platform shape: storage id per network, browser gater kept, no transports, listen addresses, journal or owner slot', () => {
	const platform = createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY], strandId: STRAND });
	assert.equal(platform.storage.id, `vt-dashboard-${HASH}`);
	assert.equal(platform.allowPrivateDial, false);
	for (const key of ['transports', 'listenAddrs', 'noiseCrypto']) {
		assert.equal(key in platform, false, `platform must not set ${key}`);
	}
	assert.equal('offlineJournal' in platform.storage, false);
	assert.equal('trustedOwnerSlot' in platform.storage, false);
});

test('2 configure: keeps the profile, relaxes schema signing, filters to this strand, pins the cluster size, sets the edgeHost slice', () => {
	const platform = createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY], strandId: STRAND });
	assert.ok(platform.configure);
	const base = /** @type {any} */ ({ profile: 'transaction', strandFilter: { mode: 'all' } });
	const cfg = /** @type {any} */ (platform.configure(base));
	assert.equal(cfg.profile, 'transaction');
	assert.equal(cfg.requireSignedSchemas, false);
	assert.deepEqual(cfg.strandFilter, { mode: 'strandId', strandId: STRAND });
	assert.equal(cfg.strandClusterSize, MEMBER_STRAND_CLUSTER_SIZE);
	assert.deepEqual(cfg.strandReactivity, { enabled: true, strandIds: [STRAND], edgeHost: true });
	assert.equal(cfg.strandReactivity.edgeHost, true);
	for (const key of ['hostUnclaimedStrands', 'privateKey', 'connectionGater']) {
		assert.equal(key in cfg, false, `configure must not set ${key}`);
	}

	const bare = createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY] });
	assert.ok(bare.configure);
	const bareCfg = /** @type {any} */ (bare.configure(base));
	assert.deepEqual(bareCfg.strandFilter, { mode: 'none' });
	assert.deepEqual(bareCfg.strandReactivity, { enabled: false });
});

test('3 D-24 end to end: the patched cadre-core strandCohortTopicOption turns the configured slice into a non-forwarding edge host', () => {
	const platform = createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY], strandId: STRAND });
	assert.ok(platform.configure);
	const cfg = /** @type {any} */ (platform.configure(/** @type {any} */ ({})));
	const option = /** @type {any} */ (strandCohortTopicOption(cfg.strandReactivity, STRAND));
	const host = option.cohortTopic?.host;
	assert.ok(host, 'the patched option builds a host for edgeHost: true');
	assert.equal(host.profile.kind, 'edge');
	const tiers = host.profile.willingTiers;
	assert.equal(tiers instanceof Set ? tiers.size : tiers.length, 0, 'an edge host is willing to serve no tier');
	assert.equal(host.minSigs, 1);

	const { edgeHost: _dropped, ...withoutEdgeHost } = cfg.strandReactivity;
	const control = /** @type {any} */ (strandCohortTopicOption(withoutEdgeHost, STRAND));
	assert.equal(control.cohortTopic?.enabled, true);
	assert.equal('host' in control.cohortTopic, false, 'control: without edgeHost the option carries no host');
});

test('4 cluster-size parity: MEMBER_STRAND_CLUSTER_SIZE matches what the Authority and Voter providers run', () => {
	const providers = [
		workspacePath('apps/VoteTorrentAuthority', 'src', 'providers', 'CadreNodeProvider.tsx'),
		workspacePath('apps/VoteTorrentVoter', 'src', 'providers', 'CadreNodeProvider.tsx'),
	];
	/** @type {string[]} */
	const branches = [];
	for (const file of providers) {
		const code = stripComments(readFileSync(file, 'utf8'));
		assert.match(code, /strandReactivity/, 'positive control: the provider source was read');
		const explicit = /strandClusterSize\s*:\s*(\d+)/.exec(code);
		if (explicit) {
			branches.push('explicit');
			assert.equal(MEMBER_STRAND_CLUSTER_SIZE, Number(explicit[1]));
		} else {
			branches.push('default');
			assert.equal(MEMBER_STRAND_CLUSTER_SIZE, DEFAULT_STRAND_CLUSTER_SIZE);
		}
	}
	assert.deepEqual(branches, ['default', 'default'], 'both providers run the cadre-core default today; a provider change must revisit this pin');
	assert.equal(MEMBER_STRAND_CLUSTER_SIZE, 4);
});

test('5 MEMBER_SAPP_CONFIG: org.votetorrent 1.0.0, interactive, frozen, the unwrapped schema, and the Authority literal agrees', () => {
	assert.equal(MEMBER_SAPP_CONFIG.id, 'org.votetorrent');
	assert.equal(MEMBER_SAPP_CONFIG.version, '1.0.0');
	assert.equal(MEMBER_SAPP_CONFIG.latencyHint, 'interactive');
	assert.ok(Object.isFrozen(MEMBER_SAPP_CONFIG));
	const expected = VOTETORRENT_SCHEMA_SQL.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
		.replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
		.trim();
	assert.equal(MEMBER_SAPP_CONFIG.schema, expected);
	assert.ok(MEMBER_SAPP_CONFIG.schema.length > 1000);
	assert.equal(/^declare\s+schema/.test(MEMBER_SAPP_CONFIG.schema), false);
	const factory = readFileSync(workspacePath('apps/VoteTorrentAuthority', 'src', 'engines', 'rn-db-factory.ts'), 'utf8');
	assert.ok(factory.includes("id: 'org.votetorrent'"));
	assert.ok(factory.includes("version: '1.0.0'"));
});

test('6 names: memberStorageDbName is per network and scope, fails closed, and the platform opens only those names, lazily', async () => {
	const shape = /^vt-member-[A-Za-z0-9_-]+-[A-Za-z0-9._~-]+-[0-9a-f]{8}$/;
	const control = memberStorageDbName(HASH, 'control-abc');
	assert.match(control, shape);
	assert.match(memberStorageDbName(HASH, '~node-local'), shape);
	assert.notEqual(control, 'optimystic');
	assert.notEqual(memberStorageDbName('hash-one', 's1'), memberStorageDbName('hash-two', 's1'));
	assert.notEqual(memberStorageDbName(HASH, 's1'), memberStorageDbName(HASH, 's2'));
	assert.notEqual(memberStorageDbName('a/b', 's1'), memberStorageDbName('a_b', 's1'), 'two hashes that sanitise alike still differ');
	for (const scope of ['node-local', '.node-local', 'node.local', '_node-local']) {
		assert.notEqual(memberStorageDbName(HASH, '~node-local'), memberStorageDbName(HASH, scope));
	}
	for (const bad of [
		() => memberStorageDbName('', 's1'),
		() => memberStorageDbName(/** @type {any} */ (42), 's1'),
		() => memberStorageDbName(HASH, 'a/b'),
		() => memberStorageDbName(HASH, ''),
	]) {
		assert.throws(bad, MemberNodeConfigError);
	}

	/** @type {unknown[][]} */
	const opened = [];
	const fakeHandle = { close() {} };
	const openSpy = /** @type {any} */ (
		async (/** @type {unknown[]} */ ...args) => {
			opened.push(args);
			return fakeHandle;
		}
	);
	class FakeRaw {
		async getMetadata() {
			return undefined;
		}
	}
	class FakeKv {
		async get() {
			return 'value';
		}
		async set() {}
		async delete() {}
		async flush() {}
		async close() {}
	}
	const platform = createMemberPlatform({
		networkHash: HASH,
		keyStore: new InMemoryKeyStore(),
		relayAddrs: [RELAY],
		strandId: STRAND,
		deps: { openOptimysticWebDb: openSpy, IndexedDBRawStorage: /** @type {any} */ (FakeRaw), IndexedDBKVStore: /** @type {any} */ (FakeKv) },
	});
	const first = platform.storage.rawStorage(STRAND);
	const second = platform.storage.rawStorage(STRAND);
	assert.equal(first, second, 'one proxy per scope until close');
	assert.equal(opened.length, 0, 'nothing opens before first use');
	await first.getMetadata(/** @type {any} */ ('block-1'));
	assert.equal(opened.length, 1);
	assert.equal(await platform.storage.nodeLocal().get('k'), 'value');
	assert.equal(opened.length, 2);
	for (const args of opened) {
		assert.ok(args.length >= 1, 'no zero-argument open');
		assert.ok(String(args[0]).startsWith('vt-member-'));
	}
	assert.equal(opened[0][0], memberStorageDbName(HASH, STRAND));
	assert.equal(opened[1][0], memberStorageDbName(HASH, '~node-local'));
	await platform.storage.close();
	assert.notEqual(platform.storage.rawStorage(STRAND), first, 'close drops the cached proxy');
});

test('7 relay validation: an empty or non-array list, whitespace, no peer id or a circuit address throw without echoing the entry', async () => {
	const bad = [
		[],
		'not-an-array',
		['/dns4/relay example/tcp/443/wss/p2p/12D3KooWX'],
		['/dns4/relay.example/tcp/443/wss'],
		['/dns4/relay.example/tcp/443/wss/p2p/12D3KooWX/p2p-circuit/p2p/12D3KooWY'],
	];
	for (const relayAddrs of bad) {
		const err = /** @type {Error} */ (rejectionSync(() => validateRelayAddrs(relayAddrs)));
		assert.ok(err instanceof MemberNodeConfigError);
		for (const entry of Array.isArray(relayAddrs) ? relayAddrs : [relayAddrs]) {
			assert.equal(err.message.includes(String(entry)), false, 'the message must not echo an entry');
		}
		const fake = fakeEdge();
		const viaNode = await rejection(
			createMemberNode({
				networkHash: HASH,
				keyStore: new InMemoryKeyStore(),
				relayAddrs: /** @type {any} */ (relayAddrs),
				strandId: STRAND,
				deps: { createEdgeNode: /** @type {any} */ (fake.createEdgeNode) },
			}),
		);
		assert.ok(viaNode instanceof MemberNodeConfigError);
		assert.equal(fake.edge.platform, null, 'no edge node is built over a bad relay list');
	}
	assert.deepEqual(validateRelayAddrs([RELAY]), [RELAY]);
});

test('8 claim and withdrawal: addStrand without a founder flag, unhandle before anyone hears the start, again on a rebuilt node, fail closed', async (t) => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	const gate = deferred();
	const lib = fakeLibp2p('StrandPeerOne', { unhandle: () => gate.promise });
	fake.strands.set(STRAND, { libp2pNode: lib });
	/** @type {string[]} */
	const order = [];
	member.on('strand:started', () => order.push('listener'));

	const waiting = member.waitForStrand(STRAND);
	waiting.then(() => order.push('resolved'));
	const addCalls = fake.calls.filter(([name]) => name === 'addStrand');
	assert.equal(addCalls.length, 1);
	const arg = addCalls[0][1];
	assert.equal(arg.awaitFirstSync, false);
	assert.equal(arg.strandRow.Type, 'o');
	assert.equal(arg.strandRow.Id, STRAND);
	assert.equal(arg.strandRow.MemberPrivateKey, null);
	assert.equal(arg.strandRow.FounderOwnerKey, null);
	assert.equal(arg.strandRow.FounderPeerId, null);
	assert.equal(arg.sAppConfig, MEMBER_SAPP_CONFIG);
	assert.equal('founder' in arg, false);

	fake.edge.fire('strand:started', { strandId: 'another-strand' });
	await settle();
	assert.equal(lib.unhandleCalls.length, 0, 'another strand is ignored');

	fake.edge.fire('strand:started', { strandId: STRAND });
	await settle();
	assert.deepEqual(lib.unhandleCalls, [[`/optimystic/strand-${STRAND}/cluster/1.0.0`, `/optimystic/strand-${STRAND}/repo/1.0.0`]]);
	assert.deepEqual(order, [], 'nothing resolves and nobody hears the start before unhandle resolved');
	gate.resolve();
	assert.equal(await waiting, lib);
	await settle();
	assert.deepEqual([...order].sort(), ['listener', 'resolved']);
	assert.equal(await member.waitForStrand(STRAND), lib, 'an already withdrawn strand resolves at once');

	const rebuilt = fakeLibp2p('StrandPeerTwo');
	fake.strands.set(STRAND, { libp2pNode: rebuilt });
	fake.edge.fire('strand:started', { strandId: STRAND });
	await settle();
	assert.equal(rebuilt.unhandleCalls.length, 1, 'a rebuilt strand node is withdrawn again');

	await assert.rejects(member.waitForStrand('another-strand'), (err) => err instanceof MemberNodeError && err.reason === 'not-configured');
	const aborted = new AbortController();
	fake.strands.set(STRAND, { libp2pNode: fakeLibp2p('StrandPeerThree') });
	aborted.abort();
	await assert.rejects(member.waitForStrand(STRAND, { signal: aborted.signal }), (err) => err instanceof MemberNodeError && err.reason === 'cancelled');
	const later = new AbortController();
	const pendingWait = member.waitForStrand(STRAND, { signal: later.signal });
	later.abort();
	await assert.rejects(pendingWait, (err) => err instanceof MemberNodeError && err.reason === 'cancelled');

	// Fail closed: an unhandle that rejects stops the node and rejects the waiter.
	const failing = fakeEdge();
	const failingMember = await memberOver(failing);
	failing.state.status = { state: 'running' };
	const boom = new Error('unhandle refused /optimystic/strand-x');
	boom.name = 'UnhandleRefusedError';
	failing.strands.set(STRAND, { libp2pNode: fakeLibp2p('StrandPeerBad', { unhandle: () => Promise.reject(boom) }) });
	/** @type {unknown[][]} */
	const lines = [];
	t.mock.method(console, 'warn', (/** @type {unknown[]} */ ...args) => lines.push(args));
	const failingWait = failingMember.waitForStrand(STRAND);
	failing.edge.fire('strand:started', { strandId: STRAND });
	await assert.rejects(failingWait, (err) => err instanceof MemberNodeError && err.reason === 'withdraw-failed');
	await settle();
	assert.ok(failing.calls.some(([name]) => name === 'stop'), 'the node was stopped');
	assert.deepEqual(lines, [[LOG_PREFIX, 'UnhandleRefusedError']]);
	t.mock.restoreAll();
});

test('9a getStrandDatabase: null before the claim, null while syncing, then exactly cadre-core\'s own object; null for another strand or no node', async () => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	assert.equal(member.getStrandDatabase(STRAND), null, 'no strand instance yet');
	const instance = { libp2pNode: fakeLibp2p('StrandPeerOne') };
	fake.strands.set(STRAND, instance);
	assert.equal(member.getStrandDatabase(STRAND), null, 'syncing: libp2p node but no database');
	const sentinel = { sentinel: 'cadre-core StrandDatabase' };
	Object.assign(instance, { database: sentinel });
	assert.strictEqual(member.getStrandDatabase(STRAND), sentinel);
	fake.strands.set('another-strand', { database: { other: true } });
	assert.equal(member.getStrandDatabase('another-strand'), null);
	fake.state.status = { state: 'stopped' };
	assert.equal(member.getStrandDatabase(STRAND), null, 'no running node gives null');
});

test('9 strandPeerCount counts distinct remote peers and strandPeerId is the strand node id, not the identity peer id', async () => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	const lib = fakeLibp2p('StrandPeerOne');
	lib.connections = [
		{ remotePeer: { toString: () => 'PeerA' } },
		{ remotePeer: { toString: () => 'PeerA' } },
		{ remotePeer: { toString: () => 'PeerB' } },
	];
	fake.strands.set(STRAND, { libp2pNode: lib });
	assert.equal(member.strandPeerCount(), 0, 'nothing counted before the withdrawal');
	fake.edge.fire('strand:started', { strandId: STRAND });
	await settle();
	assert.equal(member.strandPeerCount(), 2);
	assert.equal(member.strandPeerId(), 'StrandPeerOne');
	assert.equal(member.peerId, 'IdentityPeerX');
	assert.notEqual(member.strandPeerId(), member.peerId);
	assert.equal(member.getStrandNode(), lib);
	assert.equal(member.getControlNode(), fake.controlNode);
});

test('10 deleteMemberStorage: deletes exactly one network\'s member databases, twice over, and refuses a blocked delete', async (t) => {
	const hashA = uniqueHash();
	const hashB = `${hashA}-more`;
	const namesA = ['control-aa11', STRAND, '~node-local'].map((scope) => memberStorageDbName(hashA, scope));
	const namesB = ['control-aa11', STRAND].map((scope) => memberStorageDbName(hashB, scope));
	for (const name of [...namesA, ...namesB]) (await openOptimysticWebDb(name)).close();
	/** @param {string} name */
	const rawCreate = (name) =>
		new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.onsuccess = () => {
				request.result.close();
				resolve(undefined);
			};
			request.onerror = () => reject(request.error);
		});
	await rawCreate('vt-dashboard-keys');
	await rawCreate(`votetorrent-${hashA}`);
	const listed = async () => (await indexedDB.databases()).map((info) => info.name);

	await deleteMemberStorage(hashA);
	const after = await listed();
	for (const name of namesA) assert.equal(after.includes(name), false, 'network A member databases are gone');
	for (const name of namesB) assert.ok(after.includes(name), 'a network whose hash starts with A\'s is untouched');
	assert.ok(after.includes('vt-dashboard-keys'));
	assert.ok(after.includes(`votetorrent-${hashA}`));
	await deleteMemberStorage(hashA);

	const held = await openOptimysticWebDb(namesA[0]);
	const blocked = await Promise.race([
		deleteMemberStorage(hashA).then(
			() => 'resolved',
			(err) => err,
		),
		new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
	]);
	if (blocked instanceof MemberStorageBusyError) {
		t.diagnostic('blocked-delete path: fake-indexeddb fired onblocked for an open connection');
	} else {
		t.diagnostic(`blocked-delete path: injected indexedDB (fake-indexeddb gave ${String(blocked)})`);
		/** @type {any} */
		const injected = {
			databases: async () => [{ name: namesA[0], version: 3 }],
			deleteDatabase() {
				/** @type {any} */
				const request = {};
				queueMicrotask(() => request.onblocked?.());
				return request;
			},
		};
		await assert.rejects(deleteMemberStorage(hashA, { deps: { indexedDB: injected } }), MemberStorageBusyError);
	}
	held.close();
	await settle(2);
	await assert.rejects(deleteMemberStorage(hashA, { deps: { indexedDB: /** @type {any} */ ({}) } }), MemberNodeConfigError);
});

// ── Task 3: identity, join, resume, events, stop, hygiene ───────────────────

test('11 construction creates the identity through the real cadre-core identityPeerId, before any join', async () => {
	const inner = new InMemoryKeyStore();
	/** @type {string[]} */
	const keyCalls = [];
	const recording = {
		/** @param {string} id */
		get: (id) => {
			keyCalls.push(`get:${id}`);
			return inner.get(id);
		},
		/** @param {string} id @param {Uint8Array} bytes */
		set: (id, bytes) => {
			keyCalls.push(`set:${id}`);
			return inner.set(id, bytes);
		},
		/** @param {string} id */
		delete: (id) => inner.delete(id),
		list: () => inner.list(),
	};
	const member = await createMemberNode({ networkHash: uniqueHash(), keyStore: recording, relayAddrs: [RELAY], strandId: STRAND });
	assert.equal(typeof member.peerId, 'string');
	assert.ok(member.peerId.length > 20);
	assert.deepEqual(await inner.list(), [DEFAULT_IDENTITY_KEY_ID]);
	assert.ok(keyCalls.includes(`set:${DEFAULT_IDENTITY_KEY_ID}`), 'the identity was created and persisted');
	assert.equal(member.status(), 'stopped', 'nothing started');
	await member.stop();
});

test('12 key first: the identity is read from the key store before the invitation is redeemed', async () => {
	/** @type {string[]} */
	const order = [];
	const fake = fakeEdge({ order });
	const inner = new InMemoryKeyStore();
	await inner.set(DEFAULT_IDENTITY_KEY_ID, new Uint8Array([8, 1, 18, 64, 9]));
	const keyStore = {
		/** @param {string} id */
		get: (id) => {
			order.push(`keyStore.get:${id}`);
			return inner.get(id);
		},
		/** @param {string} id @param {Uint8Array} b */
		set: (id, b) => inner.set(id, b),
		/** @param {string} id */
		delete: (id) => inner.delete(id),
		list: () => inner.list(),
	};
	const member = await memberOver(fake, { keyStore });
	const { encoded } = makeInvitation();
	assert.equal(await member.joinCadre(encoded), 'joined');
	const keyRead = order.indexOf(`keyStore.get:${DEFAULT_IDENTITY_KEY_ID}`);
	const redeem = order.indexOf('edge.joinCadre');
	assert.ok(keyRead >= 0 && redeem > keyRead, `order was ${order.join(' > ')}`);
});

/** @param {unknown} err @param {string} reason */
function isReason(err, reason) {
	return err instanceof MemberNodeError && err.reason === reason;
}

test('13 join reasons: malformed, not-invitation, party-mismatch, spent, invalid, unreachable, cancelled and owner-key', async () => {
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre('not an invitation at all')), 'malformed'));
		assert.ok(isReason(await rejection(member.joinCadre(/** @type {any} */ (42))), 'malformed'));
		assert.equal(fake.calls.some(([name]) => name === 'joinCadre'), false);
	}
	{
		const fake = fakeEdge();
		const member = await memberOver(fake, { deps: { isOwnerGrant: () => true } });
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'not-invitation'));
		assert.equal(fake.calls.some(([name]) => name === 'joinCadre' || name === 'loadSavedStart'), false);
	}
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation({ totalUses: 2 }).encoded)), 'not-invitation'));
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation({ totalUses: null }).encoded)), 'not-invitation'));
		assert.equal(fake.calls.some(([name]) => name === 'joinCadre'), false);
	}
	{
		const fake = fakeEdge();
		fake.state.savedStart = { options: { partyId: 'party-b', origin: 'joined', bootstrapAddrs: [], relayAddrs: [] }, autoStart: true };
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'party-mismatch'));
		assert.equal(fake.calls.some(([name]) => name === 'joinCadre' || name === 'start'), false);
	}
	for (const [error, reason] of /** @type {Array<[any, string]>} */ ([
		[new CadreInviteRejectedError('invite-spent', 'spent'), 'spent'],
		[new CadreInviteRejectedError('invite-invalid', 'bad'), 'invalid'],
		[new CadreInviteRejectedError('issuer-unknown', 'who'), 'unreachable'],
		[new Error('socket closed'), 'unreachable'],
	])) {
		const fake = fakeEdge();
		fake.state.joinError = error;
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), reason), reason);
	}
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		const controller = new AbortController();
		controller.abort();
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded, { signal: controller.signal })), 'cancelled'));
		const racing = fakeEdge();
		const racingMember = await memberOver(racing);
		const later = new AbortController();
		racing.state.joinError = new Error('aborted');
		const original = racing.edge.joinCadre;
		racing.edge.joinCadre = async (credential, opts) => {
			later.abort();
			return original.call(racing.edge, credential, opts);
		};
		assert.ok(isReason(await rejection(racingMember.joinCadre(makeInvitation().encoded, { signal: later.signal })), 'cancelled'));
	}
	{
		const fake = fakeEdge();
		fake.state.joinResult = { peerId: 'IdentityPeerX', redeemedAt: 1, asOwner: true };
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'owner-key'));
		assert.ok(fake.calls.some(([name]) => name === 'stop'), 'the node is stopped after an owner join');
	}
	{
		const fake = fakeEdge();
		fake.state.ownerKey = 'b64url-owner-public-key';
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'owner-key'));
		assert.ok(fake.calls.some(([name]) => name === 'stop'));
	}
	{
		const fake = fakeEdge();
		const keyStore = new InMemoryKeyStore();
		const member = await memberOver(fake, { keyStore });
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'invalid'), 'no identity in the store');
		assert.equal(fake.calls.some(([name]) => name === 'joinCadre'), false);
	}
});

test('14 success: joined, with the constructor relays and an onProgress that forwards { state } only', async () => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	/** @type {unknown[]} */
	const progress = [];
	const { invitation, encoded } = makeInvitation();
	assert.equal(await member.joinCadre(encoded, { onProgress: (p) => progress.push(p) }), 'joined');
	const call = fake.calls.find(([name]) => name === 'joinCadre');
	assert.ok(call);
	assert.equal(call[1].partyId, invitation.partyId);
	assert.deepEqual(call[2].relayAddrs, [RELAY]);
	assert.deepEqual(progress, [{ state: 'admitted' }]);
	assert.equal(fake.calls.some(([name]) => name === 'start'), false, 'a join starts through cadre-core\'s joinCadre, not start');
});

test('15 already member: a saved joined start of the same party resumes and answers already-member without redeeming', async () => {
	const fake = fakeEdge();
	fake.state.savedStart = { options: { partyId: 'party-a', origin: 'joined', bootstrapAddrs: [], relayAddrs: ['/dns4/old/tcp/1/wss/p2p/X'] }, autoStart: true };
	fake.state.authorized = true;
	const member = await memberOver(fake);
	assert.equal(await member.joinCadre(makeInvitation().encoded), 'already-member');
	const starts = fake.calls.filter(([name]) => name === 'start');
	assert.equal(starts.length, 1);
	assert.equal(starts[0][1].origin, 'joined');
	assert.equal(fake.calls.some(([name]) => name === 'joinCadre'), false, 'the invitation was not consumed');
	assert.ok(fake.calls.some(([name, peer]) => name === 'isAuthorizedMember' && peer === 'IdentityPeerX'));

	const notYet = fakeEdge();
	notYet.state.savedStart = fake.state.savedStart;
	notYet.state.authorized = false;
	const second = await memberOver(notYet);
	assert.equal(await second.joinCadre(makeInvitation().encoded), 'joined');
	assert.equal(notYet.calls.filter(([name]) => name === 'joinCadre').length, 1);
});

test('16 resume: only a saved joined start runs, always with the code\'s relays; removed reads removed', async () => {
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		assert.equal(await member.resume(), 'not-paired');
		assert.equal(fake.calls.some(([name]) => name === 'start'), false);
	}
	for (const origin of [undefined, 'founded']) {
		const fake = fakeEdge();
		fake.state.savedStart = { options: { partyId: 'party-a', bootstrapAddrs: [], relayAddrs: [], ...(origin ? { origin } : {}) }, autoStart: true };
		const member = await memberOver(fake);
		assert.equal(await member.resume(), 'not-paired');
		assert.equal(fake.calls.some(([name]) => name === 'start'), false, `origin ${origin} never starts`);
	}
	{
		const fake = fakeEdge();
		fake.state.savedStart = {
			options: { partyId: 'party-a', origin: 'joined', bootstrapAddrs: [], relayAddrs: ['/dns4/stale/tcp/443/wss/p2p/Old'] },
			autoStart: false,
		};
		const member = await memberOver(fake);
		assert.equal(await member.resume(), 'running');
		const start = fake.calls.find(([name]) => name === 'start');
		assert.ok(start);
		assert.equal(start[1].origin, 'joined');
		assert.deepEqual(start[1].relayAddrs, [RELAY]);
		assert.equal(member.status(), 'running');
		assert.equal(await member.resume(), 'running');
		assert.equal(fake.calls.filter(([name]) => name === 'start').length, 1, 'a running node is not started twice');
		fake.edge.fire('cadre:removed', { partyId: 'party-a', stampId: 's', signerKey: null, at: 1 });
		assert.equal(await member.resume(), 'removed');
	}
	{
		const fake = fakeEdge();
		fake.state.savedStart = { options: { partyId: 'party-a', origin: 'joined', bootstrapAddrs: [], relayAddrs: [] }, autoStart: true };
		fake.edge.start = async () => {
			throw new Error('dial failed');
		};
		const member = await memberOver(fake);
		assert.ok(isReason(await rejection(member.resume()), 'unreachable'));
	}
});

test('17 events: control and removal events reach listeners, unsubscribe works, a throwing listener does not stop the next', async () => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	/** @type {string[]} */
	const heard = [];
	const off = member.on('control:connected', () => heard.push('connected-1'));
	member.on('control:connected', () => {
		throw new Error('listener bug');
	});
	member.on('control:connected', () => heard.push('connected-3'));
	member.on('control:disconnected', () => heard.push('disconnected'));
	/** @type {unknown[]} */
	const removals = [];
	member.on('cadre:removed', (removal) => removals.push(removal));
	const warn = console.warn;
	console.warn = () => {};
	try {
		fake.edge.fire('control:connected', undefined);
		off();
		fake.edge.fire('control:connected', undefined);
	} finally {
		console.warn = warn;
	}
	fake.edge.fire('control:disconnected', undefined);
	const removal = { partyId: 'party-a', stampId: 's1', signerKey: null, at: 5 };
	fake.edge.fire('cadre:removed', removal);
	assert.deepEqual(heard, ['connected-1', 'connected-3', 'connected-3', 'disconnected']);
	assert.deepEqual(removals, [removal]);
	assert.throws(() => member.on(/** @type {any} */ ('other'), () => {}), MemberNodeConfigError);
});

test('18 removal and stop: no edge stop after a removal, reconnect is a no-op, waiters reject, no database; stop is shared; reconnect reconciles', async () => {
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		fake.state.status = { state: 'running' };
		const instance = { libp2pNode: fakeLibp2p('StrandPeerOne'), database: { sentinel: true } };
		fake.strands.set(STRAND, instance);
		fake.state.addStrandError = null;
		// A pending waiter: the strand has not started yet in the member node's eyes.
		const pending = member.waitForStrand(STRAND);
		fake.edge.fire('cadre:removed', { partyId: 'party-a', stampId: 's', signerKey: null, at: 1 });
		fake.state.status = { state: 'removed' };
		assert.ok(isReason(await rejection(pending), 'not-running'));
		assert.equal(member.getStrandDatabase(STRAND), null, 'no database after a removal');
		await member.reconnect();
		await member.stop();
		assert.equal(fake.calls.some(([name]) => name === 'stop' || name === 'start' || name === 'reconcileControlCohort'), false);
		assert.ok(isReason(await rejection(member.joinCadre(makeInvitation().encoded)), 'removed'));
		assert.equal(member.status(), 'removed');
	}
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		fake.state.status = { state: 'running' };
		fake.strands.set(STRAND, { libp2pNode: fakeLibp2p('StrandPeerOne'), database: { sentinel: true } });
		assert.ok(member.getStrandDatabase(STRAND));
		await member.reconnect();
		assert.equal(fake.calls.filter(([name]) => name === 'reconcileControlCohort').length, 1);
		fake.state.reconcileError = new Error('cohort unreachable');
		const warn = console.warn;
		console.warn = () => {};
		try {
			await member.reconnect();
		} finally {
			console.warn = warn;
		}
		await Promise.all([member.stop(), member.stop()]);
		assert.equal(fake.calls.filter(([name]) => name === 'stop').length, 1, 'two concurrent stops stop once');
		fake.state.status = { state: 'running' };
		assert.equal(member.getStrandDatabase(STRAND), null, 'no database after stop, even if the instance still has one');
		assert.ok(isReason(await rejection(member.waitForStrand(STRAND)), 'not-running'));
	}
	{
		const fake = fakeEdge();
		fake.state.savedStart = { options: { partyId: 'party-a', origin: 'joined', bootstrapAddrs: [], relayAddrs: [] }, autoStart: false };
		const member = await memberOver(fake);
		await member.reconnect();
		assert.equal(fake.calls.filter(([name]) => name === 'start').length, 1, 'a stopped node reconnects by resuming');
		await member.stop();
		await member.reconnect();
		assert.equal(fake.calls.filter(([name]) => name === 'start').length, 2, 'a stopped member resumes again');
		assert.equal(member.status(), 'running');
	}
});

test('19 bearer and PII hygiene: no log line or error message carries the invitation, its private key, the party id or the network hash', async (t) => {
	/** @type {unknown[][]} */
	const lines = [];
	for (const method of /** @type {const} */ (['warn', 'error', 'log', 'info', 'debug'])) {
		t.mock.method(console, method, (/** @type {unknown[]} */ ...args) => lines.push(args));
	}
	const { invitation, encoded } = makeInvitation();
	const secretBearingError = new Error(`refused ${encoded} ${invitation.invitePrivateKey} ${invitation.partyId} ${HASH}`);
	/** @type {unknown[]} */
	const errors = [];
	const scenarios = /** @type {Array<(fake: ReturnType<typeof fakeEdge>) => void>} */ ([
		(fake) => {
			fake.state.joinError = secretBearingError;
		},
		(fake) => {
			fake.state.joinError = new CadreInviteRejectedError('invite-spent', `spent ${encoded}`);
		},
		(fake) => {
			fake.state.joinResult = { asOwner: true };
		},
		(fake) => {
			fake.state.savedStart = { options: { partyId: 'party-b', origin: 'joined', bootstrapAddrs: [], relayAddrs: [] }, autoStart: true };
		},
		(fake) => {
			fake.state.savedStart = { options: { partyId: 'party-a', origin: 'joined', bootstrapAddrs: [], relayAddrs: [] }, autoStart: true };
			fake.edge.start = async () => {
				throw secretBearingError;
			};
		},
	]);
	for (const arrange of scenarios) {
		const fake = fakeEdge();
		arrange(fake);
		const member = await memberOver(fake);
		errors.push(await rejection(member.joinCadre(encoded)));
	}
	{
		const fake = fakeEdge();
		const member = await memberOver(fake);
		errors.push(await rejection(member.joinCadre(`${encoded}garbage`)));
		fake.state.status = { state: 'running' };
		fake.strands.set(STRAND, { libp2pNode: fakeLibp2p('S', { unhandle: () => Promise.reject(secretBearingError) }) });
		const waiting = member.waitForStrand(STRAND);
		fake.edge.fire('strand:started', { strandId: STRAND });
		errors.push(await rejection(waiting));
	}
	t.mock.restoreAll();

	const banned = [encoded, invitation.invitePrivateKey, invitation.partyId, HASH];
	assert.ok(lines.length >= 4, `expected the failure cases to log, got ${lines.length}`);
	for (const line of lines) {
		assert.equal(line[0], LOG_PREFIX);
		assert.ok(line.length === 2 || line.length === 3, 'prefix, error name and at most a closed code');
		assert.match(String(line[1]), /^[A-Za-z]*Error$/);
		if (line.length === 3) assert.ok(['invite-spent', 'invite-invalid', 'issuer-unknown'].includes(String(line[2])));
		const text = line.map(String).join(' ');
		for (const token of banned) assert.equal(text.includes(token), false, 'a log line carries a banned token');
	}
	assert.equal(errors.length, scenarios.length + 2);
	for (const err of errors) {
		assert.ok(err instanceof MemberNodeError);
		for (const token of banned) assert.equal(err.message.includes(token), false, 'an error message carries a banned token');
	}
});

test('20 source scan: joined-only start, no owner-key or owner-grant method, no founder origin, no console.log, no node globals, no StrandDatabase construction', () => {
	const code = stripComments(readFileSync(dashboardSrc('peer', 'member-node.js'), 'utf8'));
	const banned = [
		"origin: 'found" + "ed'",
		'create' + 'OwnerGrant',
		'import' + 'OwnerKey',
		'export' + 'OwnerKey',
		'redeem' + 'OwnerGrant',
		'remove' + 'Owner',
		'dissolve' + 'FormerParty',
		'console' + '.log',
		'Buf' + 'fer',
		"from 'no" + "de:",
		'import.me' + 'ta.env',
		'Strand' + 'ChangeHub',
		'new Strand' + 'Database',
	];
	for (const token of banned) assert.equal(code.includes(token), false, `member-node.js contains a banned token (${token.length} chars)`);
	assert.doesNotMatch(code, new RegExp('import\\s*\\{[^}]*Strand' + 'Database'));
	assert.equal(code.split('.st' + 'art(').length - 1, 1, 'the edge node is started in exactly one place');
	assert.match(code, /async function startJoined\([^)]*\)\s*\{[\s\S]*?edge\.start\(\{ \.\.\.options, origin: 'joined'/);
	assert.match(code, /createEdgeNode as createCadreEdgeNode/);
	// Positive control: the comment stripper keeps code and a banned token in code is found.
	assert.ok(stripComments(`x.${'remove' + 'Owner'}(k); // note`).includes('remove' + 'Owner'));
});

// ── The dashboard's strand node declares itself an edge reader and seeds nobody ──

/**
 * A strand libp2p fake that records handle/unhandle/push in one ordered log.
 *
 * @param {{ handle?: () => Promise<void>, push?: 'send' | 'push' | 'throw' | 'absent' | 'hang', declared?: boolean }} [options]
 */
function edgeReaderLibp2p(options = {}) {
	/** @type {string[]} */
	const log = [];
	/** @type {any} */
	let marker = null;
	const pushMode = options.push ?? 'send';
	/** @type {any} */
	const identifyPush = {};
	if (pushMode === 'send') identifyPush.sendPushMessage = async () => { log.push('push:send'); };
	if (pushMode === 'push') identifyPush.push = async () => { log.push('push:debounced'); };
	if (pushMode === 'throw') identifyPush.sendPushMessage = async () => { log.push('push:throw'); throw new Error('push refused'); };
	if (pushMode === 'hang') identifyPush.sendPushMessage = () => { log.push('push:hang'); return new Promise(() => {}); };
	return {
		log,
		get marker() { return marker; },
		peerId: { toString: () => 'StrandPeerEdge' },
		services: pushMode === 'absent' ? {} : { identifyPush },
		/** @param {string} protocol @param {any} handler */
		handle(protocol, handler) {
			log.push(`handle:${protocol}`);
			marker = handler;
			return options.handle ? options.handle() : Promise.resolve();
		},
		/** @param {string[]} protocols */
		unhandle(protocols) {
			log.push(`unhandle:${protocols.length}`);
			return Promise.resolve();
		},
		getConnections() { return []; },
		...(options.declared === true ? { getProtocols: () => ['/votetorrent/edge-reader/1.0.0'] } : {}),
	};
}

test('21 configure: the dashboard withholds its strand addresses (a member that stores nothing seeds nobody)', () => {
	const base = /** @type {any} */ ({ profile: 'transaction' });
	const platform = /** @type {any} */ (createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY], strandId: STRAND }));
	const cfg = platform.configure(base);
	assert.equal(cfg.withholdStrandAddrs, true);
	const barePlatform = /** @type {any} */ (createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY] }));
	const bare = barePlatform.configure(base);
	assert.equal(bare.withholdStrandAddrs, true);
	assert.equal('strandCohortRefusal' in cfg, false, 'the dashboard refuses nobody itself');
});

test('22 strand:started: the marker is handled before the storage protocols go, then an immediate identify push, then waiters resolve', async (t) => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	const lib = edgeReaderLibp2p();
	fake.strands.set(STRAND, { libp2pNode: lib });
	/** @type {string[]} */
	const order = [];
	member.on('strand:started', () => order.push('listener'));
	const waiting = member.waitForStrand(STRAND).then((n) => { order.push('resolved'); return n; });
	fake.edge.fire('strand:started', { strandId: STRAND });
	assert.equal(await waiting, lib);
	await settle();
	assert.deepEqual(lib.log, ['handle:/votetorrent/edge-reader/1.0.0', 'unhandle:2', 'push:send']);
	assert.deepEqual([...order].sort(), ['listener', 'resolved']);
	// The marker handler closes any stream at once.
	let aborted = 0;
	lib.marker({ abort: () => { aborted += 1; } });
	assert.equal(aborted, 1);

	// Falls back to the debounced push when the immediate one is not there.
	for (const mode of /** @type {const} */ (['push', 'absent', 'throw'])) {
		const f = fakeEdge();
		const m = await memberOver(f, { networkHash: uniqueHash() });
		f.state.status = { state: 'running' };
		const l = edgeReaderLibp2p({ push: mode });
		f.strands.set(STRAND, { libp2pNode: l });
		/** @type {unknown[][]} */
		const lines = [];
		t.mock.method(console, 'warn', (/** @type {unknown[]} */ ...args) => lines.push(args));
		const w = m.waitForStrand(STRAND);
		f.edge.fire('strand:started', { strandId: STRAND });
		assert.equal(await w, l, `a ${mode} push still resolves the waiters`);
		assert.equal(l.log[0], 'handle:/votetorrent/edge-reader/1.0.0');
		assert.equal(l.log[1], 'unhandle:2');
		if (mode === 'push') assert.equal(l.log[2], 'push:debounced');
		if (mode === 'throw') assert.deepEqual(lines, [[LOG_PREFIX, 'Error']], 'a failed push is logged by name only');
		else assert.deepEqual(lines, []);
		t.mock.restoreAll();
	}
});

test('22b a failing marker handle stops the node and rejects withdraw-failed before anything is unhandled', async (t) => {
	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	const refused = new Error('handle refused');
	refused.name = 'HandleRefusedError';
	const lib = edgeReaderLibp2p({ handle: () => Promise.reject(refused) });
	fake.strands.set(STRAND, { libp2pNode: lib });
	/** @type {unknown[][]} */
	const lines = [];
	t.mock.method(console, 'warn', (/** @type {unknown[]} */ ...args) => lines.push(args));
	const waiting = member.waitForStrand(STRAND);
	fake.edge.fire('strand:started', { strandId: STRAND });
	await assert.rejects(waiting, (err) => err instanceof MemberNodeError && err.reason === 'withdraw-failed');
	await settle();
	assert.deepEqual(lib.log, ['handle:/votetorrent/edge-reader/1.0.0']);
	assert.ok(fake.calls.some(([name]) => name === 'stop'), 'the node was stopped');
	assert.deepEqual(lines, [[LOG_PREFIX, 'HandleRefusedError']]);
	t.mock.restoreAll();
});

test('22c R-G4: configure asks cadre-core to declare the marker from the first identify, and a declared node is not handled twice', async () => {
	const base = /** @type {any} */ ({ profile: 'transaction' });
	const cfg = /** @type {any} */ (createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY], strandId: STRAND })).configure(base);
	assert.equal(cfg.edgeReaderProtocol, '/votetorrent/edge-reader/1.0.0');
	const bare = /** @type {any} */ (createMemberPlatform({ networkHash: HASH, keyStore: new InMemoryKeyStore(), relayAddrs: [RELAY] })).configure(base);
	assert.equal(bare.edgeReaderProtocol, '/votetorrent/edge-reader/1.0.0');

	const fake = fakeEdge();
	const member = await memberOver(fake);
	fake.state.status = { state: 'running' };
	const lib = edgeReaderLibp2p({ declared: true });
	fake.strands.set(STRAND, { libp2pNode: lib });
	const waiting = member.waitForStrand(STRAND);
	fake.edge.fire('strand:started', { strandId: STRAND });
	assert.equal(await waiting, lib);
	await settle();
	assert.deepEqual(lib.log, ['unhandle:2', 'push:send'], 'already declared by cadre-core: no second handle');
});

test('23 parity: the marker literal equals vote-engine EDGE_READER_PROTOCOL (source text)', () => {
	const engine = readFileSync(workspacePath('packages/vote-engine', 'src', 'network', 'edge-reader-refusal.ts'), 'utf8');
	const expected = (engine.match(/export const EDGE_READER_PROTOCOL = '([^']+)'/) ?? [])[1];
	assert.equal(expected, '/votetorrent/edge-reader/1.0.0');
	const code = stripComments(readFileSync(dashboardSrc('peer', 'member-node.js'), 'utf8'));
	const ours = (code.match(/const EDGE_READER_PROTOCOL = '([^']+)'/) ?? [])[1];
	assert.equal(ours, expected);
	assert.equal(code.includes('withholdStrandAddrs: true'), true);
});

// ── 66-29: a removed member node closes its storage before the wipe (DEFECT-66-26-02) ──

/**
 * Counting web-db fakes: every handle the platform opens is tallied per name, and so is every close.
 */
function countingWebDb() {
	/** @type {Map<string, number>} */
	const opens = new Map();
	/** @type {Map<string, number>} */
	const closes = new Map();
	const openOptimysticWebDb = async (/** @type {string} */ name) => {
		opens.set(name, (opens.get(name) ?? 0) + 1);
		let closed = false;
		return {
			close() {
				if (closed) return;
				closed = true;
				closes.set(name, (closes.get(name) ?? 0) + 1);
			},
		};
	};
	class FakeRaw {
		async getMetadata() {
			return undefined;
		}
	}
	class FakeKv {
		async get() {
			return undefined;
		}
		async set() {}
		async delete() {}
		async flush() {}
		async close() {}
	}
	const total = (/** @type {Map<string, number>} */ map) => [...map.values()].reduce((a, b) => a + b, 0);
	return {
		opens,
		closes,
		openCount: () => total(opens),
		closeCount: () => total(closes),
		deps: { openOptimysticWebDb, IndexedDBRawStorage: FakeRaw, IndexedDBKVStore: FakeKv },
	};
}

/**
 * The shape of cadre-core's `forgetRemovedParty`, over a few macrotasks: `shutDown` closes the
 * platform storage and reports `stopped`, `leaveRemovedStart` and the dissolve marker RE-OPEN the
 * node-local database, then the status reads `removed` (unless `reachRemoved` is false).
 *
 * @param {ReturnType<typeof fakeEdge>} fake
 * @param {{ reachRemoved?: boolean }} [options]
 */
async function cadreRemovalTransition(fake, { reachRemoved = true } = {}) {
	const storage = fake.edge.platform.storage;
	await settle(1);
	await storage.close();
	fake.edge.setStatus({ state: 'stopped' });
	await settle(1);
	await storage.nodeLocal().set('saved-start', new Uint8Array([1]));
	await storage.nodeLocal().flush();
	await settle(1);
	if (reachRemoved) fake.edge.setStatus({ state: 'removed', partyId: 'party-a' });
}

const REMOVAL = Object.freeze({ partyId: 'party-a', stampId: 's', signerKey: null, at: 1 });

test('24 M-R1 removal settle: stop() resolves only after cadre-core\'s removal reads removed, with every member handle closed', async () => {
	const counting = countingWebDb();
	const fake = fakeEdge();
	const member = await memberOver(fake, { networkHash: uniqueHash(), deps: counting.deps });
	fake.state.status = { state: 'running' };
	const storage = fake.edge.platform.storage;
	await storage.nodeLocal().get('k');
	await storage.rawStorage(STRAND).getMetadata(/** @type {any} */ ('block-1'));
	assert.equal(counting.openCount(), 2, 'the node-local view and one raw scope are open');

	fake.edge.fire('cadre:removed', REMOVAL);
	const transition = cadreRemovalTransition(fake);
	await member.stop();
	assert.equal(fake.edge.status.state, 'removed', 'stop() resolved only after the removal settled');
	assert.ok(counting.openCount() >= 3, 'the transition re-opened the node-local database');
	assert.equal(counting.closeCount(), counting.openCount(), 'every handle the platform opened is closed when stop() resolves');
	assert.equal(fake.calls.some(([name]) => name === 'stop'), false, 'no edge stop on the removed path');
	await transition;
	assert.equal(fake.statusListeners.size, 0, 'the settle listener unsubscribed');
});

test('24b M-R2 removal settle over fake-indexeddb: after stop(), deleteMemberStorage resolves and lists no member database', async (t) => {
	const hash = uniqueHash();
	const fake = fakeEdge();
	const member = await memberOver(fake, { networkHash: hash });
	fake.state.status = { state: 'running' };
	const storage = fake.edge.platform.storage;
	await storage.nodeLocal().set('k', new Uint8Array([2]));
	await storage.nodeLocal().flush();

	fake.edge.fire('cadre:removed', REMOVAL);
	const transition = cadreRemovalTransition(fake);
	await member.stop();
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let bound;
	const outcome = await Promise.race([
		deleteMemberStorage(hash).then(
			() => 'resolved',
			(err) => err,
		),
		new Promise((resolve) => {
			bound = setTimeout(() => resolve('timeout'), 2000);
		}),
	]);
	clearTimeout(bound);
	await transition;
	if (outcome instanceof MemberStorageBusyError) t.diagnostic('fake-indexeddb fired onblocked for a connection stop() left open');
	else if (outcome === 'timeout') t.diagnostic('fake-indexeddb queued the delete behind a connection stop() left open (no onblocked)');
	assert.equal(outcome, 'resolved', 'the delete met no open connection of this tab');
	const names = (await indexedDB.databases()).map((info) => info.name);
	assert.equal(names.some((name) => typeof name === 'string' && name.startsWith(`vt-member-${hash}-`)), false, 'no member database of this hash is listed');
});

test('24c M-R3 a removal that never settles: stop() resolves within the injected bound, still closes the storage, and logs once by name', async () => {
	const counting = countingWebDb();
	const fake = fakeEdge();
	const member = await memberOver(fake, { networkHash: uniqueHash(), deps: { ...counting.deps, removalSettleMs: 50 } });
	fake.state.status = { state: 'running' };
	await fake.edge.platform.storage.nodeLocal().get('k');

	/** @type {unknown[][]} */
	const warned = [];
	const warn = console.warn;
	console.warn = (/** @type {unknown[]} */ ...args) => warned.push(args);
	const started = Date.now();
	try {
		fake.edge.fire('cadre:removed', REMOVAL);
		const transition = cadreRemovalTransition(fake, { reachRemoved: false });
		await member.stop();
		await transition;
	} finally {
		console.warn = warn;
	}
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 1000, `stop() resolved within the injected bound (${elapsed} ms)`);
	assert.equal(fake.edge.status.state, 'stopped', 'the transition never reached removed or failed');
	assert.equal(counting.closeCount(), counting.openCount(), 'the storage is closed even though the removal never settled');
	assert.deepEqual(warned, [[LOG_PREFIX, 'MemberNodeError']], 'exactly one line, by name only');
	assert.equal(fake.statusListeners.size, 0, 'the settle listener unsubscribed');
});

test('24d M-R3b no wait: a status that already reads removed is settled now, under the production bound; a removal with no stop arms no timer', async () => {
	const memberNodeModule = await import('../../src/peer/member-node.js');
	assert.equal(/** @type {any} */ (memberNodeModule).REMOVAL_SETTLE_MAX_MS, 20_000, 'the production bound');
	{
		const counting = countingWebDb();
		const fake = fakeEdge();
		const member = await memberOver(fake, { networkHash: uniqueHash(), deps: counting.deps });
		fake.state.status = { state: 'running' };
		await fake.edge.platform.storage.nodeLocal().get('k');
		fake.edge.fire('cadre:removed', REMOVAL);
		fake.state.status = { state: 'removed' };
		const started = Date.now();
		await member.stop();
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 200, `an already-removed status is not waited on (${elapsed} ms)`);
		assert.ok(counting.openCount() >= 1);
		assert.equal(counting.closeCount(), counting.openCount(), 'the platform storage is closed');
		assert.equal(fake.calls.some(([name]) => name === 'stop'), false, 'no edge stop on the removed path');
	}
	{
		const fake = fakeEdge();
		await memberOver(fake, { networkHash: uniqueHash() });
		fake.state.status = { state: 'running' };
		fake.edge.fire('cadre:removed', REMOVAL);
		// stop() is never called: the handler armed no timer, so this test (and the file) ends on its own.
		assert.equal(fake.statusListeners.size, 1, 'the handler subscribed a status listener, not a timer');
	}
});
