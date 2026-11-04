/**
 * live-gate.tsx -- the live dashboard's browser gate page: the REAL shell,
 * boot, strand reader, replication bridge, local store, registry, status
 * reducer, chip, panels, change marks, pairing screen and scanner, with ONLY
 * the peer layer replaced.
 *
 * WHAT IS FAKE, AND WHERE IT ENTERS. Four boot dependencies, passed through
 * the shell's `bootDeps` prop (which the shell forwards verbatim to
 * `startDashboardBoot({ deps })`), and the pairing screen's `loadPairing`
 * prop. Nothing else:
 *   - `createMemberNode`: a fake member node (C-12 shape) whose control
 *     connections, strand peers, reconnects and stop are driven by the
 *     runner, and whose `getStrandDatabase` hands the REAL strand reader a
 *     scratch in-memory Quereus database (the "strand image") seeded by the
 *     same fixtures `gate-matrix.tsx` uses;
 *   - `createIdbKeyStore`: an inert stand-in (the fake node never signs);
 *   - `startOfficerReplication`: the REAL bridge, called with one extra dep,
 *     `createTailReader` (the real one needs a libp2p transactor), and with
 *     `onPass` and the handle observed for the event log;
 *   - `checkPairingStillValid`: scripted, `{ ok: true }` unless set.
 * The boot keeps its real `attachLiveDb`, registry, `recordLastPassAt`,
 * `subscribeToOfficerChanges`, `wipeNetwork`, Web Locks and BroadcastChannel,
 * and its real default `openStrandReader`, which polls the fake node's
 * `getStrandDatabase`. A held pass is a strand database that is not
 * published yet (null), exactly what the reader waits through before a
 * strand header arrives. A wake is the bridge's own recorded watch
 * `onChange`, which is the production wake path.
 *
 * WHAT THIS PAGE DOES NOT PROVE. No libp2p, no cadre-core, no relay, no
 * cohort: those are 66-26's real-node gate. The strand image answers the
 * reader's one query shape (`select * from <table>`) from a row map so that
 * the runner can change one value without fighting the schema's own write
 * checks; every other query reaches the real in-memory database.
 *
 * SIDE EFFECTS ON IMPORT. Only the stylesheet import above (it carries the
 * design tokens and the component sheets). The driver (`runLiveGate`) runs
 * only when `<html data-gate="live-gate">`, so `compose-gate.tsx` and
 * `shell-gate.js` import these pieces without running it.
 *
 * HYGIENE. No fixture value and no pairing code is ever written to the
 * console. A failure lands in `window.__LIVE_GATE__.failed` as an error name
 * and a fixed message.
 */
