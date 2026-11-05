/**
 * Phase 47 plan 47-09 (D-09 / Pattern 2): EngineFactory's 'authorityConfig' case.
 *
 * Asserts:
 *   (a) with an established ctx, buildEngine('authorityConfig') constructs an
 *       AuthorityConfigEngine bound to the established EngineContext, called
 *       with EXACTLY ONE argument — the arg-count assertion guards against
 *       the 'association' TWO-argument shape being copied by mistake.
 *   (b) with NO established ctx (a bare `new EngineFactory(...)`),
 *       getEngine('authorityConfig') rejects with NoNetworkEstablishedError —
 *       the same lifecycle guard 'registration'/'elections' have. Before this
 *       task the default branch would have rejected with `unknown engine
 *       type "authorityConfig"`, so this assertion is meaningfully RED first.
 *   (c) two successive getEngine('authorityConfig') calls return the SAME
 *       cached instance (cache-keyed by name) — ctx-bound, and therefore
 *       correctly dropped by evictNetworkScopedEngines() on a network switch.
 *
 * `@votetorrent/vote-engine/rn` is virtual-mocked, mirroring
 * engine-factory.association.test.ts's/registration.test.ts's established
 * convention for this same module. Because the mock is `{ virtual: true }`,
 * jest resolves the module from this factory and NEVER touches the real
 * dist/rn-entry.d.ts — so a missing rn-entry.ts export (T-47-01c) is
 * INVISIBLE to this suite. The app typecheck and a `grep -c
 * AuthorityConfigEngine packages/vote-engine/dist/rn-entry.d.ts` are the only
 * detectors for that half (see 47-09-SUMMARY.md).
 *
 * This file is a TypeScript MODULE (static import/export at top level), not a
 * script-scope file with module-scope const/function declarations — two
 * sibling test files in this directory (rn-db-factory.test.ts,
 * persistence-proof.strand.test.ts) already collide on a shared top-level
 * helper name and produce standing TS2451/TS2393 typecheck errors that jest
 * never surfaces. Using `import`/`export` here makes this file its own
 * module scope, avoiding that trap.
 */

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
}));

jest.mock(
	'@votetorrent/vote-engine/rn',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		class AuthorityConfigEngine {
			ctx: any;
			argCount: number;
			constructor(...args: any[]) {
				this.ctx = args[0];
				this.argCount = args.length;
			}
		}
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
			AuthorityConfigEngine,
			RegistrationEngine,
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
			LocalConfigKeyProvider,
			LocalStorageReact,
			// Unused by the 'authorityConfig' path but imported at module load by engine-factory.ts.
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
	{ virtual: true }
);

jest.mock('../attestation-roots.generated', () => ({
	PINNED_HARDWARE_ROOTS_DER: [new Uint8Array([1, 2, 3])],
}));
jest.mock('../attestation-status.generated', () => ({
	REVOKED_ATTESTATION_SERIALS: new Set(['deadbeef']),
}));
jest.mock('../attestation-keys.generated', () => ({
	PLAY_CONSOLE_DECRYPTION_KEY_BASE64: '',
	PLAY_CONSOLE_VERIFICATION_KEY_BASE64: '',
	EXPECTED_APP_PACKAGE: 'org.votetorrent.authority',
	EXPECTED_APP_CERT_SHA256_DIGESTS: [],
	PUBLIC_DEBUG_CERT_SHA256_DIGESTS: [],
	buildExpectedCertDigests: () => [],
}));

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

describe("EngineFactory buildEngine('authorityConfig') — D-09 / Pattern 2", () => {
	it('constructs an AuthorityConfigEngine bound to the established ctx with exactly one argument', async () => {
		const { factory, establishedCtx } = buildFactoryWithEstablishedCtx();

		const engine = await factory.getEngine('authorityConfig');

		expect(engine).toBeInstanceOf(rn.AuthorityConfigEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).ctx).toBe(establishedCtx);
		// Arg-count guard: catches the 'association' two-argument (ctx, verifier)
		// shape being copied by mistake — AuthorityConfigEngine takes ctx only,
		// no injected verifier, no fail-closed guard (not an attestation path).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).argCount).toBe(1);
	});

	it('rejects with NoNetworkEstablishedError when no network has been established', async () => {
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());

		await expect(factory.getEngine('authorityConfig')).rejects.toBeInstanceOf(
			NoNetworkEstablishedError
		);
	});

	it('returns the SAME cached instance across two calls (cache-keyed by name, ctx-bound)', async () => {
		const { factory } = buildFactoryWithEstablishedCtx();

		const first = await factory.getEngine('authorityConfig');
		const second = await factory.getEngine('authorityConfig');

		expect(second).toBe(first);
		// Being ctx-bound (not param-keyed) means this cache entry is correctly
		// dropped by evictNetworkScopedEngines() on a network switch, rebuilding
		// fresh against the newly-established ctx — the same lifecycle every
		// other requireEstablishedCtx()-backed engine follows.
	});
});
