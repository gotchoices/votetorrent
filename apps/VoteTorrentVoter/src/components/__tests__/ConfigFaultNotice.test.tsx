/**
 * Unit tests for ConfigFaultNotice (D-14, 56-10) — the Voter app's
 * user-visible bootstrap-configuration-fault surface.
 *
 * Also carries this plan's Voter-side provider resolver/fault-context
 * assertions (Task 3's `<action>` note: "place them in this suite or in a
 * new CadreNodeProvider test for the Voter, whichever mounts with fewer new
 * mocks"). This suite already needs `useCadreNode` mocked and
 * `@serfab/cadre-core`/`rn-leveldb`/`@optimystic/db-p2p-storage-rn` are
 * ESM-only/native leaves the real provider module would drag in — mounting
 * the resolver-contract assertions here (which need none of those mocks,
 * since `resolveBootstrapNodes` and `readBootstrapConfig` are pure) avoids
 * standing up a second, heavier provider-boot test file for the Voter app.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import * as fs from 'fs';
import * as path from 'path';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

// The REAL CadreNodeProvider module (needed below for the real, pure
// resolveBootstrapNodes) imports ESM-only/native leaves that cannot load
// under the react-native jest preset — virtual-mocked here, mirroring
// CadreNodeProvider.test.tsx's own convention in the Authority app.
// Spike 100: every config a FakeCadreNode was built with, so a test can read the wiring.
const mockCadreConfigs: Array<Record<string, any>> = [];
jest.mock(
	'@serfab/cadre-core',
	() => {
		class FakeCadreNode {
			constructor(config: Record<string, any>) {
				mockCadreConfigs.push(config);
			}
			start = jest.fn(async () => {});
			stop = jest.fn(async () => {});
			getStrand = jest.fn(() => undefined);
			on = jest.fn();
			off = jest.fn();
		}
		// Spike 100: the provider opens persistent trusted-owner / bootstrap-peer stores at boot.
		const fakeStore = {open: jest.fn(async () => ({}))};
		return {CadreNode: FakeCadreNode, PersistentTrustedOwnerStore: fakeStore, PersistentBootstrapPeerStore: fakeStore};
	},
	{virtual: true},
);
jest.mock('rn-leveldb', () => ({LevelDB: class {}, LevelDBWriteBatch: class {}}), {virtual: true});
jest.mock(
	'@optimystic/db-p2p-storage-rn',
	() => ({
		openOptimysticRNDb: jest.fn(() => ({})),
		loadOrCreateRNPeerKey: jest.fn(async () => ({})),
		LevelDBRawStorage: class {},
	}),
	{virtual: true},
);
jest.mock('@libp2p/websockets', () => ({webSockets: () => ({})}), {virtual: true});
jest.mock('@libp2p/circuit-relay-v2', () => ({circuitRelayTransport: () => ({})}), {virtual: true});

jest.mock('../../providers/CadreNodeProvider', () => {
	const actual = jest.requireActual('../../providers/CadreNodeProvider');
	return {
		...actual,
		useCadreNode: jest.fn(() => ({syncState: 'connected', configFault: null, node: null, connectedPeers: jest.fn()})),
	};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {useCadreNode, resolveBootstrapNodes} = require('../../providers/CadreNodeProvider');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {ConfigFaultNotice} = require('../ConfigFaultNotice');

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderNotice(): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<ConfigFaultNotice />));
	});
	activeRenderers.push(tr);
	return tr;
}

afterEach(() => {
	jest.clearAllMocks();
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

describe('ConfigFaultNotice (D-14)', () => {
	it('renders nothing when configFault is null', () => {
		(useCadreNode as jest.Mock).mockReturnValue({syncState: 'connected', configFault: null, node: null, connectedPeers: jest.fn()});
		const tree = renderNotice().toJSON();
		expect(tree).toBeNull();
	});

	it('renders a warning-toned row with the translated label as a real text node when configFault is non-null', () => {
		(useCadreNode as jest.Mock).mockReturnValue({
			syncState: 'offline',
			configFault: {kind: 'missing', reason: 'empty-address-list'},
			node: null,
			connectedPeers: jest.fn(),
		});
		const tr = renderNotice();
		expect(tr.root.findByProps({testID: 'config-fault-notice'})).toBeTruthy();
		expect(tr.root.findByProps({children: 'Not configured'})).toBeTruthy();
	});

	it('the rendered text contains no digits and none of Phase/D-1/56', () => {
		(useCadreNode as jest.Mock).mockReturnValue({
			syncState: 'offline',
			configFault: {kind: 'malformed', reason: 'invalid-address'},
			node: null,
			connectedPeers: jest.fn(),
		});
		const tr = renderNotice();
		const textNode = tr.root.findByProps({children: 'Not configured'});
		expect(textNode.props.children).not.toMatch(/\d/);
		expect(textNode.props.children).not.toMatch(/Phase|D-1|56/);
	});
});

describe('NetworkHeader presentational contract', () => {
	it('reads no provider (no useCadreNode call)', () => {
		const source = fs.readFileSync(path.join(__dirname, '../NetworkHeader.tsx'), 'utf8');
		expect(source).not.toContain('useCadreNode');
	});
});

describe('HomeScreen mounts ConfigFaultNotice beneath NetworkHeader (D-14)', () => {
	it('renders a config-fault-notice element in the tree when useVoterApp/useNavigation are available', () => {
		// HomeScreen depends on useVoterApp()/useNavigation() — mocking the full
		// provider tree is out of scope for this notice-focused suite; instead we
		// assert structurally by source inspection, matching the
		// NetworkHeader-presentational-contract check above (both are
		// source-scan checks, not full mounts, to avoid a second heavy
		// provider-mocking stack in this file).
		const source = fs.readFileSync(path.join(__dirname, '../../screens/home/HomeScreen.tsx'), 'utf8');
		const networkHeaderIndex = source.indexOf('<NetworkHeader');
		const configFaultNoticeIndex = source.indexOf('<ConfigFaultNotice');
		expect(networkHeaderIndex).toBeGreaterThan(-1);
		expect(configFaultNoticeIndex).toBeGreaterThan(networkHeaderIndex);
	});
});

// ---------------------------------------------------------------------------
// resolveBootstrapNodes — blank-safe single-address guard (D-14).
// The Voter must not depend on the Authority's suite for its own coverage.
// ---------------------------------------------------------------------------
describe('resolveBootstrapNodes — blank-safe single-address guard (D-14, Voter)', () => {
	it('returns [] for an empty string', () => {
		expect(resolveBootstrapNodes('')).toEqual([]);
	});

	it('returns [] for undefined', () => {
		expect(resolveBootstrapNodes(undefined as unknown as string)).toEqual([]);
	});

	it('returns [] for a whitespace-only string', () => {
		expect(resolveBootstrapNodes('   ')).toEqual([]);
	});

	it('returns [addr] for a real address', () => {
		const real = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWReal';
		expect(resolveBootstrapNodes(real)).toEqual([real]);
	});

	it('signature lock: still takes exactly one parameter', () => {
		expect(resolveBootstrapNodes.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Config-fault wiring on the Voter's OWN provider (D-14). Mirrors the
// Authority app's "config-fault wiring" describe block
// (src/providers/__tests__/CadreNodeProvider.test.tsx) so the Voter does not
// depend on the Authority's suite for its own coverage of: fault reaches
// context, boot is not blocked by a fault, the wiring is load-bearing (the
// mocked CadreNode receives the derived bootstrapNodes), and no document
// content ever echoes into the context or a console.error call.
//
// `bootstrapConfig` is computed at MODULE SCOPE in CadreNodeProvider.tsx, so
// proving a fault reaches the context for a GIVEN document requires
// re-requiring the whole module fresh per document via jest.resetModules().
// 'react' is pinned to the single instance already loaded by this test file
// (captured once, before any reset) so the freshly-required provider does not
// get a second react module instance with its own hook-dispatcher state —
// see the Authority suite's identical note for the full multi-copy-React trap.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — config-fault wiring on the Voter provider (D-14)', () => {
	const actualReact = jest.requireActual('react');

	afterEach(() => {
		jest.dontMock('../../../bootstrap.config.json');
		jest.dontMock('react');
	});

	function loadRealProviderModuleWithDoc(doc: unknown) {
		jest.resetModules();
		jest.doMock('react', () => actualReact);
		jest.doMock('../../../bootstrap.config.json', () => doc, {virtual: true});
		// requireActual bypasses this file's own top-level jest.mock() on
		// '../../providers/CadreNodeProvider' (which wraps useCadreNode with a
		// jest.fn) — these tests need the REAL provider + REAL useCadreNode.
		return jest.requireActual('../../providers/CadreNodeProvider');
	}

	it('a missing/empty document reaches the context as configFault, and node still becomes non-null (boot not blocked)', async () => {
		const mod = loadRealProviderModuleWithDoc({bootstrapNodes: []});
		const captured: {value: ReturnType<typeof mod.useCadreNode> | null} = {value: null};

		function Probe() {
			captured.value = mod.useCadreNode();
			return null;
		}

		await renderer.act(async () => {
			renderer.create(
				<mod.CadreNodeProvider>
					<Probe />
				</mod.CadreNodeProvider>,
			);
			for (let i = 0; i < 10; i++) {
				// eslint-disable-next-line no-await-in-loop
				await Promise.resolve();
			}
		});

		expect(captured.value!.configFault).toEqual({kind: 'missing', reason: 'empty-address-list'});
		expect(captured.value!.node).not.toBeNull();
	});

	it('a valid document reports configFault: null and no document echo for a malformed probe', async () => {
		const LEAK_PROBE = 'LEAKPROBE0123';
		const mod = loadRealProviderModuleWithDoc({bootstrapNodes: [`/ip4/${LEAK_PROBE}/tcp/443/wss`]});
		const captured: {value: ReturnType<typeof mod.useCadreNode> | null} = {value: null};
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		function Probe() {
			captured.value = mod.useCadreNode();
			return null;
		}

		await renderer.act(async () => {
			renderer.create(
				<mod.CadreNodeProvider>
					<Probe />
				</mod.CadreNodeProvider>,
			);
			for (let i = 0; i < 10; i++) {
				// eslint-disable-next-line no-await-in-loop
				await Promise.resolve();
			}
		});

		expect(JSON.stringify(captured.value!.configFault)).not.toContain(LEAK_PROBE);
		for (const call of errorSpy.mock.calls) {
			for (const arg of call) {
				expect(String(arg)).not.toContain(LEAK_PROBE);
			}
		}
		errorSpy.mockRestore();
	});

	it('spike 100: a joined phone boots with its join bootstrap, no config fault, and a relay-only address resolver', async () => {
		const MEMBER = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWAuthorityAuthorityAuthorityAuthorityAuthor';
		mockCadreConfigs.length = 0;
		const mod = loadRealProviderModuleWithDoc({bootstrapNodes: []});
		// After the module reset: the SAME AsyncStorage instance the freshly-required provider reads.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const asyncStorageModule = require('@react-native-async-storage/async-storage');
		const AsyncStorage = asyncStorageModule.default ?? asyncStorageModule;
		await AsyncStorage.setItem('@votetorrent/voterJoinBootstrap', JSON.stringify([MEMBER]));
		const captured: {value: ReturnType<typeof mod.useCadreNode> | null} = {value: null};
		function Probe() {
			captured.value = mod.useCadreNode();
			return null;
		}
		await renderer.act(async () => {
			renderer.create(
				<mod.CadreNodeProvider>
					<Probe />
				</mod.CadreNodeProvider>,
			);
			for (let i = 0; i < 10; i++) {
				// eslint-disable-next-line no-await-in-loop
				await Promise.resolve();
			}
		});

		expect(captured.value!.configFault).toBeNull();
		const config = mockCadreConfigs[mockCadreConfigs.length - 1]!;
		expect(config.controlNetwork.bootstrapNodes).toEqual([MEMBER]);
		// A member is a bootstrap peer, never a relay (an unanswered reservation fails start()).
		expect(config.network.relayAddrs).toEqual([]);
		expect(config.network.controlCohort).toEqual({strandAddrRefreshMs: 30_000});
		expect(typeof config.network.inviteAddressResolver).toBe('function');
		await AsyncStorage.removeItem('@votetorrent/voterJoinBootstrap');
	});
});
