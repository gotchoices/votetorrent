/**
 * Phase 62 Plan 21 (D-32/D-04): EngineFactory's peer-staging surface —
 * `createPeerStagingTransports`, `PeerStrandUnavailableError`/`isPeerStrandUnavailableError`,
 * and the `'intake'` engine case.
 *
 * `@votetorrent/vote-engine/rn` and `../rn-db-factory` are virtual-mocked, mirroring
 * `engine-factory.registration.test.ts`'s established convention: lightweight recording
 * stand-ins so this test exercises ONLY `engine-factory.ts`'s own selection/wiring logic,
 * never the real P2P transports or NetworksEngine.
 */

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn((node: unknown, options: unknown) => {
		return async (networkHash: string) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (global as any).__peerStagingFakeDb;
		};
	}),
}));

jest.mock(
	'@votetorrent/vote-engine/rn',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		class NetworksEngine {
			dbFactory: any;
			contexts = new Map<string, any>();
			constructor(_localStorage: any, dbFactory: any) {
				this.dbFactory = dbFactory;
			}
			async open(ref: any, _user: any, _autoOpen?: boolean, _peerCount?: any) {
				const db = await this.dbFactory(ref.hash);
				const ctx = { db, user: _user };
				this.contexts.set(ref.hash, ctx);
				return { getDetails: async () => ({}) };
			}
			getEstablishedContext(hash: string) {
				return this.contexts.get(hash);
			}
		}
		class IntakeEngine {
			ctx: any;
			argCount: number;
			constructor(...args: any[]) {
				this.ctx = args[0];
				this.argCount = args.length;
			}
		}
		class P2pRegistrationTransport {
			options: any;
			constructor(options: any) {
				this.options = options;
			}
		}
		class P2pAssociationTransport {
			options: any;
			constructor(options: any) {
				this.options = options;
			}
		}
		class RegistrationEngine {
			constructor(..._args: any[]) {}
		}
		class AssociationEngine {
			constructor(..._args: any[]) {}
		}
		class PlayIntegrityVerifier {
			constructor(..._args: any[]) {}
		}
		class StubAttestationVerifier {}
		class AppAttestVerifier {
			constructor(..._args: any[]) {}
		}
		class PlatformDispatchingAttestationVerifier {
			constructor(..._args: any[]) {}
		}
		class LocalConfigKeyProvider {
			constructor(_config: any) {}
		}
		class AuthorityConfigEngine {
			constructor(..._args: any[]) {}
		}
		class LocalStorageReact {}
		return {
			NetworksEngine,
			NetworkEngine: class {},
			ElectionsEngine: class {},
			ElectionEngine: class {},
			SigningEngine: class {},
			DefaultUserEngine: class {},
			KeysTasksEngine: class {},
			SignatureTasksEngine: class {},
			OnboardingTasksEngine: class {},
			InvitationEngine: class {},
			LocalStorageReact,
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
			AppAttestVerifier,
			PlatformDispatchingAttestationVerifier,
			LocalConfigKeyProvider,
			RegistrationEngine,
			AuthorityConfigEngine,
			IntakeEngine,
			P2pRegistrationTransport,
			P2pAssociationTransport,
		};
	},
	{ virtual: true },
);

import {
	EngineFactory,
	NoNetworkEstablishedError,
	PeerStrandUnavailableError,
	isPeerStrandUnavailableError,
} from '../engine-factory';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rn = require('@votetorrent/vote-engine/rn');

function makeFakeDb() {
	return {
		// eslint-disable-next-line @typescript-eslint/require-yield
		eval: jest.fn(async function* (_sql: string, _params?: unknown) {
			yield { one: 1 };
		}),
		exec: jest.fn(async () => undefined),
		close: jest.fn(),
	};
}

const opener = { open: jest.fn() };
const decisionSigner = { authorityId: 'auth-1', sign: jest.fn() };

