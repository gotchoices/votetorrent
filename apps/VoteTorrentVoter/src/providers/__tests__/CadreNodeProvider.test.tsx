/**
 * A transient first relay-reservation miss must not cost the Voter its node for the whole process.
 *
 * The Authority hit this on 64-53 (debug authority-reattach-after-settle-timeout): a relaunched
 * keyholder on a loaded emulator logged `[CadreNodeProvider] Boot error: RelayReservationFailedError
 * ... (status: retrying)` while the relay refused nothing and admitted a reservation within the same
 * minute. cadre-core's fail-fast posture (network.requireRelay unset) threw that out of start(); the
 * provider then stopped the node, and nothing re-created it until the app was killed. The Voter's
 * provider runs the same posture in separate code, so a phone Voter relaunched on slow Wi-Fi with a
 * relay named in its bootstrap config never gets a node, and VoterAppProvider never re-opens the
 * joined network (it waits for a node that never comes).
 *
 * CadreNode and the native/ESM deps are virtual-mocked, as in the Authority's provider suite. The
 * fake start() mirrors cadre-core 1.15 `driveControlRelayReservation`: with `network.relayAddrs`
 * named and `network.requireRelay` not `false`, a first attempt that misses its budget throws; with
 * `requireRelay: false` the same drive only logs and start() carries on.
 */

import React from 'react';
import renderer from 'react-test-renderer';

const RELAY_ADDR = '/ip4/203.0.113.9/tcp/4801/ws/p2p/12D3KooWExample';
const BOOT_FLUSH_TURNS = 20;

let mockRelayFirstAttemptMisses = false;
let mockStartGate: Promise<void> | null = null;
let mockStartError: Error | null = null;
const mockConstructedNodes: Array<{ receivedOptions: unknown; stop: jest.Mock; listeners: Map<string, Set<(e: unknown) => void>>; emit: (event: string, e: unknown) => void }> = [];

jest.mock(
	'@serfab/cadre-core',
	() => {
		class FakeCadreNode {
			public receivedOptions: unknown;
			public stop = jest.fn(async () => {});
			public start = jest.fn(async () => {
				if (mockStartGate) await mockStartGate;
				if (mockStartError) throw mockStartError;
				const network = (this.receivedOptions as {network?: {relayAddrs?: string[]; requireRelay?: boolean}}).network;
				if (mockRelayFirstAttemptMisses && (network?.relayAddrs?.length ?? 0) > 0 && network?.requireRelay !== false) {
					const e = new Error(
						'network.relayAddrs reservation failed (status: retrying): relay reservation request did not complete before the deadline',
					);
					e.name = 'RelayReservationFailedError';
					throw e;
				}
			});
			public getStrand = jest.fn(() => undefined);
			public getMultiaddrs = jest.fn(() => []);
			constructor(opts: unknown) {
				this.receivedOptions = opts;
				mockConstructedNodes.push(this);
			}
			// Listeners are recorded (not invoked by anything but a test's emit) so the commit-share
			// test below can drive strand:commit-durability through the provider's real tracker.
			public listeners = new Map<string, Set<(e: unknown) => void>>();
			on(event: string, l: (e: unknown) => void) {
				if (!this.listeners.has(event)) this.listeners.set(event, new Set());
				this.listeners.get(event)!.add(l);
			}
			off(event: string, l: (e: unknown) => void) {
				this.listeners.get(event)?.delete(l);
			}
			emit(event: string, e: unknown) {
				for (const l of [...(this.listeners.get(event) ?? [])]) l(e);
			}
		}
		const controlStorageScope = (partyId: string) => 'control-' + Buffer.from(partyId).toString('hex');
		return {CadreNode: FakeCadreNode, controlStorageScope};
	},
	{virtual: true},
);

jest.mock(
	'@optimystic/db-p2p-storage-rn',
	() => ({
		openOptimysticRNDb: jest.fn(() => ({})),
		LevelDBRawStorage: class {},
		loadOrCreateRNPeerKey: jest.fn(async () => ({type: 'Ed25519'})),
	}),
	{virtual: true},
);
jest.mock('@libp2p/websockets', () => ({webSockets: () => ({})}), {virtual: true});
jest.mock('@libp2p/circuit-relay-v2', () => ({circuitRelayTransport: () => ({})}), {virtual: true});
jest.mock('../../engines/storage-guard', () => ({
	createScopedRnStorageProvider: () => Object.assign(() => ({}), {destroyScope: jest.fn(async () => undefined)}),
}));
jest.mock('../../engines/rn-durable-slot', () => ({
	openTrustedOwnerStore: jest.fn(async () => undefined),
	openBootstrapPeerStore: jest.fn(async () => undefined),
}));
jest.mock('../../engines/join-bootstrap', () => ({readJoinBootstrap: jest.fn(async () => [])}));
jest.mock('../../../bootstrap.config.json', () => ({bootstrapNodes: [RELAY_ADDR]}));

const {CadreNodeProvider, useCadreNode} = require('../CadreNodeProvider');

async function bootProvider() {
	const captured: {value: ReturnType<typeof useCadreNode> | null} = {value: null};
	function Probe() {
		captured.value = useCadreNode();
		return null;
	}
	await renderer.act(async () => {
		renderer.create(
			<CadreNodeProvider>
				<Probe />
			</CadreNodeProvider>,
		);
		for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
			await Promise.resolve();
		}
	});
	return captured;
}

beforeEach(() => {
	mockConstructedNodes.length = 0;
	mockRelayFirstAttemptMisses = false;
	mockStartGate = null;
	mockStartError = null;
});

