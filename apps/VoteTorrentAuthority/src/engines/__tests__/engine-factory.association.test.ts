/**
 * D-12/D-13/D-14: EngineFactory's 'association' case.
 *
 * Asserts:
 *   (a) with the dev flag false (the committed proof-flags default), buildEngine('association')
 *       constructs an AssociationEngine whose injected verifier is a
 *       PlayIntegrityVerifier — the REAL default, never a silent stub fallback.
 *   (b) with the dev flag true under __DEV__, it constructs a StubAttestationVerifier.
 *
 * `@votetorrent/vote-engine/rn` is virtual-mocked (mirroring rn-db-factory.test.ts's
 * established convention for this same module) with lightweight stand-in classes for
 * AssociationEngine/PlayIntegrityVerifier/StubAttestationVerifier/LocalConfigKeyProvider,
 * so this test exercises ONLY engine-factory.ts's own selection logic (D-14 dev gate) —
 * the real PlayIntegrityVerifier's cert-chain/token verification behavior is covered by
 * vote-engine's own suite (play-integrity-verifier.spec.ts / key-attestation-verifier.spec.ts).
 * `USE_STUB_ATTESTATION_VERIFIER` is mocked per-test via jest.doMock + jest.resetModules,
 * mirroring the RN app's static-import proof-flags convention — the real generated file's
 * committed value stays `false` and is never overwritten by this test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__DEV__ = true;

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
}));

// jest.mock() factories may not close over out-of-scope variables (they run
// hoisted, before module-scope const/class declarations are initialized) —
// the fakes are defined INSIDE the factory, then re-required below via
// `require('@votetorrent/vote-engine/rn')` so the test body can reference
// the SAME class objects the mocked engine-factory.ts sees.
jest.mock(
	'@votetorrent/vote-engine/rn',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		class AssociationEngine {
			ctx: any;
			verifier: any;
			constructor(ctx: any, verifier: any) {
				this.ctx = ctx;
				this.verifier = verifier;
			}
		}
		class PlayIntegrityVerifier {
			keyProvider: any;
			roots: any;
			appIdentity: any;
			revoked: any;
			constructor(keyProvider: any, roots: any, appIdentity: any, revoked: any) {
				this.keyProvider = keyProvider;
				this.roots = roots;
				this.appIdentity = appIdentity;
				this.revoked = revoked;
			}
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
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
			LocalConfigKeyProvider,
			LocalStorageReact,
			// Unused by the 'association' path but imported at module load by engine-factory.ts.
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

// Stub attestation-roots/status generated files so the test doesn't depend on the
// real bundled snapshot content — only that engine-factory.ts wires SOME pinned
// roots + revoked-serials into PlayIntegrityVerifier's constructor.
jest.mock('../attestation-roots.generated', () => ({
	PINNED_HARDWARE_ROOTS_DER: [new Uint8Array([1, 2, 3])],
}));
jest.mock('../attestation-status.generated', () => ({
	REVOKED_ATTESTATION_SERIALS: new Set(['deadbeef']),
}));
// Stub the bundled app-identity + Play Console key snapshot. `EXPECTED_APP_*`
// pin the token/key to this app (CR-04/WR-03). The Play Console keys are
// PROVISIONED here (non-empty) so the default 'association' path builds the
// real verifier rather than failing closed (CR-03) — the fail-closed branch is
// exercised by its own test via jest.doMock below.
jest.mock('../attestation-keys.generated', () => ({
	PLAY_CONSOLE_DECRYPTION_KEY_BASE64: 'ZGVjcnlwdGlvbi1rZXktcHJvdmlzaW9uZWQ=',
	PLAY_CONSOLE_VERIFICATION_KEY_BASE64: 'dmVyaWZpY2F0aW9uLWtleS1wcm92aXNpb25lZA==',
	EXPECTED_APP_PACKAGE: 'org.votetorrent.authority',
	EXPECTED_APP_CERT_SHA256_DIGESTS: ['abc123'],
}));

describe("EngineFactory buildEngine('association') — D-12/D-13/D-14", () => {
	afterEach(() => {
		jest.resetModules();
	});

	function buildFactoryWithEstablishedCtx() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { EngineFactory } = require('../engine-factory');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const rn = require('@votetorrent/vote-engine/rn');
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).currentNetworkHash = 'hash1';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).networksEngine = { getEstablishedContext: () => ({ db: {} }) };
		return { factory, rn };
	}

	it('constructs the REAL PlayIntegrityVerifier by default (flag=false)', async () => {
		jest.doMock('../proof-flags.generated', () => ({
			USE_LOCAL_DB_FACTORY: false,
			USE_STUB_ATTESTATION_VERIFIER: false,
		}));

		const { factory, rn } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');

		expect(engine).toBeInstanceOf(rn.AssociationEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;
		expect(injectedVerifier).toBeInstanceOf(rn.PlayIntegrityVerifier);
		expect(injectedVerifier).not.toBeInstanceOf(rn.StubAttestationVerifier);
		// Pinned roots + revoked serials are injected — never fetched at verify-time.
		expect(injectedVerifier.roots).toEqual([new Uint8Array([1, 2, 3])]);
		expect(injectedVerifier.revoked).toEqual(new Set(['deadbeef']));
		// CR-04/WR-03: the app-identity pin (package + cert-digest allowlist) is injected.
		expect(injectedVerifier.appIdentity).toEqual({
			packageName: 'org.votetorrent.authority',
			certificateSha256Digests: ['abc123'],
		});
	});

	it('constructs StubAttestationVerifier ONLY under the explicit __DEV__ dev gate (flag=true)', async () => {
		jest.doMock('../proof-flags.generated', () => ({
			USE_LOCAL_DB_FACTORY: false,
			USE_STUB_ATTESTATION_VERIFIER: true,
		}));

		const { factory, rn } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');

		expect(engine).toBeInstanceOf(rn.AssociationEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;
		expect(injectedVerifier).toBeInstanceOf(rn.StubAttestationVerifier);
	});
});