import '../../src/app.css';
import { StrictMode, useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';
import { t } from '@votetorrent/ui-web';
import {
	attachLiveDb,
	closeNetworkDb,
	deleteNetworkDb,
	findNetwork,
	isLegacyEntry,
	listNetworks,
	OFFICER_SUBSCRIBED_TABLES,
	removeNetwork,
	upsertNetwork,
} from '@votetorrent/web-data/officer';
import { DashboardShell } from '../../src/screens/DashboardShell.js';
import { Pairing, routeFromRegistry } from '../../src/screens/Pairing.js';
import type {
	PairBrowserOptions,
	PairingHandoff,
	PairingModule,
	PairResult,
	SwapRequest,
	UnpairedNotice,
} from '../../src/screens/Pairing.js';
import { adaptDecoderModule } from '../../src/screens/QrScanner.js';
import { SCOPE_CODES } from '../../src/auth/capabilities.js';
import { seedFoundingAuthority } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import { seedElectionSurface } from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

// ---------------------------------------------------------------------------
// The peer modules, loaded lazily
// ---------------------------------------------------------------------------

/**
 * The shipped peer modules this page uses. They load through `import()`, as
 * the app loads them: a static import from the gate entry puts the `peer`
 * manual chunk in an initialisation cycle with the entry (measured: a
 * "Circular chunk" build warning, then a TDZ ReferenceError in the peer
 * chunk at load). Call `loadPeerModules()` before `createFakePeerLayer`.
 */
export interface PeerModules {
	startOfficerReplication: (options: never) => unknown;
	openOfficerStrandReader: (options: { memberNode: unknown; strandId: string; signal?: AbortSignal }) => Promise<unknown>;
	collectionIdForTable: (table: string) => string;
	startDashboardBoot: (options: { networkHash: string; adopt?: unknown; deps?: Record<string, unknown> }) => Promise<any>;
}

let peerModules: PeerModules | null = null;

export async function loadPeerModules(): Promise<PeerModules> {
	if (!peerModules) {
		const [bridge, read, collection, boot] = await Promise.all([
			import('../../src/peer/reactivity-bridge.js'),
			import('../../src/peer/strand-read.js'),
			import('../../src/peer/collection-id.js'),
			import('../../src/peer/boot.js'),
		]);
		peerModules = {
			startOfficerReplication: bridge.startOfficerReplication as unknown as PeerModules['startOfficerReplication'],
			openOfficerStrandReader: read.openOfficerStrandReader as unknown as PeerModules['openOfficerStrandReader'],
			collectionIdForTable: collection.collectionIdForTable,
			startDashboardBoot: boot.startDashboardBoot as unknown as PeerModules['startDashboardBoot'],
		};
	}
	return peerModules;
}

function peer(): PeerModules {
	if (!peerModules) throw new Error('live-gate: call loadPeerModules() before using the fake peer layer');
	return peerModules;
}

// ---------------------------------------------------------------------------
// Gate networks
// ---------------------------------------------------------------------------

/** The fixture officer (seed-founding-authority's founding Officer row). */
export const GATE_OFFICER_USER_ID = 'u1';

/** A string of exactly `length` characters built from `phrase` (fixture text, no copy word). */
function sized(phrase: string, length: number): string {
	let out = '';
	while (out.length < length) out += (out.length === 0 ? '' : ' ') + phrase;
	return out.slice(0, length).replace(/\s+$/, (m) => 'x'.repeat(m.length));
}

export interface GateNetworkSpec {
	readonly key: 'A' | 'B' | 'C';
	readonly networkHash: string;
	readonly authorityName: string;
	readonly domain: string;
	readonly officerUserId: string;
	readonly officerName?: string;
	readonly strandId: string;
}

/**
 * A: long name, domain and officer name (truncation stress). B: no officer
 * name, so the switcher falls back to the user id. C: never syncs (the
 * Offline no-update state).
 */
export const GATE_NETWORKS: Readonly<Record<'A' | 'B' | 'C', GateNetworkSpec>> = Object.freeze({
	A: Object.freeze({
		key: 'A' as const,
		networkHash: 'livegate-network-a',
		authorityName: sized('Gate County Board of Elections and Voter Registration Services for the Northern Lakes District', 120),
		domain: sized('elections.gate-county-northern-lakes-district.example', 60),
		officerUserId: GATE_OFFICER_USER_ID,
		officerName: sized('Ada Officer of the Northern Lakes Registration and Ballot Services Office', 80),
		strandId: 'livegate-strand-a',
	}),
	B: Object.freeze({
		key: 'B' as const,
		networkHash: 'livegate-network-b',
		authorityName: 'Gate City Clerk',
		domain: 'clerk.gate-city.example',
		officerUserId: GATE_OFFICER_USER_ID,
		strandId: 'livegate-strand-b',
	}),
	C: Object.freeze({
		key: 'C' as const,
		networkHash: 'livegate-network-c',
		authorityName: 'Gate Township Registrar',
		domain: 'registrar.gate-township.example',
		officerUserId: GATE_OFFICER_USER_ID,
		strandId: 'livegate-strand-c',
	}),
});

export function networkByKey(key: string): GateNetworkSpec {
	const spec = (GATE_NETWORKS as Record<string, GateNetworkSpec>)[key];
	if (!spec) throw new Error(`live-gate: unknown gate network key "${key}"`);
	return spec;
}

/** A syntactically valid pairing record with synthetic values (66-07 `PAIRING_FIELDS`). */
function syntheticPairing(spec: GateNetworkSpec) {
	return {
		v: 1 as const,
		requesterPeerId: `12D3KooWLiveGateRequester${spec.key}`,
		nonce: `livegate-nonce-${spec.key.toLowerCase()}`,
		expiresAt: '2026-12-31T00:00:00',
		keyPub: '02' + 'a'.repeat(64),
		sig: 'ab'.repeat(64),
		pairedAt: '2026-11-01T00:00:00',
		relayAddrs: ['/dns4/relay.livegate.test/tcp/443/wss/p2p/12D3KooWLiveGateRelay'],
		strandId: spec.strandId,
	};
}

/**
 * Remove any old entry and store for this network, create the live store
 * (`create: true`), close it, and write a paired registry entry.
 * `withoutStore` leaves the store absent (a boot then fails `absent`).
 */
export async function seedGateNetwork(
	spec: GateNetworkSpec,
	options: { lastPassAt?: number; officerUserId?: string; withoutStore?: boolean } = {},
): Promise<void> {
	removeNetwork(spec.networkHash);
	await deleteNetworkDb(spec.networkHash);
	if (options.withoutStore !== true) {
		const db = await attachLiveDb(spec.networkHash, { create: true });
		await closeNetworkDb(db);
	}
	upsertNetwork({
		networkHash: spec.networkHash,
		authorityName: spec.authorityName,
		domain: spec.domain,
		officerUserId: options.officerUserId ?? spec.officerUserId,
		...(spec.officerName !== undefined ? { officerName: spec.officerName } : {}),
		pairing: syntheticPairing(spec),
		...(typeof options.lastPassAt === 'number' ? { lastPassAt: options.lastPassAt } : {}),
	});
}

/** Remove every registry entry (their stores are left alone). */
export function clearGateRegistry(): void {
	for (const entry of listNetworks()) removeNetwork(entry.networkHash);
}

// ---------------------------------------------------------------------------
// Strand image
// ---------------------------------------------------------------------------

const SELECT_ALL_RE = /^\s*select\s+\*\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;

export interface MarkTarget {
	readonly table: string;
	readonly column: string;
	readonly pk: Readonly<Record<string, unknown>>;
	readonly markKeyPrefix: string;
}

export interface StrandImage {
	/** The object the fake node hands out as cadre-core's strand database. */
	readonly strandDatabase: { getTransactor(): string; getDatabase(): Database };
	/** Change one column of the one row matching `pk`; returns nothing (no value leaves the page). */
	mutate(table: string, pk: Readonly<Record<string, unknown>>, column: string, value: unknown): void;
	/** Rows of one table (copies), for in-page checks only. */
	rowsOf(table: string): Array<Record<string, unknown>>;
	/** While false, every row read rejects (the relay or the cohort is unreachable). */
	setReachable(reachable: boolean): void;
	/** Every string value in the image (gate 8 exempts rendered texts equal to fixture data). */
	fixtureStrings(): string[];
	/** The row and column gate 5 changes: the first ballot's Description (66-17 key `ballot:<Id>`). */
	markTarget(): MarkTarget;
	/** Append " rev <n>" to the mark target's value; deterministic, so two images stay in step. */
	bumpMarkTarget(): number;
	/** The mark target's current value, compared in-page only. */
	markTargetValue(): string;
	readonly tableCount: number;
}

/** A named error the image throws while unreachable; the reader reduces it to its name. */
class GateUnreachableError extends Error {
	constructor() {
		super('live-gate: the strand is unreachable');
		this.name = 'GateUnreachableError';
	}
}

/**
 * A scratch in-memory Quereus database with the VoteTorrent schema
 * (`prepareDb`, memory tables: no `setDefaultVtabName('store')`), seeded by
 * the founding-authority and election-surface fixtures. Every replicated
 * table is captured into a row map; the fixture officer's Scopes become all
 * nine scope codes (the fixture grants two; the gates assert nine panels).
 * The reader's `select * from <table>` is answered from the row map; any
 * other statement reaches the real database. `registerDbPlugins`, which the
 * real reader runs on the database it prepares, re-registers functions on
 * the real object (Quereus replaces a function of the same name and arity).
 */
export async function createStrandImage(
	options: { extraOfficers?: ReadonlyArray<{ userId: string; name: string }> } = {},
): Promise<StrandImage> {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	const rows = new Map<string, Array<Record<string, unknown>>>();
	for (const table of OFFICER_SUBSCRIBED_TABLES) {
		const list: Array<Record<string, unknown>> = [];
		for await (const row of db.eval(`select * from ${table}`)) list.push({ ...(row as Record<string, unknown>) });
		rows.set(table, list);
	}
	rows.set(
		'Officer',
		(rows.get('Officer') ?? []).map((row) =>
			row.UserId === GATE_OFFICER_USER_ID ? { ...row, Scopes: JSON.stringify(SCOPE_CODES) } : row,
		),
	);

	// Extra officers (compose-swap's incoming officer): a User row and an
	// Officer row copied from the fixture officer's, holding all nine scopes.
	const baseOfficer = (rows.get('Officer') ?? []).find((row) => row.UserId === GATE_OFFICER_USER_ID);
	const baseUser = (rows.get('User') ?? []).find((row) => row.Id === GATE_OFFICER_USER_ID);
	for (const extra of options.extraOfficers ?? []) {
		if (!baseOfficer || !baseUser) throw new Error('live-gate: the fixture officer is missing from the image');
		rows.get('User')?.push({ ...baseUser, Id: extra.userId, Name: extra.name });
		rows.get('Officer')?.push({ ...baseOfficer, UserId: extra.userId });
	}

	let reachable = true;
	let bumps = 0;
	const originalEval = db.eval.bind(db);
	(db as unknown as { eval: (sql: string, params?: unknown, options?: unknown) => AsyncIterable<unknown> }).eval = (
		sql: string,
		params?: unknown,
		options?: unknown,
	) => {
		const match = SELECT_ALL_RE.exec(sql);
		if (!match) return originalEval(sql, params as never, options as never) as AsyncIterable<unknown>;
		const table = match[1];
		if (!reachable) {
			return (async function* () {
				throw new GateUnreachableError();
			})();
		}
		const copies = (rows.get(table) ?? []).map((row) => ({ ...row }));
		return (async function* () {
			for (const row of copies) yield row;
		})();
	};

	function findRow(table: string, pk: Readonly<Record<string, unknown>>): Record<string, unknown> {
		const list = rows.get(table);
		if (!list) throw new Error(`live-gate: the image has no table "${table}"`);
		const hits = list.filter((row) => Object.entries(pk).every(([k, v]) => row[k] === v));
		if (hits.length !== 1) throw new Error(`live-gate: ${hits.length} rows of "${table}" match the key (want 1)`);
		return hits[0];
	}

	function markTarget(): MarkTarget {
		const ballots = rows.get('Ballot') ?? [];
		const first = [...ballots].sort((a, b) => String(a.Id).localeCompare(String(b.Id)))[0];
		if (!first) throw new Error('live-gate: the image holds no Ballot row');
		return Object.freeze({ table: 'Ballot', column: 'Description', pk: Object.freeze({ Id: first.Id }), markKeyPrefix: 'ballot:' });
	}

	return {
		strandDatabase: Object.freeze({ getTransactor: () => 'network', getDatabase: () => db }),
		mutate(table, pk, column, value) {
			const row = findRow(table, pk);
			if (!(column in row)) throw new Error(`live-gate: "${table}" has no column "${column}"`);
			row[column] = value;
		},
		rowsOf(table) {
			return (rows.get(table) ?? []).map((row) => ({ ...row }));
		},
		setReachable(next) {
			reachable = next;
		},
		fixtureStrings() {
			const out = new Set<string>();
			for (const list of rows.values()) {
				for (const row of list) for (const v of Object.values(row)) if (typeof v === 'string' && v.length > 0) out.add(v);
			}
			return [...out];
		},
		markTarget,
		bumpMarkTarget() {
			const target = markTarget();
			const row = findRow(target.table, target.pk);
			bumps += 1;
			row[target.column] = `${String(row[target.column]).replace(/ rev \d+$/, '')} rev ${bumps}`;
			return bumps;
		},
		markTargetValue() {
			const target = markTarget();
			return String(findRow(target.table, target.pk)[target.column]);
		},
		tableCount: rows.size,
	};
}

// ---------------------------------------------------------------------------
// Fake peer layer
// ---------------------------------------------------------------------------

export type PeerMode = 'auto' | 'manual' | 'never';

export interface GateEvent {
	readonly t: number;
	readonly hash: string;
	readonly ev: string;
	readonly at?: number;
	readonly detail?: string;
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

interface WatchRecord {
	collectionId: string;
	onChange: () => void;
	closed: boolean;
}

interface NetState {
	hash: string;
	mode: PeerMode;
	image: StrandImage | null;
	reachable: boolean;
	connected: boolean;
	held: boolean;
	reconnectHold: Deferred | null;
	verdict: { ok: true } | { ok: false; reason: 'revoked' | 'key-invalid' };
	nodes: FakeMemberNode[];
	watches: WatchRecord[];
	counts: { creates: number; resumes: number; reconnects: number; passesComplete: number; passesFailed: number; stops: number; watchFired: number };
	createFails: boolean;
}

type NodeEvent = 'control:connected' | 'control:disconnected' | 'cadre:removed';

export interface FakeMemberNode {
	peerId: { toString(): string };
	resume(): Promise<'joined'>;
	status(): string;
	waitForStrand(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
	getStrandNode(): unknown;
	strandPeerId(): string;
	getStrandDatabase(id: string): unknown;
	getControlNode(): { getConnections(): unknown[] } | null;
	strandPeerCount(): number;
	on(event: NodeEvent, cb: () => void): () => void;
	reconnect(): Promise<void>;
	stop(): Promise<void>;
}

/** The tail reader the real bridge gets: the fake watch never reads tails. */
const FAKE_TAILS = Object.freeze({ readTails: async () => new Map() });

export interface FakePeerControl {
	connect(hash: string): void;
	disconnect(hash: string): void;
	allowConnect(hash: string): void;
	holdFirstPass(hash: string): void;
	releasePass(hash: string): void;
	mutate(hash: string, table: string, pk: Readonly<Record<string, unknown>>, column: string, value: unknown): void;
	bumpMarkTarget(hash: string): { table: string; column: string; markKeyPrefix: string; bump: number };
	markTargetValue(hash: string): string;
	wake(hash: string, table: string): boolean;
	holdReconnect(hash: string): void;
	releaseReconnect(hash: string): void;
	setVerdict(hash: string, verdict: NetState['verdict']): void;
	failCreate(hash: string, fails: boolean): void;
	createHandoff(hash: string): Promise<PairingHandoff>;
	events(): GateEvent[];
	counts(): Record<string, NetState['counts']>;
}

/**
 * `image` is one image for every network or a per-hash map; `mode` is one
 * mode for every network or a per-hash map (default `auto`).
 *   - auto: reachable from the start; `resume()` connects.
 *   - manual: unreachable until `connect(hash)`.
 *   - never: unreachable; `reconnect()` counts and resolves without
 *     connecting until `allowConnect(hash)`.
 */
export function createFakePeerLayer({
	image,
	mode = 'auto',
}: {
	image: StrandImage | Readonly<Record<string, StrandImage>>;
	mode?: PeerMode | Readonly<Record<string, PeerMode>>;
}): { bootDeps: Record<string, unknown>; control: FakePeerControl } {
	const nets = new Map<string, NetState>();
	const log: GateEvent[] = [];
	const ev = (hash: string, name: string, extra: { at?: number; detail?: string } = {}) => {
		log.push(Object.freeze({ t: performance.now(), hash, ev: name, ...extra }));
	};

	function imageFor(hash: string): StrandImage | null {
		if ('strandDatabase' in (image as object)) return image as StrandImage;
		return (image as Record<string, StrandImage>)[hash] ?? null;
	}
	function modeFor(hash: string): PeerMode {
		if (typeof mode === 'string') return mode;
		return (mode as Record<string, PeerMode>)[hash] ?? 'auto';
	}

	function net(hash: string): NetState {
		let state = nets.get(hash);
		if (!state) {
			const m = modeFor(hash);
			state = {
				hash,
				mode: m,
				image: imageFor(hash),
				reachable: m === 'auto',
				connected: false,
				held: false,
				reconnectHold: null,
				verdict: { ok: true },
				nodes: [],
				watches: [],
				counts: { creates: 0, resumes: 0, reconnects: 0, passesComplete: 0, passesFailed: 0, stops: 0, watchFired: 0 },
				createFails: false,
			};
			// No connection yet, so no strand read can reach a peer (a `never`
			// network must complete no pass); `resume()` or `connect()` opens it.
			state.image?.setReachable(false);
			nets.set(hash, state);
		}
		return state;
	}

	function listenersOf(node: FakeMemberNode): Map<NodeEvent, Set<() => void>> {
		return (node as unknown as { __listeners: Map<NodeEvent, Set<() => void>> }).__listeners;
	}

	function emit(state: NetState, event: NodeEvent) {
		for (const node of state.nodes) {
			if ((node as unknown as { __stopped: boolean }).__stopped) continue;
			for (const cb of [...(listenersOf(node).get(event) ?? [])]) {
				try {
					cb();
				} catch {
					// A listener's own error is the boot's to log.
				}
			}
		}
	}

	function setConnected(state: NetState, next: boolean) {
		if (state.connected === next) return;
		state.connected = next;
		state.image?.setReachable(next);
		ev(state.hash, next ? 'connected' : 'disconnected');
		emit(state, next ? 'control:connected' : 'control:disconnected');
		// A fresh connection reads the watched tails once (the watch service's
		// own tick does this on a real node), which wakes the bridge.
		if (next) fireFirstWatch(state, 'connect');
	}

	function fireFirstWatch(state: NetState, why: string): boolean {
		const open = state.watches.filter((w) => !w.closed);
		if (open.length === 0) return false;
		state.counts.watchFired += 1;
		ev(state.hash, 'watch-fired', { detail: why });
		open[0].onChange();
		return true;
	}

	function makeNode(state: NetState, strandId: string): FakeMemberNode {
		let stopped = false;
		const listeners = new Map<NodeEvent, Set<() => void>>([
			['control:connected', new Set()],
			['control:disconnected', new Set()],
			['cadre:removed', new Set()],
		]);
		const strandPeerId = `12D3KooWLiveGateStrand${state.nodes.length}${state.hash.slice(-1)}`;
		const strandNode = Object.freeze({
			peerId: Object.freeze({ toString: () => strandPeerId }),
			reactivityWatch: Object.freeze({
				watch(req: { collectionId: string; onChange: () => void }) {
					const record: WatchRecord = { collectionId: req.collectionId, onChange: req.onChange, closed: false };
					state.watches.push(record);
					return {
						close: () => {
							record.closed = true;
						},
					};
				},
			}),
		});
		const node: FakeMemberNode & { __listeners: typeof listeners; __stopped: boolean } = {
			__listeners: listeners,
			get __stopped() {
				return stopped;
			},
			peerId: Object.freeze({ toString: () => `12D3KooWLiveGateIdentity${state.hash.slice(-1)}` }),
			async resume() {
				state.counts.resumes += 1;
				ev(state.hash, 'resume');
				if (state.reachable) setConnected(state, true);
				return 'joined';
			},
			status: () => (stopped ? 'stopped' : 'running'),
			waitForStrand(id, options = {}) {
				if (stopped) return Promise.reject(Object.assign(new Error('not running'), { name: 'MemberNodeError' }));
				if (id !== strandId) return Promise.reject(Object.assign(new Error('not configured'), { name: 'MemberNodeError' }));
				if (options.signal?.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
				return Promise.resolve(strandNode);
			},
			getStrandNode: () => (stopped ? null : strandNode),
			strandPeerId: () => strandPeerId,
			getStrandDatabase(id) {
				if (stopped || id !== strandId || state.held || !state.image) return null;
				return state.image.strandDatabase;
			},
			getControlNode: () => (stopped ? null : { getConnections: () => (state.connected ? [{}] : []) }),
			strandPeerCount: () => (!stopped && state.connected ? 1 : 0),
			on(event, cb) {
				const set = listeners.get(event);
				if (!set) throw new TypeError('on: unknown member node event');
				set.add(cb);
				return () => {
					set.delete(cb);
				};
			},
			async reconnect() {
				state.counts.reconnects += 1;
				ev(state.hash, 'reconnect');
				const hold = state.reconnectHold;
				if (hold) await hold.promise;
				if (!stopped && state.reachable) setConnected(state, true);
			},
			async stop() {
				if (stopped) return;
				ev(state.hash, 'stop-start');
				stopped = true;
				state.counts.stops += 1;
				for (const set of listeners.values()) set.clear();
				await Promise.resolve();
				ev(state.hash, 'stop-end');
			},
		};
		state.nodes.push(node);
		return node;
	}

	async function createMemberNode(options: { networkHash: string; strandId: string }): Promise<FakeMemberNode> {
		const state = net(options.networkHash);
		state.counts.creates += 1;
		ev(state.hash, 'create');
		if (state.createFails) throw Object.assign(new Error('create refused'), { name: 'GateCreateRefusedError' });
		return makeNode(state, options.strandId);
	}

	function startOfficerReplication(options: Record<string, unknown> & { networkHash: string; onPass: (e: unknown) => void; deps?: Record<string, unknown> }) {
		const state = net(options.networkHash);
		ev(state.hash, 'replication-start');
		const handle = peer().startOfficerReplication({
			...(options as Record<string, unknown>),
			onPass: (event: { type: string; at?: number; name?: string }) => {
				if (event?.type === 'pass-start') ev(state.hash, 'pass-start');
				else if (event?.type === 'pass-complete') {
					state.counts.passesComplete += 1;
					ev(state.hash, 'pass-complete', { at: event.at });
				} else if (event?.type === 'pass-failed') {
					state.counts.passesFailed += 1;
					ev(state.hash, 'pass-failed', { detail: event.name });
				}
				options.onPass(event);
			},
			deps: { ...(options.deps ?? {}), createTailReader: () => FAKE_TAILS },
		} as never) as { stop: () => Promise<void>; whenIdle: () => Promise<void>; wake: () => void };
		return Object.freeze({
			async stop() {
				await handle.stop();
				ev(state.hash, 'replication-stop');
			},
			whenIdle: () => handle.whenIdle(),
			wake: () => handle.wake(),
		});
	}

	const bootDeps: Record<string, unknown> = Object.freeze({
		createMemberNode,
		createIdbKeyStore: ({ networkHash }: { networkHash: string }) => Object.freeze({ kind: 'live-gate-key-store', networkHash }),
		startOfficerReplication,
		checkPairingStillValid: async ({ networkHash }: { networkHash: string }) => net(networkHash).verdict,
	});

	const control: FakePeerControl = {
		connect(hash) {
			const state = net(hash);
			state.reachable = true;
			setConnected(state, true);
		},
		disconnect(hash) {
			const state = net(hash);
			state.reachable = false;
			setConnected(state, false);
		},
		allowConnect(hash) {
			net(hash).reachable = true;
		},
		holdFirstPass(hash) {
			net(hash).held = true;
			ev(hash, 'hold');
		},
		releasePass(hash) {
			net(hash).held = false;
			ev(hash, 'release');
		},
		mutate(hash, table, pk, column, value) {
			const img = net(hash).image;
			if (!img) throw new Error('live-gate: no strand image for this network');
			img.mutate(table, pk, column, value);
			ev(hash, 'mutate', { detail: `${table}.${column}` });
		},
		bumpMarkTarget(hash) {
			const img = net(hash).image;
			if (!img) throw new Error('live-gate: no strand image for this network');
			const target = img.markTarget();
			const bump = img.bumpMarkTarget();
			ev(hash, 'mutate', { detail: `${target.table}.${target.column}` });
			return { table: target.table, column: target.column, markKeyPrefix: target.markKeyPrefix, bump };
		},
		markTargetValue(hash) {
			const img = net(hash).image;
			return img ? img.markTargetValue() : '';
		},
		wake(hash, table) {
			const state = net(hash);
			const id = peer().collectionIdForTable(table);
			const hit = state.watches.find((w) => !w.closed && w.collectionId === id);
			if (!hit) return false;
			state.counts.watchFired += 1;
			ev(hash, 'watch-fired', { detail: table });
			hit.onChange();
			return true;
		},
		holdReconnect(hash) {
			net(hash).reconnectHold = deferred();
		},
		releaseReconnect(hash) {
			const state = net(hash);
			const hold = state.reconnectHold;
			state.reconnectHold = null;
			hold?.resolve();
		},
		setVerdict(hash, verdict) {
			net(hash).verdict = verdict;
		},
		failCreate(hash, fails) {
			net(hash).createFails = fails;
		},
		/**
		 * A pairing handoff as `pairBrowser` would leave it: a running node and
		 * the REAL strand reader over it.
		 */
		async createHandoff(hash) {
			const entry = findNetwork(hash);
			if (!entry?.pairing) throw new Error('live-gate: the handoff network has no paired entry');
			const memberNode = await createMemberNode({ networkHash: hash, strandId: entry.pairing.strandId });
			await memberNode.resume();
			await memberNode.waitForStrand(entry.pairing.strandId);
			const strandReader = await peer().openOfficerStrandReader({ memberNode, strandId: entry.pairing.strandId });
			return { memberNode, strandReader };
		},
		events: () => [...log],
		counts() {
			const out: Record<string, NetState['counts']> = {};
			for (const [hash, state] of nets) out[hash] = { ...state.counts };
			return out;
		},
	};

	return { bootDeps, control };
}

// ---------------------------------------------------------------------------
// Fake pairing
// ---------------------------------------------------------------------------

export type PairStep =
	| { kind: 'fail'; reason: string }
	| { kind: 'hold'; then?: PairStep }
	| { kind: 'swap'; request: SwapRequest; then: PairStep }
	| { kind: 'ok'; networkHash: string; beforeHandoff?: () => Promise<void>; handoff: () => Promise<PairingHandoff> };

async function sha256Prefix(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * A scripted `pairBrowser` behind the pairing screen's `loadPairing` seam.
 * Each call takes the next step (default: fail `unreachable`). It records
 * only the length and a SHA-256 prefix of every code it receives.
 */
export function createFakePairing(script: PairStep[] = []) {
	const steps = [...script];
	const received: Array<{ length: number; sha256Prefix: string }> = [];
	const prefixes: Array<Promise<void>> = [];
	let hold: Deferred | null = null;
	let continuations = 0;
	let calls = 0;

	async function runStep(step: PairStep, options: PairBrowserOptions): Promise<PairResult> {
		if (step.kind === 'fail') return { ok: false, reason: step.reason };
		if (step.kind === 'hold') {
			options.onProgress?.('connecting');
			options.onProgress?.('joining');
			hold = deferred();
			const aborted = new Promise<'aborted'>((resolve) => {
				if (options.signal?.aborted) resolve('aborted');
				options.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
			});
			const outcome = await Promise.race([hold.promise.then(() => 'released' as const), aborted]);
			hold = null;
			if (outcome === 'aborted') return { ok: false, reason: 'cancelled' };
			return runStep(step.then ?? { kind: 'fail', reason: 'unreachable' }, options);
		}
		if (step.kind === 'swap') {
			const replace = await options.confirmSwap?.(step.request);
			if (replace !== true) return { ok: false, reason: 'swap-declined' };
			continuations += 1;
			return runStep(step.then, options);
		}
		options.onProgress?.('connecting');
		options.onProgress?.('joining');
		options.onProgress?.('first-sync');
		await step.beforeHandoff?.();
		return { ok: true, networkHash: step.networkHash, handoff: await step.handoff() };
	}

	async function pairBrowser(options: PairBrowserOptions): Promise<PairResult> {
		calls += 1;
		const record = { length: options.code.length, sha256Prefix: '' };
		received.push(record);
		const done = sha256Prefix(options.code).then((p) => {
			record.sha256Prefix = p;
		});
		prefixes.push(done);
		await done;
		options.onProgress?.('verifying');
		return runStep(steps.shift() ?? { kind: 'fail', reason: 'unreachable' }, options);
	}

	return {
		loadPairing: async (): Promise<PairingModule> => ({ pairBrowser, openStrandReader: (await loadPeerModules()).openOfficerStrandReader }),
		push(step: PairStep) {
			steps.push(step);
		},
		async received() {
			await Promise.all(prefixes);
			const last = received.at(-1);
			return { count: received.length, length: last?.length ?? 0, sha256Prefix: last?.sha256Prefix ?? '' };
		},
		release() {
			hold?.resolve();
		},
		stats: () => ({ calls, continuations, pending: steps.length }),
	};
}

// ---------------------------------------------------------------------------
// GateApp: main.tsx's App, with the two seams added
// ---------------------------------------------------------------------------

type AppRoute =
	| { kind: 'pairing'; notice: UnpairedNotice | null; returnTo: string | null }
	| { kind: 'shell'; networkHash: string; adopt: PairingHandoff | null; mount: number };

function currentRoute(preferredHash?: string | null) {
	return routeFromRegistry(listNetworks(), isLegacyEntry, preferredHash);
}

let mountSeq = 0;

function initialRoute(): AppRoute {
	const route = currentRoute();
	if (route.kind === 'shell') return { kind: 'shell', networkHash: route.networkHash, adopt: null, mount: ++mountSeq };
	return { kind: 'pairing', notice: null, returnTo: null };
}

/**
 * Mirrors `src/main.tsx`'s `App` line for line (routing through the real
 * `routeFromRegistry`, the same `key` remount rule and the same four shell
 * callbacks), with `bootDeps` forwarded to the shell and `loadPairing` to
 * the pairing screen. `App` is not exported from `main.tsx`, so this mirror
 * is the only way to compose it with the seams (follow-up: export it).
 */
export function GateApp({
	bootDeps,
	loadPairing,
}: {
	bootDeps: Record<string, unknown>;
	loadPairing?: () => Promise<PairingModule>;
}): ReactElement {
	const [route, setRoute] = useState<AppRoute>(initialRoute);

	const shellNetworkHash = route.kind === 'shell' ? route.networkHash : null;

	const handlePairAnother = useCallback(() => {
		setRoute({ kind: 'pairing', notice: null, returnTo: shellNetworkHash });
	}, [shellNetworkHash]);

	const handleUnpaired = useCallback((notice: UnpairedNotice) => {
		const next = currentRoute();
		setRoute({ kind: 'pairing', notice, returnTo: next.kind === 'shell' ? next.networkHash : null });
	}, []);

	const handleNoNetworks = useCallback(() => {
		setRoute({ kind: 'pairing', notice: null, returnTo: null });
	}, []);

	const handlePaired = useCallback((result: { networkHash: string; handoff: PairingHandoff }) => {
		setRoute({ kind: 'shell', networkHash: result.networkHash, adopt: result.handoff, mount: ++mountSeq });
	}, []);

	const handleDismissNotice = useCallback(() => {
		setRoute((current) => (current.kind === 'pairing' && current.notice !== null ? { ...current, notice: null } : current));
	}, []);

	const returnTo = route.kind === 'pairing' ? route.returnTo : null;
	const handleCancel = useCallback(() => {
		if (returnTo === null) return;
		const back = currentRoute(returnTo);
		if (back.kind === 'shell' && back.networkHash === returnTo) {
			setRoute({ kind: 'shell', networkHash: back.networkHash, adopt: null, mount: ++mountSeq });
		}
	}, [returnTo]);

	if (route.kind === 'shell') {
		return (
			<DashboardShell
				key={route.mount}
				initialNetworkHash={route.networkHash}
				adopt={route.adopt}
				onPairAnother={handlePairAnother}
				onUnpaired={handleUnpaired}
				onNoNetworks={handleNoNetworks}
				bootDeps={bootDeps}
			/>
		);
	}

	return (
		<Pairing
			notice={route.notice}
			onDismissNotice={handleDismissNotice}
			hasPairedNetworks={currentRoute().kind === 'shell'}
			onPaired={handlePaired}
			onCancel={handleCancel}
			loadPairing={loadPairing}
		/>
	);
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export interface ChipSample {
	readonly t: number;
	readonly kind: string | null;
	readonly text: string;
}

export interface MarkRecord {
	id: number;
	addT: number;
	removeT: number | null;
	background: string;
	boxShadow: string;
	transitionAtAdd: string;
	transitionAtFade: string | null;
	hasWord: boolean;
}

export interface TextSample {
	readonly t: number;
	readonly selector: string;
	readonly text: string;
}

/** Chip kind/text, every `.change-mark` element's lifetime and styles, and the opening line. */
export function installTraces() {
	const chip: ChipSample[] = [];
	const marks: MarkRecord[] = [];
	const watched: TextSample[] = [];
	const live = new Map<Element, MarkRecord>();
	let nextId = 1;
	let lastChipKey = '\u0000';
	const watchedLast = new Map<string, string>();
	const WATCHED_SELECTORS = ['.sh-opening', '.change-mark-live-region', '.sh-reconnect'];

	function sample() {
		const now = performance.now();
		const chipEl = document.querySelector('.sh-status-chip');
		const kind = chipEl ? chipEl.getAttribute('data-kind') : null;
		const text = chipEl ? (chipEl.textContent ?? '') : '';
		const key = `${kind}\u0001${text}`;
		if (key !== lastChipKey) {
			lastChipKey = key;
			chip.push(Object.freeze({ t: now, kind, text }));
		}
		const current = new Set(document.querySelectorAll('.change-mark'));
		for (const el of current) {
			let record = live.get(el);
			if (!record) {
				const style = getComputedStyle(el);
				record = {
					id: nextId++,
					addT: now,
					removeT: null,
					background: style.backgroundColor,
					boxShadow: style.boxShadow,
					transitionAtAdd: style.transitionDuration,
					transitionAtFade: null,
					hasWord: el.querySelector('.change-mark__word') !== null,
				};
				live.set(el, record);
				marks.push(record);
			}
			if (record.transitionAtFade === null && el.classList.contains('change-mark--fading')) {
				record.transitionAtFade = getComputedStyle(el).transitionDuration;
			}
		}
		for (const [el, record] of live) {
			if (!current.has(el)) {
				record.removeT = now;
				live.delete(el);
			}
		}
		for (const selector of WATCHED_SELECTORS) {
			const el = document.querySelector(selector);
			const value = el ? `${(el as HTMLButtonElement).disabled ? '[disabled]' : ''}${el.textContent ?? ''}` : '';
			if (watchedLast.get(selector) !== value) {
				watchedLast.set(selector, value);
				watched.push(Object.freeze({ t: now, selector, text: value }));
			}
		}
	}

	const observer = new MutationObserver(sample);
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	sample();

	const streams: MediaStream[] = [];
	const media = navigator.mediaDevices;
	if (media && typeof media.getUserMedia === 'function') {
		const original = media.getUserMedia.bind(media);
		media.getUserMedia = async (constraints?: MediaStreamConstraints) => {
			const stream = await original(constraints);
			streams.push(stream);
			return stream;
		};
	}

	return {
		chipTrace: () => [...chip],
		markTrace: () => marks.map((m) => ({ ...m })),
		watchedTrace: () => [...watched],
		streams: () => streams.map((s, i) => ({ index: i, tracks: s.getTracks().map((tr) => ({ kind: tr.kind, readyState: tr.readyState })) })),
	};
}

function isVisible(el: Element): boolean {
	if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
	if (el.closest('[hidden]')) return false;
	const style = getComputedStyle(el);
	if (style.display === 'none' || style.visibility === 'hidden') return false;
	return el.getClientRects().length > 0;
}

const TEXT_ATTRIBUTES = ['title', 'aria-label', 'alt', 'placeholder', 'aria-description'];

/** Every visible text node plus every text-bearing attribute value, de-duplicated (gate 8). */
export function collectTexts(): string[] {
	const out = new Set<string>();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = (node.textContent ?? '').trim();
		if (text.length === 0) continue;
		const parent = node.parentElement;
		if (!parent || parent.closest('script, style')) continue;
		if (!isVisible(parent)) continue;
		out.add(text);
	}
	for (const el of document.body.querySelectorAll('*')) {
		for (const name of TEXT_ATTRIBUTES) {
			const value = el.getAttribute(name);
			if (value && value.trim().length > 0) out.add(value.trim());
		}
	}
	return [...out];
}

// ---------------------------------------------------------------------------
// In-page QR decode (D-23)
// ---------------------------------------------------------------------------

/** Deterministic PRNG for the resampled frame's noise. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let x = a;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

/** Draw the matrix (with a 4-module white quiet zone) at integer module size `m`. */
function drawMatrix(ctx: CanvasRenderingContext2D, modules: readonly string[], n: number, m: number, x0: number, y0: number) {
	const side = (n + 8) * m;
	ctx.fillStyle = '#FFFFFF';
	ctx.fillRect(x0, y0, side, side);
	ctx.fillStyle = '#000000';
	for (let r = 0; r < n; r += 1) {
		const row = modules[r];
		for (let c = 0; c < n; c += 1) if (row[c] === '1') ctx.fillRect(x0 + (c + 4) * m, y0 + (r + 4) * m, m, m);
	}
}

/**
 * Render the 1280x720 frame the same way `qr-decode-fixture.mjs`'s
 * `renderFrame` does, decode it through the production `adaptDecoderModule`
 * over the decoder module the scanner loads (`import('jsqr')`), and compare
 * the result with the expected SHA-256 in-page. No payload text returns.
 */
export async function decodeFrame(
	modules: readonly string[],
	n: number,
	variant: 'integer' | 'resampled' | 'damaged',
	expectedSha256Prefix: string,
): Promise<{ decoded: boolean; decodedLength: number; equal: boolean; sha256Prefix: string; m: number }> {
	const W = 1280;
	const H = 720;
	const canvas = document.createElement('canvas');
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('live-gate: no 2d context');
	ctx.imageSmoothingEnabled = false;
	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, W, H);
	let m = Math.floor(H / (n + 8));
	if (variant === 'resampled') {
		m = 5;
		const big = document.createElement('canvas');
		big.width = (n + 8) * m;
		big.height = (n + 8) * m;
		const bctx = big.getContext('2d');
		if (!bctx) throw new Error('live-gate: no 2d context');
		bctx.imageSmoothingEnabled = false;
		drawMatrix(bctx, modules, n, m, 0, 0);
		const target = 640;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'medium';
		ctx.drawImage(big, Math.round((W - target) / 2), Math.round((H - target) / 2), target, target);
		const img = ctx.getImageData(0, 0, W, H);
		const rand = mulberry32(0x6625);
		for (let i = 0; i < img.data.length; i += 4) {
			const factor = 1 + (rand() * 2 - 1) * 0.06;
			for (let k = 0; k < 3; k += 1) img.data[i + k] = Math.max(0, Math.min(255, Math.round(img.data[i + k] * factor)));
		}
		ctx.putImageData(img, 0, 0);
	} else {
		const side = (n + 8) * m;
		const x0 = Math.floor((W - side) / 2);
		const y0 = Math.floor((H - side) / 2);
		drawMatrix(ctx, modules, n, m, x0, y0);
		if (variant === 'damaged') {
			ctx.fillStyle = '#FFFFFF';
			ctx.fillRect(x0 + 4 * m, y0 + 4 * m, 8 * m, 8 * m);
		}
	}
	const imageData = ctx.getImageData(0, 0, W, H);
	const decode = adaptDecoderModule(await import('jsqr'));
	const text = await decode({ data: imageData.data, width: W, height: H });
	if (typeof text !== 'string') return { decoded: false, decodedLength: 0, equal: false, sha256Prefix: '', m };
	const prefix = await sha256Prefix(text);
	return { decoded: true, decodedLength: new TextEncoder().encode(text).length, equal: prefix === expectedSha256Prefix, sha256Prefix: prefix, m };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

interface LiveGateReadout {
	ready: boolean;
	failed: Array<{ name: string; message: string }>;
	log: Array<{ ms: number; message: string }>;
	leg: string;
}

function parseList(value: string | null): string[] {
	return (value ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** `A:auto,B:never` -> { [hashA]: 'auto', [hashB]: 'never' } */
function parseModes(value: string | null): Record<string, PeerMode> {
	const out: Record<string, PeerMode> = {};
	for (const item of parseList(value)) {
		const [key, m] = item.split(':');
		if (m !== 'auto' && m !== 'manual' && m !== 'never') throw new Error(`live-gate: unknown peer mode "${m}"`);
		out[networkByKey(key).networkHash] = m;
	}
	return out;
}

const UNPAIRED_NOTICES: Readonly<Record<string, UnpairedNotice>> = Object.freeze({
	revoked: { reason: 'revoked', authorityName: GATE_NETWORKS.A.authorityName, officerName: GATE_NETWORKS.A.officerName ?? null },
	removed: { reason: 'removed', authorityName: GATE_NETWORKS.A.authorityName, officerName: null },
	'key-invalid': { reason: 'key-invalid', authorityName: GATE_NETWORKS.B.authorityName, officerName: null },
});

/**
 * Query parameters:
 *   leg      the runner's leg name (logged only)
 *   clear=1  remove every registry entry first
 *   seed     network keys to seed fresh (A,B,C); `seedLastPassAt=A:<ms>`
 *   nostore  network keys seeded with no local store
 *   mode     per-network peer mode (`A:auto,C:never`); unlisted = auto
 *   hold     network keys whose passes are held from the start
 *   mount    `app` (default) | `none`
 */
export async function runLiveGate(): Promise<void> {
	const win = window as unknown as Record<string, unknown>;
	const t0 = performance.now();
	const readout: LiveGateReadout = { ready: false, failed: [], log: [], leg: '' };
	win.__LIVE_GATE__ = readout;
	const note = (message: string) => readout.log.push({ ms: +(performance.now() - t0).toFixed(1), message });
	try {
		const params = new URLSearchParams(location.search);
		readout.leg = params.get('leg') ?? '';
		const traces = installTraces();

		if (params.get('clear') === '1') clearGateRegistry();
		const lastPassAts: Record<string, number> = {};
		for (const item of parseList(params.get('seedLastPassAt'))) {
			const [key, ms] = item.split(':');
			lastPassAts[key] = Number(ms);
		}
		const noStore = new Set(parseList(params.get('nostore')));
		for (const key of parseList(params.get('seed'))) {
			await seedGateNetwork(networkByKey(key), { lastPassAt: lastPassAts[key], withoutStore: noStore.has(key) });
			note(`seeded ${key}`);
		}

		const modes = parseModes(params.get('mode'));
		const images: Record<string, StrandImage> = {};
		for (const hash of Object.keys(modes)) images[hash] = await createStrandImage();
		note(`strand images: ${Object.keys(images).length}`);
		await loadPeerModules();
		const { bootDeps, control } = createFakePeerLayer({ image: images, mode: modes });
		for (const key of parseList(params.get('hold'))) control.holdFirstPass(networkByKey(key).networkHash);
		const pairing = createFakePairing();

		const rootEl = document.getElementById('root');
		if (!rootEl) throw new Error('live-gate: #root element not found');
		let root: Root | null = null;
		const mountApp = () => {
			root?.unmount();
			root = createRoot(rootEl);
			root.render(
				<StrictMode>
					<GateApp bootDeps={bootDeps} loadPairing={pairing.loadPairing} />
				</StrictMode>,
			);
		};
		const showNotice = (reason: string) => {
			const notice = UNPAIRED_NOTICES[reason];
			if (!notice) throw new Error(`live-gate: unknown notice "${reason}"`);
			root?.unmount();
			root = createRoot(rootEl);
			root.render(
				<StrictMode>
					<Pairing notice={notice} onDismissNotice={() => undefined} hasPairedNetworks={false} onPaired={() => undefined} loadPairing={pairing.loadPairing} />
				</StrictMode>,
			);
		};

		win.__LIVE_GATE_CTL__ = Object.freeze({
			...control,
			...traces,
			texts: collectTexts,
			decodeFrame,
			showNotice,
			remount: mountApp,
			pairing: Object.freeze({
				pushFail: (reason: string) => pairing.push({ kind: 'fail', reason }),
				pushHold: () => pairing.push({ kind: 'hold', then: { kind: 'fail', reason: 'unreachable' } }),
				release: () => pairing.release(),
				received: () => pairing.received(),
				stats: () => pairing.stats(),
			}),
			entry: (key: string) => {
				const found = findNetwork(networkByKey(key).networkHash);
				return found ? { lastPassAt: found.lastPassAt ?? null, officerUserId: found.officerUserId } : null;
			},
			hashOf: (key: string) => networkByKey(key).networkHash,
			fixtureStrings: () => [
				...new Set([
					...Object.values(images).flatMap((img) => img.fixtureStrings()),
					...Object.values(GATE_NETWORKS).flatMap((spec) => [spec.authorityName, spec.domain, spec.officerUserId, spec.officerName ?? '']),
				]),
			].filter((s) => s.length > 0),
			domHasMarkTargetValue: (key: string) => {
				const value = control.markTargetValue(networkByKey(key).networkHash);
				return value.length > 0 && (document.body.textContent ?? '').includes(value);
			},
			copyKeyText: (key: string, vars?: Record<string, string>) => t(key, vars ?? {}),
		});

		if ((params.get('mount') ?? 'app') === 'app') mountApp();
		readout.ready = true;
		note('ready');
	} catch (err) {
		const name = err instanceof Error && err.name ? err.name : 'Error';
		readout.failed.push({ name, message: 'the live gate driver failed before it was ready' });
		readout.ready = true;
	}
}

if (typeof document !== 'undefined' && document.documentElement.dataset.gate === 'live-gate') {
	void runLiveGate();
}