describe('CadreNodeProvider (Voter) — a first relay reservation that misses its budget', () => {
	it('still boots with a live node, built with network.requireRelay false', async () => {
		mockRelayFirstAttemptMisses = true;
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const captured = await bootProvider();

			expect(errorSpy.mock.calls.some(c => c[0] === '[CadreNodeProvider] Boot error:')).toBe(false);
			expect(captured.value!.node).not.toBeNull();
			const node = mockConstructedNodes[mockConstructedNodes.length - 1];
			expect(node.stop).not.toHaveBeenCalled();
			const network = (node.receivedOptions as {network: {relayAddrs: string[]; requireRelay?: boolean}}).network;
			expect(network.relayAddrs).toEqual([RELAY_ADDR]);
			expect(network.requireRelay).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('boots normally when the first reservation lands (guard)', async () => {
		const captured = await bootProvider();
		expect(captured.value!.node).not.toBeNull();
		expect(mockConstructedNodes).toHaveLength(1);
	});
});

describe('CadreNodeProvider (Voter) — the node settle status (#99)', () => {
	it("reports nodeStatus 'starting' while start() runs, then 'ready' with the live node", async () => {
		let release!: () => void;
		mockStartGate = new Promise<void>(resolve => {
			release = resolve;
		});
		const captured = await bootProvider();
		expect(captured.value!.nodeStatus).toBe('starting');
		expect(captured.value!.node).toBeNull();

		await renderer.act(async () => {
			release();
			for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
				await Promise.resolve();
			}
		});
		expect(captured.value!.nodeStatus).toBe('ready');
		expect(captured.value!.node).not.toBeNull();
	});

	it("reports nodeStatus 'failed' with no node when start() rejects", async () => {
		const startError = new Error('start refused');
		startError.name = 'SomeStartError';
		mockStartError = startError;
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const captured = await bootProvider();
			expect(captured.value!.nodeStatus).toBe('failed');
			expect(captured.value!.node).toBeNull();
			expect(errorSpy.mock.calls.some(c => c[0] === '[CadreNodeProvider] Boot error:')).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe('CadreNodeProvider (Voter) — native Noise crypto (spike 093)', () => {
	it('builds the node with network.noiseCrypto from the shared switch (symmetric by default)', async () => {
		await bootProvider();
		const node = mockConstructedNodes[mockConstructedNodes.length - 1];
		const network = (node.receivedOptions as {network?: {noiseCrypto?: unknown}}).network;
		// The jest mock of @serfab/cadre-rn/noise-crypto tags its result with the mode, so this
		// proves the provider forwards the switch rather than silently running stock pure-JS noise.
		expect(network?.noiseCrypto).toEqual({__mockNoiseCrypto: 'symmetric'});
	});
});

// Strand peers that declared themselves read-only edge readers (the officer's browser dashboard) are kept out
// of this phone's strand write cohorts and coordinator choice: the node config carries a sticky
// `strandCohortRefusal` hook from vote-engine's createEdgeReaderRefusal.
describe('CadreNodeProvider (Voter) — edge-reader cohort refusal', () => {
	type Hook = (strandId: string) => {refuses(peerId: string): boolean; attach?(node: unknown): void} | undefined;
	const hookOf = (n: {receivedOptions: unknown}) => (n.receivedOptions as {strandCohortRefusal?: unknown}).strandCohortRefusal;

	it('ER-V1 the node config carries strandCohortRefusal as a function that refuses nobody yet', async () => {
		await bootProvider();
		expect(mockConstructedNodes).toHaveLength(1);
		const hook = hookOf(mockConstructedNodes[0]);
		expect(typeof hook).toBe('function');
		const refusal = (hook as Hook)('s1');
		expect(refusal).toBeDefined();
		expect(refusal!.refuses('x')).toBe(false);
		expect((hook as Hook)('s1')).toBe(refusal);
	});

	it('ER-V2 the recovery rebuild passes the SAME hook', async () => {
		// Every start() in this fake throws the planted error, so the rebuild's start fails too; the point here is
		// only that the second node is built with the first node's hook.
		mockStartError = new Error('CadreControl.Revocation could not be restored');
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			await bootProvider();
			expect(mockConstructedNodes).toHaveLength(2);
			const [first, second] = mockConstructedNodes;
			expect(typeof hookOf(first)).toBe('function');
			expect(hookOf(second)).toBe(hookOf(first));
		} finally {
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});

// todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort: the provider's REAL tracker
// listens to the live node and feeds useUnsharedCommitCount (Home's UnsharedChangesNotice).
describe('CadreNodeProvider (Voter) — writes not shared yet', () => {
	it('counts a commit no other member holds, and clears it when it is held', async () => {
		const {useUnsharedCommitCount} = require('../../hooks/useCommitShare');
		const seen = {count: -1};
		function CountProbe() {
			seen.count = useUnsharedCommitCount();
			return null;
		}
		await renderer.act(async () => {
			renderer.create(
				<CadreNodeProvider>
					<CountProbe />
				</CadreNodeProvider>,
			);
			for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
				await Promise.resolve();
			}
		});
		const node = mockConstructedNodes[mockConstructedNodes.length - 1];
		expect(node.listeners.get('strand:commit-durability')?.size).toBe(1);
		expect(seen.count).toBe(0);
		renderer.act(() => node.emit('strand:commit-durability', {strandId: 's', transactionId: 't', heldElsewhere: false, followed: true}));
		expect(seen.count).toBe(1);
		renderer.act(() => node.emit('strand:commit-held', {strandId: 's', transactionId: 't'}));
		expect(seen.count).toBe(0);
	});
});
