/**
 * Phase 62 Plan 26 (D-16/D-19/D-21): EngineFactory's keyholder-vault-backed engine wiring —
 * `case 'keyholderDkg'` and `case 'keysTasksEngine'` (62-20's `KeysTasksEngineDeps`).
 *
 * `@votetorrent/vote-engine/rn` and `../rn-db-factory` are virtual-mocked, mirroring
 * `engine-factory.peerStaging.test.ts`'s established convention: lightweight recording
 * stand-ins so this test exercises ONLY `engine-factory.ts`'s own selection/wiring logic.
 */

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
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
		class KeysTasksEngine {
			args: any[];
			constructor(...args: any[]) {
				this.args = args;
			}
		}
		class KeyholderDkgEngine {
			args: any[];
			constructor(...args: any[]) {
				this.args = args;
			}
		}
		class IntakeEngine {
			constructor(..._args: any[]) {}
		}
		class P2pRegistrationTransport {
			constructor(_options: any) {}
		}
		class P2pAssociationTransport {
			constructor(_options: any) {}
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
			KeysTasksEngine,
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
			KeyholderDkgEngine,
		};
	},
	{ virtual: true }
);

import { EngineFactory, NoNetworkEstablishedError } from '../engine-factory';
import { setKeyholderKeyVaultForTests } from '../keyholder-vault';
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

describe('EngineFactory keyholder-vault wiring (62-26)', () => {
	const fakeVault = {
		putSecret: jest.fn(),
		getSecret: jest.fn(),
		hasSecret: jest.fn(async () => false),
		deleteSecret: jest.fn(),
	};

	beforeEach(() => {
		setKeyholderKeyVaultForTests(fakeVault as never);
	});

	afterEach(() => {
		setKeyholderKeyVaultForTests(undefined);
		jest.clearAllMocks();
	});

	async function establishNetwork(hash: string) {
		const fakeDb = makeFakeDb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const fakeRnDbFactory = jest.fn(async () => fakeDb) as any;
		const factory = new EngineFactory(new rn.LocalStorageReact(), fakeRnDbFactory);
		await factory.getEngine('network', { hash });
		return factory;
	}

	it("F1: getEngine('keysTasksEngine') constructs with 3 arguments: { hash }, ctx and { vault: <override> }", async () => {
		const factory = await establishNetwork('hash-kh-0');
		const engine = (await factory.getEngine('keysTasksEngine')) as InstanceType<typeof rn.KeysTasksEngine>;
		expect(engine.args).toHaveLength(3);
		expect(engine.args[0]).toEqual({ hash: 'hash-kh-0' });
		expect(engine.args[2]).toEqual({ vault: fakeVault });
	});

	it("F2: getEngine('keyholderDkg') constructs KeyholderDkgEngine with (ctx, { vault: <override> })", async () => {
		const factory = await establishNetwork('hash-kh-1');
		const engine = (await factory.getEngine('keyholderDkg')) as InstanceType<typeof rn.KeyholderDkgEngine>;
		expect(engine).toBeInstanceOf(rn.KeyholderDkgEngine);
		expect(engine.args).toHaveLength(2);
		expect(engine.args[1]).toEqual({ vault: fakeVault });
	});

	it("F2: getEngine('keyholderDkg') rejects NoNetworkEstablishedError with no network", async () => {
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		await expect(factory.getEngine('keyholderDkg')).rejects.toBeInstanceOf(NoNetworkEstablishedError);
	});

	it('both keyholder engines share the SAME resolveKeyholderKeyVault() instance', async () => {
		const factory = await establishNetwork('hash-kh-3');
		const dkg = (await factory.getEngine('keyholderDkg')) as InstanceType<typeof rn.KeyholderDkgEngine>;
		const tasks = (await factory.getEngine('keysTasksEngine')) as InstanceType<typeof rn.KeysTasksEngine>;
		expect((dkg.args[1] as { vault: unknown }).vault).toBe(fakeVault);
		expect((tasks.args[2] as { vault: unknown }).vault).toBe(fakeVault);
	});
});