describe('EngineFactory.createPeerStagingTransports (D-32)', () => {
	afterEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (global as any).__peerStagingFakeDb;
		jest.clearAllMocks();
	});

	it('refuses no-network before any network is established', () => {
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		let caught: unknown;
		try {
			factory.createPeerStagingTransports({ opener, decisionSigner });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(PeerStrandUnavailableError);
		expect((caught as PeerStrandUnavailableError).reason).toBe('no-network');
		expect(isPeerStrandUnavailableError(caught)).toBe(true);
		expect(isPeerStrandUnavailableError(new Error('plain'))).toBe(false);
	});

	it('refuses not-strand-backed when the established network was opened through rnDbFactory (no node)', async () => {
		const fakeDb = makeFakeDb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(global as any).__peerStagingFakeDb = fakeDb;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const fakeRnDbFactory = jest.fn(async () => fakeDb) as any;
		const factory = new EngineFactory(new rn.LocalStorageReact(), fakeRnDbFactory);
		// node is never set — the lazy-dispatch DbFactory falls back to rnDbFactory.
		await factory.getEngine('network', { hash: 'hash-solo' });

		let caught: unknown;
		try {
			factory.createPeerStagingTransports({ opener, decisionSigner });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(PeerStrandUnavailableError);
		expect((caught as PeerStrandUnavailableError).reason).toBe('not-strand-backed');
		expect(isPeerStrandUnavailableError(caught)).toBe(true);
	});

	async function establishStrandBackedNetwork(hash: string) {
		const fakeDb = makeFakeDb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(global as any).__peerStagingFakeDb = fakeDb;
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		factory.setNode({
			addStrand: jest.fn(),
			getControlNode: () => null,
			whenStrandWritable: jest.fn(),
		});
		await factory.getEngine('network', { hash });
		return { factory, fakeDb };
	}

	it('returns strandId = networkHash and wires opener/decisionSigner with no sealer into both transports', async () => {
		const { factory } = await establishStrandBackedNetwork('hash-strand-1');

		const transports = factory.createPeerStagingTransports({ opener, decisionSigner });

		expect(transports.strandId).toBe('hash-strand-1');
		expect(transports.registration).toBeInstanceOf(rn.P2pRegistrationTransport);
		expect(transports.association).toBeInstanceOf(rn.P2pAssociationTransport);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const regOptions = (transports.registration as any).options;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const assocOptions = (transports.association as any).options;

		expect(regOptions.strandId).toBe('hash-strand-1');
		expect(regOptions.opener).toBe(opener);
		expect(regOptions.decisionSigner).toBe(decisionSigner);
		expect(regOptions.sealer).toBeUndefined();

		expect(assocOptions.strandId).toBe('hash-strand-1');
		expect(assocOptions.opener).toBe(opener);
		expect(assocOptions.decisionSigner).toBe(decisionSigner);
		expect(assocOptions.sealer).toBeUndefined();

		await expect(regOptions.computeDigest()).rejects.toThrow(
			'The authority app never submits staged requests',
		);
		await expect(assocOptions.computeDigest()).rejects.toThrow(
			'The authority app never submits staged requests',
		);
		await expect(assocOptions.computeAttestationDigest()).rejects.toThrow(
			'The authority app never submits staged requests',
		);
	});

	it('the constructed port reaches the ctx db eval, and close() leaves the fake db close uncalled', async () => {
		const { factory, fakeDb } = await establishStrandBackedNetwork('hash-strand-2');
		const transports = factory.createPeerStagingTransports({ opener, decisionSigner });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const regOptions = (transports.registration as any).options;

		const port = await regOptions.openStrand();
		const rows = await port.query('select 1 as one', {});
		expect(fakeDb.eval).toHaveBeenCalled();
		expect(rows).toEqual([{ one: 1 }]);

		await port.close();
		expect(fakeDb.close).not.toHaveBeenCalled();
	});

	it('refuses network-changed when openStrand is called after a switch to a different network hash', async () => {
		const { factory } = await establishStrandBackedNetwork('hash-strand-3');
		const transports = factory.createPeerStagingTransports({ opener, decisionSigner });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const regOptions = (transports.registration as any).options;

		// Switch to a different strand-backed network.
		const fakeDb2 = makeFakeDb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(global as any).__peerStagingFakeDb = fakeDb2;
		await factory.getEngine('network', { hash: 'hash-strand-other' });

		let caught: unknown;
		try {
			await regOptions.openStrand();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(PeerStrandUnavailableError);
		expect((caught as PeerStrandUnavailableError).reason).toBe('network-changed');
		expect(isPeerStrandUnavailableError(caught)).toBe(true);
	});
});

describe("EngineFactory buildEngine('intake') — D-32", () => {
	it('constructs an IntakeEngine bound to the established ctx', async () => {
		const establishedCtx = { db: {} };
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).currentNetworkHash = 'hash1';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).networksEngine = { getEstablishedContext: () => establishedCtx };

		const engine = await factory.getEngine('intake');

		expect(engine).toBeInstanceOf(rn.IntakeEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).ctx).toBe(establishedCtx);
	});

	it('rejects with NoNetworkEstablishedError when no network has been established', async () => {
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		await expect(factory.getEngine('intake')).rejects.toBeInstanceOf(NoNetworkEstablishedError);
	});
});
