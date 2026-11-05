/**
 * voter-request-transports.test.ts — Phase 62 Plan 22 (D-28/D-29/D-32).
 *
 * Mounted integration proof on a REAL in-memory network (no mocked Quereus, no mocked
 * cadre-core): a test-local secp256k1 "officer" founds the network, the Voter's own
 * `getOrCreateDeviceUser`/`createDeviceSigner` (62-08) identity submits through
 * `createVoterRequestTransportSource`, and an officer-side `P2pRegistrationTransport` intakes
 * the staged row into `RegistrationEngine.submitRegistrationRequest` — proving DG-1 parity,
 * D-04/D-32 sealing, the zero-recipient refusal, D-28's P2P-default/P2P-only-association
 * routing, and D-29's REST-bridge route switch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToHex} from '@noble/curves/utils.js';
import type {
	AssociationAttestationAnswer,
	AssociationRequestInit,
	NetworkInit,
	RegisterInit,
	RegistrationRequestInit,
	Signature,
	User,
} from '@votetorrent/vote-core';
import {ElectionType, UserKeyType} from '@votetorrent/vote-core';
import {
	IntakeEngine,
	NetworksEngine,
	LocalStorageReact,
	P2pAssociationTransport,
	P2pRegistrationTransport,
	RegistrationEngine,
	envelopeRecipientUserIds,
} from '@votetorrent/vote-engine/rn';
import {getOrCreateDeviceUser} from '../device-user';
import {createDeviceSigner} from '../device-signer';
import {setDeviceKeyWrapProviderForTests} from '../device-key-wrap';
import {createInMemoryKeyWrapProviderForTests} from '../__fixtures__/in-memory-key-wrap-provider';
import {
	createAssociationAttestationDigestFn,
	createAssociationRequestDigestFn,
	createRegistrationRequestDigestFn,
	createVoterStrandPort,
} from '../strand-port-adapter';
import type {VoterStrandPort} from '../strand-port-adapter';
import {createVoterRequestTransportSource} from '../voter-request-transports';

// Test-only deep dist requires (never shipped to a Voter bundle):
//   - InMemoryTestKeyVault is never re-exported from any barrel (62-14 gate G-3).
//   - association-request-digest.ts is the independent reference this suite compares against —
//     importing it from the SAME barrel the production code uses would make the parity assertion
//     circular.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {InMemoryTestKeyVault} = require('../../../../../packages/vote-engine/dist/crypto/vault.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {computeAssociationRequestDigest, computeAssociationAttestationDigest} = require('../../../../../packages/vote-engine/dist/association/transport/association-request-digest.js');

/** Mirrors `vote-engine/src/utils.ts`'s `bytesToBase64url` — duplicated here (test-only) so the
 * parity assertions below never import the function under test's own encoding helper. */
function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const b64 = (globalThis as any).btoa(binary) as string;
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** A test-local secp256k1 officer — built the way `device-user.ts` builds one, with a sign
 * callback copying `device-signer.ts`'s signing body (prehash:true default, never overridden). */
function makeOfficer(): {user: User; sign: (digest: Uint8Array) => Promise<Signature>} {
	const privBytes = secp256k1.utils.randomSecretKey();
	const pubBytes = secp256k1.getPublicKey(privBytes, true);
	const pubHex = bytesToHex(pubBytes);
	const user: User = {
		id: `officer-${crypto.randomUUID()}`,
		name: 'Test Officer',
		activeKeys: [{key: pubHex, type: UserKeyType.mobile, expiration: Date.now() + TEN_YEARS_MS}],
	};
	const sign = async (digest: Uint8Array): Promise<Signature> => ({
		signerUserId: user.id,
		signerKey: pubHex,
		signature: bytesToHex(secp256k1.sign(digest, privBytes)),
	});
	return {user, sign};
}

const wrapProvider = createInMemoryKeyWrapProviderForTests();

