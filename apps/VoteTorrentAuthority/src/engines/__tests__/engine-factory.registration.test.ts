/**
 * Phase 46 plan 46-03 (D-06): EngineFactory's 'registration' case.
 *
 * Asserts:
 *   (a) with an established ctx, buildEngine('registration') constructs a
 *       RegistrationEngine bound to the established EngineContext, called with
 *       EXACTLY ONE argument (no verifier leaked in from a copied 'association'
 *       shape — RegistrationEngine's constructor is `(ctx?: EngineContext)`,
 *       there is no second argument to inject).
 *   (b) with NO established ctx (a bare `new EngineFactory(...)`),
 *       getEngine('registration') rejects with NoNetworkEstablishedError — the
 *       SAME lifecycle guard 'elections'/'signing' have. Before this task the
 *       default branch would have rejected with `unknown engine type
 *       "registration"`, so this assertion is meaningfully RED first.
 *
 * `@votetorrent/vote-engine/rn` is virtual-mocked, mirroring
 * engine-factory.association.test.ts's established convention for this same
 * module, with ONE addition: a `RegistrationEngine` stand-in class that
 * records its constructor argument(s) so the test can assert what was
 * injected and how many arguments were passed.
 */

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
}));

jest.mock(
	'@votetorrent/vote-engine/rn',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		class RegistrationEngine {
			ctx: any;
			argCount: number;
			constructor(...args: any[]) {
				this.ctx = args[0];
				this.argCount = args.length;
			}
		}
		class AssociationEngine {
			ctx: any;
			verifier: any;
			constructor(ctx: any, verifier: any) {
				this.ctx = ctx;
				this.verifier = verifier;
			}
		}
		class PlayIntegrityVerifier {
			constructor(..._args: any[]) {}
		}
		class StubAttestationVerifier {}
		class LocalConfigKeyProvider {
			config: any;
			constructor(config: any) {
				this.config = config;
			}
		}
		class LocalStorageReact {}
		return {
			RegistrationEngine,
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
			LocalConfigKeyProvider,
			LocalStorageReact,
			// Unused by the 'registration' path but imported at module load by engine-factory.ts.
			NetworksEngine: class {},
			NetworkEngine: class {},
			ElectionsEngine: class {},
			ElectionEngine: class {},
			SigningEngine: class {},
			DefaultUserEngine: class {},
			KeysTasksEngine: class {},
			SignatureTasksEngine: class {},
			OnboardingTasksEngine: class {},
			InvitationEngine: class {},
		};
	},
	{ virtual: true },
);

import { EngineFactory, NoNetworkEstablishedError } from '../engine-factory';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rn = require('@votetorrent/vote-engine/rn');

function buildFactoryWithEstablishedCtx() {
	const establishedCtx = { db: {} };
	const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(factory as any).currentNetworkHash = 'hash1';
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(factory as any).networksEngine = { getEstablishedContext: () => establishedCtx };
	return { factory, establishedCtx };
}

describe("EngineFactory buildEngine('registration') — D-06", () => {
	it('constructs a RegistrationEngine bound to the established ctx, called with exactly one argument', async () => {
		const { factory, establishedCtx } = buildFactoryWithEstablishedCtx();

		const engine = await factory.getEngine('registration');

		expect(engine).toBeInstanceOf(rn.RegistrationEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).ctx).toBe(establishedCtx);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).argCount).toBe(1);
	});

	it('rejects with NoNetworkEstablishedError when no network has been established', async () => {
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());

		await expect(factory.getEngine('registration')).rejects.toBeInstanceOf(
			NoNetworkEstablishedError,
		);
	});
});
