/**
 * Phase 62 Plan 32 Task 1 (D-04, D-49): EngineFactory binds `ctx.intakeOpener` on the established
 * ctx over 62-21's officer key vault, proven on the REAL schema (real vote-engine dist, real
 * engines). `@votetorrent/vote-engine/rn` is deliberately NOT mocked.
 *
 * This file does NOT use `provisionTestIntakeRecipient`: that fixture sets `ctx.intakeOpener`
 * itself, which would hide whether the factory did.
 */

jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), {
	virtual: true,
});
jest.mock('@serfab/cadre-core', () => ({}), { virtual: true });
jest.mock('@optimystic/db-p2p-storage-rn', () => ({}), { virtual: true });
jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
}));

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	IntakeEngine,
	LocalStorageReact,
	RegistrationEngine,
	OFFICER_ENCRYPTION_KEY_POLICY,
	generateEncryptionKeyPair,
	officerEncryptionKeyAlias,
} from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	createTestNetwork,
	makeDistinctTestUser,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import { EngineFactory } from '../engine-factory';
import { createAuthorityKeyVault, setAuthorityKeyVaultForTests } from '../key-vault';
import { createFakeSecretWrapper } from '../__fixtures__/fake-secret-wrapper';

function newVault(): IKeyVault {
	const map = new Map<string, string>();
	return createAuthorityKeyVault({
		wrapper: createFakeSecretWrapper(),
		storage: {
			getItem: async (k) => map.get(k) ?? null,
			setItem: async (k, v) => {
				map.set(k, v);
			},
			removeItem: async (k) => {
				map.delete(k);
			},
		},
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function factoryOver(ctx: any): EngineFactory {
	const factory = new EngineFactory(new LocalStorageReact(), jest.fn());
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(factory as any).currentNetworkHash = 'hash-intake-opener';
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(factory as any).networksEngine = { getEstablishedContext: () => ctx };
	return factory;
}

function randomTestKeyPair() {
	const priv = secp256k1.utils.randomSecretKey();
	return { privateHex: bytesToHex(priv), publicHex: bytesToHex(secp256k1.getPublicKey(priv)) };
}

function randomMarker(): string {
	return `MARKER-D49-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function mintOutsider(vault: IKeyVault, userId: string): Promise<void> {
	const generated = generateEncryptionKeyPair();
	await vault.putSecret(officerEncryptionKeyAlias(userId), generated.secretKey, OFFICER_ENCRYPTION_KEY_POLICY);
}

describe('EngineFactory intakeOpener binding (D-04, D-49)', () => {
	let consoleSpies: jest.SpyInstance[] = [];

	beforeEach(() => {
		consoleSpies = [
			jest.spyOn(console, 'log').mockImplementation(() => {}),
			jest.spyOn(console, 'warn').mockImplementation(() => {}),
			jest.spyOn(console, 'error').mockImplementation(() => {}),
		];
	});

	afterEach(() => {
		setAuthorityKeyVaultForTests(undefined);
		jest.restoreAllMocks();
	});

	async function setup() {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		return { net, auth, ctx: net.ctx, authorityId: auth.authority.id };
	}

	async function submitMarkerRequest(registration: RegistrationEngine, authorityId: string, marker: string) {
		const requester = randomTestKeyPair();
		const priv = hexToBytes(requester.privateHex);
		const id = crypto.randomUUID();
		await registration.submitRegistrationRequest(
			{
				id,
				authorityId,
				payload: {
					registrant: { id: crypto.randomUUID(), authorityId, expiration: iso(Date.now() + 365 * 86_400_000) },
					public: { lastName: marker, firstName: 'Jane' },
					private: { expiration: iso(Date.now() + 365 * 86_400_000), details: [] },
				},
				submittedAt: iso(Date.now()),
			},
			requester.publicHex,
			async (digest: Uint8Array) => ({
				signature: bytesToHex(secp256k1.sign(digest, priv)),
				signerKey: requester.publicHex,
				signerUserId: '',
			}),
		);
		return id;
	}

	it('F1: binds an opener for the ctx user over exactly the resolved vault', async () => {
		const { ctx } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const spy = jest.spyOn(IntakeEngine.prototype, 'createOpener');
		expect(ctx.intakeOpener).toBeUndefined();

		await factoryOver(ctx).getEngine('registration');

		expect(ctx.intakeOpener).toBeDefined();
		expect(ctx.intakeOpener!.userId).toBe(ctx.user!.id);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]![0]).toBe(vault);
	});

	it('F2: recipient (key registered AFTER the bind) reads a sealed request as opened; raw column holds no marker', async () => {
		const { ctx, authorityId } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const factory = factoryOver(ctx);
		const registration = await factory.getEngine<RegistrationEngine>('registration');
		// Lazy key: the opener was bound before the officer enabled encrypted intake.
		await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, makeTestSignCallback(ctx.user!));

		const marker = randomMarker();
		const id = await submitMarkerRequest(registration, authorityId, marker);

		const raw = await ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id });
		expect(String(raw!.Payload)).not.toContain(marker);
		expect(String(raw!.Payload)).not.toContain('"lastName"');

		const read = await registration.getRegistrationRequest(id);
		expect(read!.payloadAccess).toBe('opened');
		expect(read!.payload.public?.lastName).toBe(marker);
	});

	it('F3: a non-recipient officer reads not-a-recipient with an empty payload and no marker anywhere', async () => {
		const { ctx, authorityId } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const registration = await factoryOver(ctx).getEngine<RegistrationEngine>('registration');
		await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, makeTestSignCallback(ctx.user!));
		const marker = randomMarker();
		const id = await submitMarkerRequest(registration, authorityId, marker);

		const outsider = makeDistinctTestUser();
		const outsiderVault = newVault();
		await mintOutsider(outsiderVault, outsider.id);
		setAuthorityKeyVaultForTests(outsiderVault);
		const outsiderCtx = { db: ctx.db, user: outsider };
		const outsiderEngine = await factoryOver(outsiderCtx).getEngine<RegistrationEngine>('registration');

		const read = await outsiderEngine.getRegistrationRequest(id);
		expect(read!.payloadAccess).toBe('not-a-recipient');
		expect(read!.payload).toEqual({});
		const list = await outsiderEngine.listRegistrationRequests({ authorityId });
		const row = list.rows.find((r) => r.requestId === id);
		expect(row!.lastName).toBeUndefined();
		expect(JSON.stringify(read)).not.toContain(marker);
		expect(JSON.stringify(list)).not.toContain(marker);
	});

	it('F4: a device with no officer key reads no-opener and shows no marker', async () => {
		const { ctx, authorityId } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const registration = await factoryOver(ctx).getEngine<RegistrationEngine>('registration');
		await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, makeTestSignCallback(ctx.user!));
		const marker = randomMarker();
		const id = await submitMarkerRequest(registration, authorityId, marker);

		setAuthorityKeyVaultForTests(newVault());
		const third = makeDistinctTestUser();
		const keylessEngine = await factoryOver({ db: ctx.db, user: third }).getEngine<RegistrationEngine>('registration');

		const read = await keylessEngine.getRegistrationRequest(id);
		expect(read!.payloadAccess).toBe('no-opener');
		expect(JSON.stringify(read)).not.toContain(marker);
	});

	it('F5: the sealed private tier opens for the recipient and is refused for an outsider', async () => {
		const { ctx, authorityId } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const registration = await factoryOver(ctx).getEngine<RegistrationEngine>('registration');
		await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, makeTestSignCallback(ctx.user!));
		const marker = randomMarker();
		const registrantId = crypto.randomUUID();
		await registration.register(
			{
				registrant: { id: registrantId, authorityId, expiration: iso(Date.now() + 365 * 86_400_000) },
				private: { expiration: iso(Date.now() + 365 * 86_400_000), details: [{ name: 'note', value: marker }] },
			},
			makeTestSignCallback(ctx.user!),
		);

		const own = await registration.getRegistrantPrivate(registrantId);
		expect(own!.detailsAccess).toBe('opened');
		expect(own!.privateDetails).toEqual([{ name: 'note', value: marker }]);

		const outsider = makeDistinctTestUser();
		const outsiderVault = newVault();
		await mintOutsider(outsiderVault, outsider.id);
		setAuthorityKeyVaultForTests(outsiderVault);
		const outsiderEngine = await factoryOver({ db: ctx.db, user: outsider }).getEngine<RegistrationEngine>('registration');
		const refused = await outsiderEngine.getRegistrantPrivate(registrantId);
		expect(refused!.detailsAccess).toBe('not-a-recipient');
		expect(refused!.privateDetails).toEqual([]);
		expect(JSON.stringify(refused)).not.toContain(marker);
	});

	it('F6: rebinds when ctx.user changes and clears when ctx.user is absent', async () => {
		const { ctx } = await setup();
		setAuthorityKeyVaultForTests(newVault());
		const factory = factoryOver(ctx);
		await factory.getEngine('registration');
		const first = ctx.intakeOpener;
		expect(first!.userId).toBe(ctx.user!.id);

		const other = makeDistinctTestUser();
		ctx.user = other;
		await factory.getEngine('signing');
		expect(ctx.intakeOpener).not.toBe(first);
		expect(ctx.intakeOpener!.userId).toBe(other.id);

		ctx.user = undefined;
		await factory.getEngine('elections');
		expect(ctx.intakeOpener).toBeUndefined();
	});

	it('F7: idempotent for the same user (same opener object, one createOpener call)', async () => {
		const { ctx } = await setup();
		setAuthorityKeyVaultForTests(newVault());
		const spy = jest.spyOn(IntakeEngine.prototype, 'createOpener');
		const factory = factoryOver(ctx);
		await factory.getEngine('signing');
		const first = ctx.intakeOpener;
		await factory.getEngine('elections');
		expect(ctx.intakeOpener).toBe(first);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('F8: a createOpener failure never blocks the engine, leaves no opener, reads no-opener, logs nothing', async () => {
		const { ctx, authorityId } = await setup();
		const vault = newVault();
		setAuthorityKeyVaultForTests(vault);
		const registration0 = await factoryOver(ctx).getEngine<RegistrationEngine>('registration');
		await new IntakeEngine(ctx).registerOfficerEncryptionKey(authorityId, vault, makeTestSignCallback(ctx.user!));
		const marker = randomMarker();
		const id = await submitMarkerRequest(registration0, authorityId, marker);

		ctx.intakeOpener = undefined;
		jest.spyOn(IntakeEngine.prototype, 'createOpener').mockImplementation(() => {
			throw new Error('SECRET-DETAIL-should-not-be-logged');
		});
		const engine = await factoryOver(ctx).getEngine<RegistrationEngine>('registration');

		expect(ctx.intakeOpener).toBeUndefined();
		const read = await engine.getRegistrationRequest(id);
		expect(read!.payloadAccess).toBe('no-opener');
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	});

	it('F9: no user means createOpener is never called and no opener is set', async () => {
		const { ctx } = await setup();
		setAuthorityKeyVaultForTests(newVault());
		const spy = jest.spyOn(IntakeEngine.prototype, 'createOpener');
		const bare = { db: ctx.db };
		await factoryOver(bare).getEngine('registration');
		expect(spy).not.toHaveBeenCalled();
		expect((bare as { intakeOpener?: unknown }).intakeOpener).toBeUndefined();
	});
});