describe('voter-request-transports (D-28/D-29/D-32) — mounted on a real in-memory network', () => {
	let officer: ReturnType<typeof makeOfficer>;
	let networksEngine: NetworksEngine;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let ctx: any;
	let strandId: string;
	let authorityId: string;
	let port: VoterStrandPort;
	let requesterUser: User;
	let requesterKey: string;
	let intakeEngine: InstanceType<typeof IntakeEngine>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let vault: any;

	beforeEach(async () => {
		await AsyncStorage.clear();
		setDeviceKeyWrapProviderForTests(wrapProvider);

		officer = makeOfficer();

		const networkInit: NetworkInit = {
			name: `Voter Request Transports Test Network ${crypto.randomUUID()}`,
			relays: [],
			primaryAuthority: {name: 'Voter Request Transports Test Authority', domainName: 'test.votetorrent.local'},
			admin: {
				officers: [{init: {name: officer.user.name, title: 'Registrar', scopes: ['mel', 'vrg']}}],
				effectiveAt: Date.now(),
				thresholdPolicies: [],
			},
			policies: {timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.adhoc},
		};

		networksEngine = new NetworksEngine(new LocalStorageReact());
		await networksEngine.create(networkInit, officer.user);
		const refs = await networksEngine.getRecentNetworks();
		const ref = refs.find(r => r.name === networkInit.name);
		if (!ref) throw new Error('test setup: network not found in recentNetworks immediately after create()');
		strandId = ref.hash;

		const established = networksEngine.getEstablishedContext(strandId);
		if (!established) throw new Error('test setup: no established context immediately after create()');
		ctx = established;

		const networkEngine = await networksEngine.open(ref, officer.user);
		const details = await networkEngine.getDetails();
		authorityId = details.network.primaryAuthorityId;

		port = createVoterStrandPort(ctx.db);
		intakeEngine = new IntakeEngine(ctx);
		vault = new InMemoryTestKeyVault();

		requesterUser = await getOrCreateDeviceUser('Device User');
		requesterKey = requesterUser.activeKeys[0]!.key;
	});

	afterEach(() => {
		setDeviceKeyWrapProviderForTests(undefined);
	});

	function makeRegistrationRequestInit(overrides?: {firstName?: string}): RegistrationRequestInit {
		const payload: RegisterInit = {
			registrant: {id: crypto.randomUUID(), authorityId, expiration: Date.now() + TEN_YEARS_MS},
			public: {firstName: overrides?.firstName ?? 'Test'},
			private: {expiration: Date.now() + TEN_YEARS_MS, details: [{name: 'email', value: 'voter@example.com'}]},
		};
		return {
			id: crypto.randomUUID(),
			authorityId,
			payload,
			submittedAt: new Date().toISOString(),
		};
	}

	// -------------------------------------------------------------------------
	// Port
	// -------------------------------------------------------------------------

	it('createVoterStrandPort: query() returns plain row objects, and close() is a no-op — the shared strand db stays open afterward', async () => {
		const rows = await port.query<{one: number}>('select 1 as one', {});
		expect(rows).toEqual([{one: 1}]);

		await port.close();

		// `mutate()` performing a real write is proven by the "sealed staging" test below (via
		// insertWithCursorRetry); this assertion is specifically that close() never touches db.
		const afterClose: Array<{one: number}> = [];
		for await (const row of ctx.db.eval('select 1 as one', {})) afterClose.push(row as {one: number});
		expect(afterClose).toEqual([{one: 1}]);
	});

	// -------------------------------------------------------------------------
	// Digest parity
	// -------------------------------------------------------------------------

	it('createRegistrationRequestDigestFn returns 32 bytes whose base64url equals the engine\'s own DG-1 Digest() tuple', async () => {
		const digestFn = createRegistrationRequestDigestFn(port);
		const init = makeRegistrationRequestInit();

		const bytes = await digestFn(init, requesterKey);
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(32);

		const payload = JSON.stringify(init.payload);
		const payloadCidRow = await ctx.db.prepare('select Digest(:payload) as d').get({payload});
		const expectedRow = await ctx.db
			.prepare(
				'select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d',
			)
			.get({
				id: init.id,
				rowAuthorityId: init.authorityId,
				requesterKey,
				issuerType: 'registrant',
				bridgeId: null,
				payloadCid: payloadCidRow!.d,
				submittedAt: init.submittedAt,
			});

		expect(base64UrlFromBytes(bytes)).toBe(expectedRow!.d);
	});

	it('createAssociationRequestDigestFn matches computeAssociationRequestDigest, including the no-electionId NULL position', async () => {
		const digestFn = createAssociationRequestDigestFn(port);
		const init: AssociationRequestInit = {
			id: crypto.randomUUID(),
			authorityId,
			registrantId: crypto.randomUUID(),
			deviceKey: requesterKey,
			submittedAt: new Date().toISOString(),
		};

		const bytes = await digestFn(init, requesterKey);
		expect(bytes.length).toBe(32);
		expect(base64UrlFromBytes(bytes)).toBe(computeAssociationRequestDigest(init, requesterKey));
	});

	it('createAssociationAttestationDigestFn matches computeAssociationAttestationDigest, including the no-deviceHash NULL position', async () => {
		const digestFn = createAssociationAttestationDigestFn(port);
		const answer = {
			requestId: crypto.randomUUID(),
			nonce: 'nonce-value',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			attestation: {publicKey: 'p', deviceId: 'd', attestationTime: 1, certificateChain: ['c']} as any,
		} as AssociationAttestationAnswer;

		const bytes = await digestFn(answer, requesterKey);
		expect(bytes.length).toBe(32);
		expect(base64UrlFromBytes(bytes)).toBe(computeAssociationAttestationDigest(answer));
	});

	// -------------------------------------------------------------------------
	// Route selection and D-32 sealing
	// -------------------------------------------------------------------------

	it('not peer-backed: resolve() resolves undefined before ever touching the port', async () => {
		const spyPort: VoterStrandPort = {
			query: jest.fn(),
			mutate: jest.fn(),
			close: jest.fn(),
		};
		const source = createVoterRequestTransportSource({strandId: 'unused', port: spyPort, peerBacked: false});

		const result = await source.resolve(authorityId);

		expect(result).toBeUndefined();
		expect(spyPort.query).not.toHaveBeenCalled();
		expect(spyPort.mutate).not.toHaveBeenCalled();
	});

	it('default route (no AuthorityIntakePolicy row): registrationRoute is "peer", both transports are the P2P classes', async () => {
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});

		const transports = await source.resolve(authorityId);

		expect(transports).toBeDefined();
		expect(transports!.registrationRoute).toBe('peer');
		expect(transports!.registrationTransport).toBeInstanceOf(P2pRegistrationTransport);
		expect(transports!.associationTransport).toBeInstanceOf(P2pAssociationTransport);
	});

	it('zero recipients (D-32/D-04): with no officer encryption key registered, submitRequest rejects \'no-recipients\' and stages zero rows', async () => {
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);
		const requesterSign = await createDeviceSigner('Device User');
		const init = makeRegistrationRequestInit();

		const beforeRow = await ctx.db
			.prepare('select count(*) as n from RegistrationRequestStaging where StrandId = :strandId')
			.get({strandId});

		await expect(
			transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign),
		).rejects.toMatchObject({code: 'no-recipients'});

		const afterRow = await ctx.db
			.prepare('select count(*) as n from RegistrationRequestStaging where StrandId = :strandId')
			.get({strandId});
		expect(Number(afterRow!.n)).toBe(Number(beforeRow!.n));
	});

	it('sealed staging (D-32/D-04): a submitted registration is sealed to exactly the current officer, with the unwrap proven by the 62-08 stub', async () => {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, officer.sign);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);

		const unwrapBefore = wrapProvider.unwrapCalls;
		const requesterSign = await createDeviceSigner('Device User');
		expect(wrapProvider.unwrapCalls).toBeGreaterThan(unwrapBefore);

		const marker = `MARKER-${crypto.randomUUID()}`;
		const init = makeRegistrationRequestInit({firstName: marker});

		await transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign);

		const rows = await ctx.db
			.prepare('select RequesterKey, InitJson from RegistrationRequestStaging where StrandId = :strandId and RequestId = :id')
			.get({strandId, id: init.id});
		expect(rows).toBeDefined();
		expect(rows!.RequesterKey).toBe(requesterKey);
		expect(envelopeRecipientUserIds(JSON.parse(rows!.InitJson as string))).toEqual([officer.user.id]);
		expect(String(rows!.InitJson)).not.toContain(marker);

		const countRow = await ctx.db
			.prepare('select count(*) as n from RegistrationRequestStaging where StrandId = :strandId')
			.get({strandId});
		expect(Number(countRow!.n)).toBe(1);
	});

	it('officer intake (DG-1 parity): the officer opens the staged row and submitRegistrationRequest accepts the Voter\'s single signature', async () => {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, officer.sign);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);
		const requesterSign = await createDeviceSigner('Device User');

		const init = makeRegistrationRequestInit();
		await transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign);

		const officerTransport = new P2pRegistrationTransport({
			openStrand: async () => port,
			computeDigest: createRegistrationRequestDigestFn(port),
			strandId,
			opener: intakeEngine.createOpener(vault),
		});
		const report = await officerTransport.readStagedRequestsReport();
		expect(report.unreadable).toEqual([]);
		expect(report.delivered).toHaveLength(1);
		const delivered = report.delivered[0]!;
		expect(delivered.init.id).toBe(init.id);

		const registrationEngine = new RegistrationEngine(ctx);
		const returnedId = await registrationEngine.submitRegistrationRequest(
			delivered.init,
			delivered.requesterKey,
			delivered.signature,
		);
		expect(returnedId).toBe(init.id);

		const row = await ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({id: init.id});
		expect(Number(row!.n)).toBe(1);
	});

	it('association leg: submitRequest stages one sealed row, and ownAssociationRequestIds is scoped by RequesterKey', async () => {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, officer.sign);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);
		const requesterSign = await createDeviceSigner('Device User');

		const init: AssociationRequestInit = {
			id: crypto.randomUUID(),
			authorityId,
			registrantId: crypto.randomUUID(),
			deviceKey: requesterKey,
			submittedAt: new Date().toISOString(),
		};
		const returnedId = await transports!.associationTransport.submitRequest(init, requesterKey, requesterSign);
		expect(returnedId).toBe(init.id);

		const mine = await transports!.ownAssociationRequestIds(requesterKey);
		expect(mine).toEqual([init.id]);

		const someoneElses = await transports!.ownAssociationRequestIds('some-other-requester-key');
		expect(someoneElses).toEqual([]);
	});

	it('own-staging read (Phase 62 Plan 28, D-45): ownStagedRegistrationRequestIds is scoped by RequesterKey, and empty for an unsubmitted/other key', async () => {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, officer.sign);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);
		const requesterSign = await createDeviceSigner('Device User');

		const init = makeRegistrationRequestInit();
		// Before any P2P submit, the member exists and returns [] for this key.
		expect(await transports!.ownStagedRegistrationRequestIds(requesterKey)).toEqual([]);

		await transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign);

		expect(await transports!.ownStagedRegistrationRequestIds(requesterKey)).toEqual([init.id]);
		expect(await transports!.ownStagedRegistrationRequestIds('other-key')).toEqual([]);
	});

	it('own-staging read (rest-bridge route): the member still exists and returns [] for this device\'s key before any P2P submit', async () => {
		await intakeEngine.setIntakePolicy(
			{authorityId, restBridgeUrl: 'https://bridge.example.org/intake'},
			officer.sign,
		);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);

		expect(transports!.registrationRoute).toBe('rest-bridge');
		expect(await transports!.ownStagedRegistrationRequestIds(requesterKey)).toEqual([]);
	});

	it('bridge route (D-29): after setIntakePolicy with an https bridge URL, registration routes to the bridge while association stays P2P (D-28)', async () => {
		await intakeEngine.setIntakePolicy(
			{authorityId, restBridgeUrl: 'https://bridge.example.org/intake'},
			officer.sign,
		);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});

		const transports = await source.resolve(authorityId);

		expect(transports).toBeDefined();
		expect(transports!.registrationRoute).toBe('rest-bridge');
		expect(transports!.registrationTransport).not.toBeInstanceOf(P2pRegistrationTransport);
		expect(transports!.associationTransport).toBeInstanceOf(P2pAssociationTransport);
	});

	it('idempotent re-submit: resubmitting the identical init with the same signer resolves to the same id and leaves one staging row', async () => {
		await intakeEngine.registerOfficerEncryptionKey(authorityId, vault, officer.sign);
		const source = createVoterRequestTransportSource({strandId, port, peerBacked: true});
		const transports = await source.resolve(authorityId);
		const requesterSign = await createDeviceSigner('Device User');

		const init = makeRegistrationRequestInit();
		const firstId = await transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign);
		const secondId = await transports!.registrationTransport.submitRequest(init, requesterKey, requesterSign);

		expect(firstId).toBe(secondId);

		const countRow = await ctx.db
			.prepare('select count(*) as n from RegistrationRequestStaging where StrandId = :strandId')
			.get({strandId});
		expect(Number(countRow!.n)).toBe(1);
	});
});
